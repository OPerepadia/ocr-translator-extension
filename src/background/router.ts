import type { OcrProvider } from "../providers/ocr/types";
import type { TranslationProvider } from "../providers/translation/types";
import { browserApi } from "../shared/browser";
import {
  isCancelRequest,
  isGetCaptureSnapshotRequest,
  isGetOcrSourceLanguagesRequest,
  isGetTargetLanguagesRequest,
  isGetTranslationProvidersRequest,
  isOcrTranslateRequest,
  isOpenOptionsRequest,
  isPreloadOcrRequest,
  isRerecognizeRequest,
  isRetranslateRequest,
  isSpeakRequest,
  isStartSelectionMessage,
  isSwitchProviderRequest,
  type CaptureSnapshotResponse,
  type OcrPipelineResponse,
  type OcrSourceLanguagesResponse,
  type RuntimeMessage,
  type SpeakResponse,
  type TranslationProvidersResponse,
} from "../shared/messages";
import { encodeSnapshot } from "../shared/image";
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
  loadImage(url: string): Promise<Blob>;
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
    const messageSender = sender as
      | { tab?: { id?: number }; frameId?: number }
      | undefined;
    const tabId = messageSender?.tab?.id;
    const frameKey =
      typeof tabId === "number"
        ? `${tabId}:${messageSender?.frameId ?? 0}`
        : undefined;

    if (isStartSelectionMessage(message)) {
      if (typeof tabId === "number") {
        return browserApi.tabs.sendMessage(tabId, message, { frameId: 0 });
      }
      return undefined;
    }
    if (isCancelRequest(message)) {
      inFlight.get(message.requestId)?.abort();
      return undefined;
    }
    if (isOcrTranslateRequest(message)) {
      return withKeepAlive(() =>
        withAbort(message.requestId, (signal) =>
          handleOcrTranslateRequest(
            dependencies,
            message,
            tabId,
            frameKey,
            signal,
          ),
        ),
      );
    }
    if (isPreloadOcrRequest(message)) {
      return withKeepAlive(() => handlePreloadOcrRequest(dependencies));
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
    if (isGetCaptureSnapshotRequest(message)) {
      return withKeepAlive(() => handleGetCaptureSnapshot(frameKey));
    }
    if (isSpeakRequest(message)) {
      return withKeepAlive(() => handleSpeakRequest(dependencies, message));
    }
    if (isRetranslateRequest(message)) {
      return withKeepAlive(() =>
        withAbort(message.requestId, (signal) =>
          handleRetranslateRequest(
            dependencies,
            message,
            tabId,
            frameKey,
            signal,
          ),
        ),
      );
    }
    if (isSwitchProviderRequest(message)) {
      return withKeepAlive(() =>
        withAbort(message.requestId, (signal) =>
          handleSwitchProviderRequest(
            dependencies,
            message,
            tabId,
            frameKey,
            signal,
          ),
        ),
      );
    }
    if (isRerecognizeRequest(message)) {
      return withKeepAlive(() =>
        withAbort(message.requestId, (signal) =>
          handleRerecognizeRequest(
            dependencies,
            message,
            tabId,
            frameKey,
            signal,
          ),
        ),
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

// Pipeline requests the content script can still cancel, by request id.
const inFlight = new Map<string, AbortController>();

async function withAbort<T>(
  requestId: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  inFlight.set(requestId, controller);
  try {
    return await run(controller.signal);
  } finally {
    // Only clear our own entry; a retry reusing the id owns the map by then.
    if (inFlight.get(requestId) === controller) {
      inFlight.delete(requestId);
    }
  }
}

// Kept for the display snapshot and for a source-language change made before the
// initial request has returned the image to the content script.
interface CaptureState {
  image?: Blob;
  /** CSS size of the region the capture covers, which sets the resolution its
   * display copy is encoded at. Absent for a context-menu image, whose rendered
   * size the content script keeps to itself. */
  displaySize?: { width: number; height: number };
  sourceLanguage: string;
}

const lastCaptures = new Map<string, CaptureState>();

async function handleOcrTranslateRequest(
  dependencies: RouterDependencies,
  message: Extract<RuntimeMessage, { type: "OCR_TRANSLATE_REQUEST" }>,
  tabId: number | undefined,
  frameKey: string | undefined,
  signal: AbortSignal,
): Promise<OcrPipelineResponse> {
  const capture: CaptureState | undefined = frameKey
    ? {
        sourceLanguage: "auto",
        displaySize:
          "rect" in message
            ? { width: message.rect.width, height: message.rect.height }
            : undefined,
      }
    : undefined;
  if (frameKey && capture) {
    lastCaptures.set(frameKey, capture);
  }

  const settings = await dependencies.settingsRepository.get();
  const ocrProvider = dependencies.createOcrProvider(settings.ocr);
  const translationProvider = dependencies.createTranslationProvider(
    settings.translation,
  );
  const image =
    "imageUrl" in message
      ? await dependencies.loadImage(message.imageUrl)
      : await dependencies.captureVisibleArea({
          rect: message.rect,
          viewport: message.viewport,
        });
  if (frameKey && capture && lastCaptures.get(frameKey) === capture) {
    capture.image = image;
  }

  signal.throwIfAborted();

  const result = await runPipeline({
    image,
    ocrProvider,
    translationProvider,
    sourceLang: "auto",
    targetLang: settings.translation.targetLang,
    detectLanguage: dependencies.detectLanguage,
    signal,
    onStatus: (status) =>
      sendPipelineStatus(tabId, message.requestId, status),
    onOcrResult: (ocr) =>
      sendPipelineOcrResult(tabId, message.requestId, ocr),
  });
  return { result, image };
}

// Hands the captured pixels to the overlay, which paints them under its boxes
// so they stay on the image the text was recognized from. The encoded copy is
// not kept: the overlay asks once per capture, so holding it would be megabytes
// nobody comes back for. Reports an absent snapshot rather than throwing — the
// overlay works without one, over whatever the page is showing now.
async function handleGetCaptureSnapshot(
  frameKey: string | undefined,
): Promise<CaptureSnapshotResponse> {
  const capture = frameKey ? lastCaptures.get(frameKey) : undefined;
  if (!capture?.image) {
    return {};
  }

  try {
    return {
      snapshot: await encodeSnapshot(capture.image, capture.displaySize),
    };
  } catch {
    return {};
  }
}

// Starts loading the OCR worker and model while the user is doing selection.
async function handlePreloadOcrRequest(
  dependencies: RouterDependencies,
): Promise<void> {
  try {
    const settings = await dependencies.settingsRepository.get();
    await dependencies.createOcrProvider(settings.ocr).preload?.();
  } catch {
    // Ignore; recognition re-runs initialization and surfaces any failure.
  }
}

// Re-runs OCR (and translation) on the last captured image for a different
// source language. The selection lasts only for the current capture.
async function handleRerecognizeRequest(
  dependencies: RouterDependencies,
  message: Extract<RuntimeMessage, { type: "RERECOGNIZE_REQUEST" }>,
  tabId: number | undefined,
  frameKey: string | undefined,
  signal: AbortSignal,
): Promise<OcrPipelineResponse> {
  const capture = frameKey ? lastCaptures.get(frameKey) : undefined;
  const selection = findOcrSourceLanguage(message.sourceLang);
  if (!selection) {
    throw new Error(`Unsupported OCR source language: ${message.sourceLang}`);
  }
  const image = message.image ?? capture?.image;
  if (!image) {
    throw new Error(
      "The captured image is no longer available. Please select the region again.",
    );
  }

  if (frameKey && capture && lastCaptures.get(frameKey) === capture) {
    capture.sourceLanguage = selection.id;
  } else if (frameKey && message.image && !capture) {
    lastCaptures.set(frameKey, {
      image,
      sourceLanguage: selection.id,
    });
  }

  const settings = await dependencies.settingsRepository.get();
  const ocr = {
    ...settings.ocr,
    sourceLang: selection.id,
  };
  const ocrProvider = dependencies.createOcrProvider(ocr);
  const translationProvider = dependencies.createTranslationProvider(
    settings.translation,
  );

  const result = await runPipeline({
    image,
    ocrProvider,
    translationProvider,
    sourceLang: selection.sourceLang,
    targetLang: settings.translation.targetLang,
    detectLanguage: dependencies.detectLanguage,
    signal,
    onStatus: (status) =>
      sendPipelineStatus(tabId, message.requestId, status),
    onOcrResult: (ocrResult) =>
      sendPipelineOcrResult(tabId, message.requestId, ocrResult),
  });
  return { result, image };
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
  frameKey: string | undefined,
  signal: AbortSignal,
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
    sourceLang: sourceLanguageForFrame(frameKey),
    targetLang: message.targetLang,
    detectLanguage: dependencies.detectLanguage,
    onStatus: (status) =>
      sendPipelineStatus(tabId, message.requestId, status),
    signal,
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
  frameKey: string | undefined,
  signal: AbortSignal,
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
    sourceLang: sourceLanguageForFrame(frameKey),
    targetLang: nextTranslation.targetLang,
    detectLanguage: dependencies.detectLanguage,
    onStatus: (status) =>
      sendPipelineStatus(tabId, message.requestId, status),
    signal,
  });

  return { ocr: { text: message.text }, translation, translationStatus };
}

function sourceLanguageForFrame(frameKey: string | undefined): string | "auto" {
  return resolveTranslationSourceLanguage(
    frameKey ? lastCaptures.get(frameKey)?.sourceLanguage : "auto",
  );
}
