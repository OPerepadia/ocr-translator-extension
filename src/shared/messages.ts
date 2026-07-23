import type {
  LangCode,
  PipelineOcrResult,
  PipelineResult,
  PipelineStatus,
  Rect,
  SerializedError,
  Viewport,
} from "./types";

export type OcrImageSource =
  | { rect: Rect; viewport: Viewport }
  | { imageUrl: string };

export type RuntimeMessage =
  | {
      type: "START_SELECTION";
    }
  | {
      type: "START_IMAGE_TRANSLATION";
      imageUrl: string;
    }
  | ({ type: "OCR_TRANSLATE_REQUEST"; requestId: string } & OcrImageSource)
  | {
      type: "OCR_TRANSLATE_RESULT";
      requestId: string;
      result: PipelineResult;
    }
  | {
      type: "OCR_TRANSLATE_ERROR";
      requestId: string;
      error: SerializedError;
    }
  // Background -> content tab: which pipeline step is running, so the loading
  // popup can show the current status (recognizing, translating, …).
  | {
      type: "OCR_TRANSLATE_STATUS";
      requestId: string;
      status: PipelineStatus;
    }
  // Background -> content tab: the OCR step has completed, while translation may
  // still be running. Lets the panel replace stale recognized text immediately.
  | {
      type: "OCR_TRANSLATE_OCR_RESULT";
      requestId: string;
      ocr: PipelineOcrResult;
    }
  // Content -> background: start loading the OCR worker and model while the user
  // is still doing the selection, so recognition can begin as soon as the
  // screenshot is ready. Fire-and-forget; failures surface on the real request.
  | {
      type: "PRELOAD_OCR";
    }
  // Content -> background: open the extension's options page. Content scripts
  // can't call runtime.openOptionsPage themselves, so the background does it.
  | {
      type: "OPEN_OPTIONS";
    }
  // Content -> background: list the languages the active translation provider
  // can translate into. The response resolves to an array of language codes.
  | {
      type: "GET_TARGET_LANGUAGES";
    }
  // Content -> background: list the source languages supported by the packaged
  // recognizers and which one is currently selected.
  | {
      type: "GET_OCR_SOURCE_LANGUAGES";
    }
  // Content -> background: list the available translation providers and which one
  // is currently selected. The response resolves to a TranslationProvidersResponse.
  | {
      type: "GET_TRANSLATION_PROVIDERS";
    }
  // Content -> background: fetch Google TTS audio for the selected text.
  | {
      type: "SPEAK_REQUEST";
      text: string;
      lang: LangCode;
    }
  // Content -> background: re-translate already-recognized text into a new
  // target language (after the user changes it in the popup). Persists the new
  // target as the default. The response resolves to a PipelineResult.
  | {
      type: "RETRANSLATE_REQUEST";
      requestId: string;
      text: string;
      targetLang: LangCode;
    }
  // Content -> background: re-run OCR on the last captured image for a different
  // source language, then translate. The background chooses the recognizer and
  // keeps the language only for the current capture.
  | {
      type: "RERECOGNIZE_REQUEST";
      requestId: string;
      sourceLang: LangCode | "auto";
    }
  // Content -> background: switch the active translation provider (picked in the
  // panel) and re-translate already-recognized text with it. Persists the
  // provider as the new default. The response resolves to a PipelineResult.
  | {
      type: "SWITCH_PROVIDER_REQUEST";
      requestId: string;
      providerId: string;
      text: string;
    };

export interface OcrSourceLanguagesResponse {
  languages: Array<{ id: string; label: string }>;
  currentId: string;
}

export interface TranslationProvidersResponse {
  providers: Array<{ id: string; label: string }>;
  currentId: string;
}

export interface SpeakResponse {
  audioChunks: string[];
}

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybeMessage = value as { type?: unknown };
  return typeof maybeMessage.type === "string";
}

export function isStartSelectionMessage(
  value: unknown,
): value is Extract<RuntimeMessage, { type: "START_SELECTION" }> {
  return isRuntimeMessage(value) && value.type === "START_SELECTION";
}

export function isStartImageTranslationMessage(
  value: unknown,
): value is Extract<RuntimeMessage, { type: "START_IMAGE_TRANSLATION" }> {
  return isRuntimeMessage(value) && value.type === "START_IMAGE_TRANSLATION";
}

export function isOcrTranslateRequest(
  value: unknown,
): value is Extract<RuntimeMessage, { type: "OCR_TRANSLATE_REQUEST" }> {
  return isRuntimeMessage(value) && value.type === "OCR_TRANSLATE_REQUEST";
}

export function isOcrTranslateStatus(
  value: unknown,
): value is Extract<RuntimeMessage, { type: "OCR_TRANSLATE_STATUS" }> {
  return isRuntimeMessage(value) && value.type === "OCR_TRANSLATE_STATUS";
}

export function isOcrTranslateOcrResult(
  value: unknown,
): value is Extract<RuntimeMessage, { type: "OCR_TRANSLATE_OCR_RESULT" }> {
  return isRuntimeMessage(value) && value.type === "OCR_TRANSLATE_OCR_RESULT";
}

export function isPreloadOcrRequest(
  value: unknown,
): value is Extract<RuntimeMessage, { type: "PRELOAD_OCR" }> {
  return isRuntimeMessage(value) && value.type === "PRELOAD_OCR";
}

export function isOpenOptionsRequest(
  value: unknown,
): value is Extract<RuntimeMessage, { type: "OPEN_OPTIONS" }> {
  return isRuntimeMessage(value) && value.type === "OPEN_OPTIONS";
}

export function isGetTargetLanguagesRequest(
  value: unknown,
): value is Extract<RuntimeMessage, { type: "GET_TARGET_LANGUAGES" }> {
  return isRuntimeMessage(value) && value.type === "GET_TARGET_LANGUAGES";
}

export function isGetOcrSourceLanguagesRequest(
  value: unknown,
): value is Extract<RuntimeMessage, { type: "GET_OCR_SOURCE_LANGUAGES" }> {
  return isRuntimeMessage(value) && value.type === "GET_OCR_SOURCE_LANGUAGES";
}

export function isGetTranslationProvidersRequest(
  value: unknown,
): value is Extract<RuntimeMessage, { type: "GET_TRANSLATION_PROVIDERS" }> {
  return isRuntimeMessage(value) && value.type === "GET_TRANSLATION_PROVIDERS";
}

export function isSwitchProviderRequest(
  value: unknown,
): value is Extract<RuntimeMessage, { type: "SWITCH_PROVIDER_REQUEST" }> {
  return isRuntimeMessage(value) && value.type === "SWITCH_PROVIDER_REQUEST";
}

export function isSpeakRequest(
  value: unknown,
): value is Extract<RuntimeMessage, { type: "SPEAK_REQUEST" }> {
  return isRuntimeMessage(value) && value.type === "SPEAK_REQUEST";
}

export function isRetranslateRequest(
  value: unknown,
): value is Extract<RuntimeMessage, { type: "RETRANSLATE_REQUEST" }> {
  return isRuntimeMessage(value) && value.type === "RETRANSLATE_REQUEST";
}

export function isRerecognizeRequest(
  value: unknown,
): value is Extract<RuntimeMessage, { type: "RERECOGNIZE_REQUEST" }> {
  return isRuntimeMessage(value) && value.type === "RERECOGNIZE_REQUEST";
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}
