import type { OcrProvider } from "../providers/ocr/types";
import type { TranslationProvider } from "../providers/translation/types";
import { browserApi } from "../shared/browser";
import {
  isGetOcrSourceLanguagesRequest,
  isGetTargetLanguagesRequest,
  isGetTranslationProvidersRequest,
  isOcrTranslateRequest,
  isOpenOptionsRequest,
  isRerecognizeRequest,
  isRetranslateRequest,
  isSpeakRequest,
  isSwitchProviderRequest,
  type OcrSourceLanguagesResponse,
  type SpeakResponse,
  type TranslationProvidersResponse,
} from "../shared/messages";
import {
  findOcrSourceLanguage,
  COMMON_OCR_SOURCE_LANGUAGES,
  resolveTranslationSourceLanguage,
  TRANSLATION_PROVIDERS,
} from "../providers/catalog";
import type { SettingsRepository } from "../shared/storage";
import type {
  LangCode,
  PipelineOcrResult,
  PipelineResult,
  PipelineStatus,
  Rect,
  Settings,
  Viewport,
} from "../shared/types";
import { createKeepAlive } from "./keepalive";
import { runPipeline, translateText } from "./pipeline";

export interface RouterDependencies {
  settingsRepository: SettingsRepository;
  captureVisibleArea(args: { rect: Rect; viewport: Viewport }): Promise<Blob>;
  createOcrProvider(settings: Settings["ocr"]): OcrProvider;
  createTranslationProvider(
    settings: Settings["translation"],
  ): TranslationProvider;
  /** Detect the source language of text (browser.i18n.detectLanguage). */
  detectLanguage(text: string): Promise<LangCode | undefined>;
  speakText(text: string, lang: LangCode): Promise<string[]>;
}

export function startRouter(dependencies: RouterDependencies): void {
  browserApi.runtime.onMessage.addListener((message, sender) => {
    if (isOcrTranslateRequest(message)) {
      const tabId = (sender as { tab?: { id?: number } } | undefined)?.tab?.id;
      return withKeepAlive(() =>
        handleOcrTranslateRequest(dependencies, message, tabId),
      );
    }
    if (isOpenOptionsRequest(message)) {
      void browserApi.runtime.openOptionsPage();
      return undefined;
    }
    if (isGetTargetLanguagesRequest(message)) {
      return handleGetTargetLanguages(dependencies);
    }
    if (isGetOcrSourceLanguagesRequest(message)) {
      return handleGetOcrSourceLanguages();
    }
    if (isGetTranslationProvidersRequest(message)) {
      return handleGetTranslationProviders(dependencies);
    }
    if (isSpeakRequest(message)) {
      return withKeepAlive(() => handleSpeakRequest(dependencies, message));
    }
    if (isRetranslateRequest(message)) {
      const tabId = (sender as { tab?: { id?: number } } | undefined)?.tab?.id;
      return withKeepAlive(() =>
        handleRetranslateRequest(dependencies, message, tabId),
      );
    }
    if (isSwitchProviderRequest(message)) {
      const tabId = (sender as { tab?: { id?: number } } | undefined)?.tab?.id;
      return withKeepAlive(() =>
        handleSwitchProviderRequest(dependencies, message, tabId),
      );
    }
    if (isRerecognizeRequest(message)) {
      const tabId = (sender as { tab?: { id?: number } } | undefined)?.tab?.id;
      return withKeepAlive(() =>
        handleRerecognizeRequest(dependencies, message, tabId),
      );
    }
    return undefined;
  });
}

async function handleSpeakRequest(
  dependencies: RouterDependencies,
  message: { text: string; lang: LangCode },
): Promise<SpeakResponse> {
  return {
    audioChunks: await dependencies.speakText(message.text, message.lang),
  };
}

// Firefox unloads the non-persistent event page after a short idle period
// (~30s in practice; see Bugzilla 1851373), which kills in-flight OCR and
// translation. Calling a cheap extension API every 20s resets the idle timer
// while any long-running background request is active.
const KEEPALIVE_INTERVAL_MS = 20_000;
const withKeepAlive = createKeepAlive(
  () => browserApi.runtime.getPlatformInfo(),
  KEEPALIVE_INTERVAL_MS,
);

// The most recent captured image per tab, kept so a recognizer switch can re-run
// OCR on the same pixels instead of recapturing (which could differ if the page
// scrolled, resized, or its content changed). Lost if the event page unloads, in
// which case re-recognition asks the user for a fresh selection.
const lastCaptures = new Map<number, Blob>();
const lastSourceLanguages = new Map<number, string>();

async function handleOcrTranslateRequest(
  dependencies: RouterDependencies,
  message: {
    requestId: string;
    rect: Rect;
    viewport: Viewport;
  },
  tabId: number | undefined,
): Promise<PipelineResult> {
  const settings = await dependencies.settingsRepository.get();
  const ocrProvider = dependencies.createOcrProvider(settings.ocr);
  const translationProvider = dependencies.createTranslationProvider(
    settings.translation,
  );
  const image = await dependencies.captureVisibleArea({
    rect: message.rect,
    viewport: message.viewport,
  });
  if (tabId !== undefined) {
    lastCaptures.set(tabId, image);
    lastSourceLanguages.set(tabId, "auto");
  }

  return runPipeline({
    image,
    ocrProvider,
    translationProvider,
    sourceLang: "auto",
    targetLang: settings.translation.targetLang,
    detectLanguage: dependencies.detectLanguage,
    onStatus: (status) =>
      sendPipelineStatus(tabId, message.requestId, status),
    onOcrResult: (ocr) =>
      sendPipelineOcrResult(tabId, message.requestId, ocr),
  });
}

// Re-runs OCR (and translation) on the last captured image for a different
// source language. The selection lasts only for the current capture.
async function handleRerecognizeRequest(
  dependencies: RouterDependencies,
  message: {
    requestId: string;
    sourceLang: LangCode | "auto";
  },
  tabId: number | undefined,
): Promise<PipelineResult> {
  const settings = await dependencies.settingsRepository.get();
  const selection = findOcrSourceLanguage(message.sourceLang);
  if (!selection) {
    throw new Error(`Unsupported OCR source language: ${message.sourceLang}`);
  }
  const ocr = {
    ...settings.ocr,
    sourceLang: selection.id,
  };
  const image = tabId === undefined ? undefined : lastCaptures.get(tabId);

  if (!image) {
    throw new Error(
      "The captured image is no longer available. Please select the region again.",
    );
  }

  if (tabId !== undefined) {
    lastSourceLanguages.set(tabId, selection.id);
  }

  const ocrProvider = dependencies.createOcrProvider(ocr);
  const translationProvider = dependencies.createTranslationProvider(
    settings.translation,
  );

  return runPipeline({
    image,
    ocrProvider,
    translationProvider,
    sourceLang: selection.sourceLang,
    targetLang: settings.translation.targetLang,
    detectLanguage: dependencies.detectLanguage,
    onStatus: (status) =>
      sendPipelineStatus(tabId, message.requestId, status),
    onOcrResult: (ocrResult) =>
      sendPipelineOcrResult(tabId, message.requestId, ocrResult),
  });
}

function sendPipelineStatus(
  tabId: number | undefined,
  requestId: string,
  status: PipelineStatus,
): void {
  if (tabId === undefined) {
    return;
  }
  // Fire-and-forget status to the originating tab; ignore if it closed.
  void browserApi.tabs
    .sendMessage(tabId, {
      type: "OCR_TRANSLATE_STATUS",
      requestId,
      status,
    })
    .catch(() => {});
}

async function sendPipelineOcrResult(
  tabId: number | undefined,
  requestId: string,
  ocr: PipelineOcrResult,
): Promise<void> {
  if (tabId === undefined) {
    return;
  }
  await browserApi.tabs
    .sendMessage(tabId, {
      type: "OCR_TRANSLATE_OCR_RESULT",
      requestId,
      ocr,
    })
    .catch(() => {});
}

// Reports the languages the active translation provider can translate into.
async function handleGetTargetLanguages(
  dependencies: RouterDependencies,
): Promise<LangCode[]> {
  const settings = await dependencies.settingsRepository.get();
  const translationProvider = dependencies.createTranslationProvider(
    settings.translation,
  );
  return translationProvider.listTargetLanguages?.() ?? [];
}

// Reports the source languages supported by the packaged recognizers.
async function handleGetOcrSourceLanguages(): Promise<OcrSourceLanguagesResponse> {
  const languages = COMMON_OCR_SOURCE_LANGUAGES.map(({ id, label }) => ({
    id,
    label,
  }));
  const [auto, ...supported] = languages;
  return {
    languages: [
      auto,
      ...supported.sort((a, b) => a.label.localeCompare(b.label)),
    ],
    currentId: "auto",
  };
}

// Reports the translation providers the user can choose from and which is active.
async function handleGetTranslationProviders(
  dependencies: RouterDependencies,
): Promise<TranslationProvidersResponse> {
  const settings = await dependencies.settingsRepository.get();
  return {
    providers: TRANSLATION_PROVIDERS.map((provider) => ({
      id: provider.id,
      label: provider.label,
    })),
    currentId: settings.translation.providerId,
  };
}

// Re-translates already-recognized text into a new target language and saves
// that target as the new default, so the next capture uses it too.
async function handleRetranslateRequest(
  dependencies: RouterDependencies,
  message: {
    requestId: string;
    text: string;
    targetLang: LangCode;
  },
  tabId: number | undefined,
): Promise<PipelineResult> {
  const settings = await dependencies.settingsRepository.get();
  const nextTranslation = {
    ...settings.translation,
    targetLang: message.targetLang,
  };
  await dependencies.settingsRepository.set({
    ...settings,
    translation: nextTranslation,
  });

  const translationProvider =
    dependencies.createTranslationProvider(nextTranslation);
  const { translation, translationStatus } = await translateText({
    text: message.text,
    translationProvider,
    sourceLang: sourceLanguageForTab(tabId),
    targetLang: message.targetLang,
    detectLanguage: dependencies.detectLanguage,
    onStatus: (status) =>
      sendPipelineStatus(tabId, message.requestId, status),
  });

  // The recognized text is unchanged, so echo it back; only the translation is
  // recomputed.
  return { ocr: { text: message.text }, translation, translationStatus };
}

// Switches the active translation provider (picked in the panel), saves it as the
// new default, and re-translates the already-recognized text with it. The target
// language is kept; if the new provider can't handle the pair, translateText
// reports it via translationStatus so the UI can prompt the next step.
async function handleSwitchProviderRequest(
  dependencies: RouterDependencies,
  message: {
    requestId: string;
    providerId: string;
    text: string;
  },
  tabId: number | undefined,
): Promise<PipelineResult> {
  const settings = await dependencies.settingsRepository.get();
  const nextTranslation = {
    ...settings.translation,
    providerId: message.providerId,
  };
  if (message.providerId !== settings.translation.providerId) {
    await dependencies.settingsRepository.set({
      ...settings,
      translation: nextTranslation,
    });
  }

  const translationProvider =
    dependencies.createTranslationProvider(nextTranslation);
  const { translation, translationStatus } = await translateText({
    text: message.text,
    translationProvider,
    sourceLang: sourceLanguageForTab(tabId),
    targetLang: nextTranslation.targetLang,
    detectLanguage: dependencies.detectLanguage,
    onStatus: (status) =>
      sendPipelineStatus(tabId, message.requestId, status),
  });

  return { ocr: { text: message.text }, translation, translationStatus };
}

function sourceLanguageForTab(tabId: number | undefined): string | "auto" {
  return resolveTranslationSourceLanguage(
    tabId === undefined ? "auto" : lastSourceLanguages.get(tabId),
  );
}
