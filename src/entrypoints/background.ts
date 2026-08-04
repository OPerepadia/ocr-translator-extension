import { captureVisibleArea, loadImage } from "@/background/capture";
import { createCaptureStore } from "@/background/capture-store";
import { startContextMenu } from "@/background/context-menu";
import { startRouter } from "@/background/router";
import {
  OCR_MODELS,
  resolveOcrModel,
  resolveOcrModelIdForSourceLanguage,
  resolveOcrSourceLanguage,
} from "@/providers/catalog";
import { ocrRegistry } from "@/providers/ocr/registry";
import type { OcrProvider } from "@/providers/ocr/types";
import { translationRegistry } from "@/providers/translation/registry";
import type { TranslationProvider } from "@/providers/translation/types";
import { speakText } from "@/providers/tts/google";
import { browserApi } from "@/shared/browser";
import { normalizeDetectedLanguage } from "@/shared/language";
import { createSettingsRepository } from "@/shared/storage";
import type { Settings } from "@/shared/types";
import { detectAll as detectAllTinyLanguages } from "tinyld";

const DEBUG_LANGUAGE_DETECTION = false;

export default defineBackground(() => {
  // Firefox runs an MV3 background as an event page. Listeners must be
  // registered synchronously here, before any await, so the first event after
  // the page wakes up is not missed.
  const settingsRepository = createSettingsRepository();

  startContextMenu();
  startRouter({
    settingsRepository,
    captureStore: createCaptureStore(),
    captureVisibleArea,
    loadImage,
    createOcrProvider,
    createTranslationProvider,
    detectLanguage,
    speakText,
  });
});

// Cache the OCR provider so its worker and loaded models survive across
// requests instead of reloading (and leaking a worker) on every selection.
let cachedOcrProvider: { key: string; provider: OcrProvider } | null = null;

function createOcrProvider(settings: Settings["ocr"]): OcrProvider {
  const key = ocrProviderCacheKey(settings);
  if (cachedOcrProvider?.key === key) {
    return cachedOcrProvider.provider;
  }

  void cachedOcrProvider?.provider
    .dispose?.()
    ?.catch((error) => console.error("OCR provider dispose failed", error));

  // Resolve asset URLs here, in the composition root, so providers stay free of
  // any browser-API dependency.
  const model = ocrModel(settings);
  const config = {
    ...settings,
    model,
    autoModels: isAutoOcr(settings) ? OCR_MODELS : undefined,
    resolveUrl: (path: string) => browserApi.runtime.getURL(path),
  };
  const provider =
    ocrRegistry[settings.providerId as keyof typeof ocrRegistry]?.(config) ??
    ocrRegistry.paddle(config);
  cachedOcrProvider = { key, provider };
  return provider;
}

// Fields a provider reads at construction; sourceLang is a per-request input.
function ocrProviderCacheKey(settings: Settings["ocr"]): string {
  const extra = settings as Record<string, unknown>;
  return JSON.stringify({
    providerId: settings.providerId,
    backend: extra.backend,
    modelDir: ocrModel(settings).modelDir,
    auto: isAutoOcr(settings),
    debug: extra.debug,
  });
}

function ocrModel(settings: Settings["ocr"]) {
  return resolveOcrModel(
    resolveOcrModelIdForSourceLanguage(settings.sourceLang),
  );
}

function isAutoOcr(settings: Settings["ocr"]): boolean {
  return resolveOcrSourceLanguage(settings.sourceLang).id === "auto";
}

// Cache the translation provider so repeated requests reuse its configuration.
let cachedTranslationProvider: {
  key: string;
  provider: TranslationProvider;
} | null = null;

function createTranslationProvider(
  settings: Settings["translation"],
): TranslationProvider {
  const key = translationProviderCacheKey(settings);
  if (cachedTranslationProvider?.key === key) {
    return cachedTranslationProvider.provider;
  }

  const config = { ...settings };
  const provider =
    translationRegistry[
      settings.providerId as keyof typeof translationRegistry
    ]?.(config) ?? translationRegistry.google(config);
  cachedTranslationProvider = { key, provider };
  return provider;
}

// Fields a provider reads at construction; targetLang is a per-request input.
// The llm endpoint settings are included so editing them in options replaces
// the cached provider instead of serving one built with the old values.
function translationProviderCacheKey(
  settings: Settings["translation"],
): string {
  return JSON.stringify({
    providerId: settings.providerId,
    llm: settings.llm,
  });
}

// Detect a source language from OCR text.
// First use Firefox's built-in detector. Trust it only when it marks the result reliable.
// If it returns nothing or an unreliable guess, try tinyld. Both results are normalized to
// the app's canonical language codes.
async function detectLanguage(text: string): Promise<string | undefined> {
  try {
    if (DEBUG_LANGUAGE_DETECTION) {
      console.debug("[Screen OCR Translator] i18n detectLanguage input", {
        length: text.length,
        text,
      });
    }
    const result = await browserApi.i18n.detectLanguage(text);
    const top = result.languages?.[0]?.language ?? "";
    const normalized = normalizeDetectedLanguage(top);
    if (DEBUG_LANGUAGE_DETECTION) {
      console.debug("[Screen OCR Translator] i18n detectLanguage result", {
        raw: result,
        top,
        normalized,
      });
    }
    if (normalized && result.isReliable) {
      return normalized;
    }

    const tinyldResults = detectAllTinyLanguages(text);
    const tinyldTop = tinyldResults[0]?.lang ?? "";
    const tinyldNormalized = normalizeDetectedLanguage(tinyldTop);
    if (DEBUG_LANGUAGE_DETECTION) {
      console.debug("[Screen OCR Translator] tinyld detectLanguage result", {
        raw: tinyldResults,
        top: tinyldTop,
        normalized: tinyldNormalized,
      });
    }
    return tinyldNormalized ?? normalized;
  } catch (error) {
    console.error("[Screen OCR Translator] Language detection failed", error);
    return undefined;
  }
}
