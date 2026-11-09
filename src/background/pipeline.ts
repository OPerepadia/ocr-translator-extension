import type { OcrProvider } from "../providers/ocr/types";
import {
  RemoteTranslationError,
  type TranslationProvider,
} from "../providers/translation/types";
import type {
  LangCode,
  PipelineOcrResult,
  PipelineResult,
  PipelineStatus,
  PipelineTranslationResult,
  TranslationContextLine,
  TranslationStatus,
} from "../shared/types";

export async function runPipeline(args: {
  image: Blob;
  ocrProvider: OcrProvider;
  translationProvider: TranslationProvider;
  sourceLang?: LangCode | "auto";
  targetLang: LangCode;
  /** Detect the source language from text when it is "auto"/unknown. Injected
   * (browser.i18n.detectLanguage) so the pipeline stays browser-API free. */
  detectLanguage?: (text: string) => Promise<LangCode | undefined>;
  /** Report the current step so the UI can show a live status. */
  onStatus?: (status: PipelineStatus) => void;
  /** Report the recognized text and resolved language before translation. */
  onOcrResult?: (ocr: PipelineOcrResult) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<PipelineResult> {
  // The OCR provider drives the recognizing-phase status (initializing, then
  // per-line progress); OcrStatus is a subset of PipelineStatus, so it forwards
  // as-is.
  const recognized = await args.ocrProvider.recognize(
    {
      image: args.image,
      sourceLang: args.sourceLang,
    },
    args.signal,
    args.onStatus,
  );
  const requestedLang = recognized.lang ?? args.sourceLang;
  const detectedLang =
    (!requestedLang || requestedLang === "auto") && args.detectLanguage
      ? await args.detectLanguage(recognized.text)
      : undefined;
  const sourceLang = detectedLang ?? requestedLang;
  const ocr =
    !recognized.lang && sourceLang && sourceLang !== "auto"
      ? { ...recognized, lang: sourceLang }
      : recognized;
  await args.onOcrResult?.(ocr);

  const { translation, translationStatus } = await translateText({
    text: ocr.text,
    translationProvider: args.translationProvider,
    sourceLang: requestedLang,
    detectedSourceLang: detectedLang,
    targetLang: args.targetLang,
    onStatus: args.onStatus,
    signal: args.signal,
  });

  return { ocr, translation, translationStatus };
}

/**
 * Translate already-recognized text. Shared by the full pipeline and the
 * re-translate flow (when the user changes the target language without
 * re-capturing). Resolves the source language (detecting it when "auto"), and
 * reports retryable remote failures via TranslationStatus.
 */
export async function translateText(args: {
  text: string;
  translationProvider: TranslationProvider;
  sourceLang?: LangCode | "auto";
  /** A language already detected for "auto", so it isn't detected twice. */
  detectedSourceLang?: LangCode;
  targetLang: LangCode;
  /** Lines that came just before `text`, for providers that can use them. */
  context?: TranslationContextLine[];
  detectLanguage?: (text: string) => Promise<LangCode | undefined>;
  onStatus?: (status: PipelineStatus) => void;
  signal?: AbortSignal;
}): Promise<{
  translation?: PipelineTranslationResult;
  translationStatus: TranslationStatus;
}> {
  // Resolve the source language for the language badge and same-language check.
  const auto = !args.sourceLang || args.sourceLang === "auto";
  let sourceLang = auto ? args.detectedSourceLang : args.sourceLang;
  if (auto && !sourceLang && args.detectLanguage) {
    sourceLang = await args.detectLanguage(args.text);
  }

  // Nothing to translate when the text is already in the target language.
  if (sourceLang && sourceLang === args.targetLang) {
    return {
      translationStatus: {
        state: "same_language",
        sourceLang,
        targetLang: sourceLang,
      },
    };
  }

  try {
    args.onStatus?.({ stage: "translating" });
    const translation = await args.translationProvider.translate(
      {
        text: args.text,
        // Keep "auto" rather than sending the local guess. The guess is often
        // wrong on short text, and a wrong source makes Google return the text
        // untranslated. Providers detect the language themselves.
        sourceLang: auto ? args.sourceLang : sourceLang,
        targetLang: args.targetLang,
        context: args.context,
      },
      args.signal,
    );

    return {
      translation:
        auto && sourceLang && !translation.sourceLang
          ? { ...translation, sourceLang }
          : translation,
      translationStatus: { state: "ok" },
    };
  } catch (error) {
    const status = translationStatusForError(error, args.targetLang);
    if (!status) {
      throw error;
    }
    // Surface the resolved source language so the recognized-text badge still
    // shows it even though translation produced no output.
    if (sourceLang) {
      status.sourceLang = sourceLang;
    }
    return { translationStatus: status };
  }
}

function translationStatusForError(
  error: unknown,
  targetLang: LangCode,
): TranslationStatus | null {
  // A remote provider's request failed (network/HTTP). Report it as a status so
  // the recognized text survives and the UI can offer a retry, rather than
  // throwing and discarding the whole result.
  if (error instanceof RemoteTranslationError) {
    return { state: "failed", reason: error.message, targetLang };
  }
  return null;
}
