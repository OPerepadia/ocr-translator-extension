import type { OcrProvider } from "../providers/ocr/types";
import type { TranslationProvider } from "../providers/translation/types";
import { browserApi } from "../shared/browser";
import {
  isCancelRequest,
  isEndImagePickerMessage,
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
  type OcrSourceLanguagesResponse,
  type RuntimeMessage,
  type SpeakResponse,
  type TranslationProvidersResponse,
} from "../shared/messages";
import { encodeSnapshot } from "../shared/image";
import { t } from "../shared/i18n";
import { onRequest } from "../shared/runtime-messaging";
import {
  findOcrSourceLanguage,
  COMMON_OCR_SOURCE_LANGUAGES,
  resolveOcrSourceLanguage,
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
import type {
  CaptureDraft,
  CaptureRecord,
  CaptureStore,
} from "./capture-store";
import { createKeepAlive } from "./keepalive";
import { runPipeline, translateText } from "./pipeline";

export interface RouterDependencies {
  settingsRepository: SettingsRepository;
  /** Screenshots retained past the request that took them. */
  captureStore: CaptureStore;
  captureVisibleArea(args: { rect: Rect; viewport: Viewport }): Promise<Blob>;
  loadImage(url: string, pageUrl?: string): Promise<Blob>;
  createOcrProvider(settings: Settings["ocr"]): OcrProvider;
  createTranslationProvider(
    settings: Settings["translation"],
  ): TranslationProvider;
  /** Detect the source language of text (browser.i18n.detectLanguage). */
  detectLanguage(text: string): Promise<LangCode | undefined>;
  speakText(text: string, lang: LangCode): Promise<string[]>;
}

export function startRouter(dependencies: RouterDependencies): void {
  onRequest((message, sender) => {
    const messageSender = sender as
      | { tab?: { id?: number }; frameId?: number; url?: string }
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
    if (isEndImagePickerMessage(message)) {
      if (typeof tabId === "number") {
        return browserApi.tabs.sendMessage(tabId, {
          type: "CANCEL_IMAGE_PICKER",
          sessionId: message.sessionId,
        });
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
            messageSender?.url,
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
      return handleGetOcrSourceLanguages(dependencies);
    }
    if (isGetTranslationProvidersRequest(message)) {
      return handleGetTranslationProviders(dependencies);
    }
    if (isGetCaptureSnapshotRequest(message)) {
      return withKeepAlive(() =>
        handleGetCaptureSnapshot(dependencies, frameKey),
      );
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

// A capture the store cannot reach reads as absent rather than failing the
// request; both callers already handle a missing one.
async function readCapture(
  dependencies: RouterDependencies,
  frameKey: string | undefined,
): Promise<CaptureRecord | undefined> {
  if (!frameKey) {
    return undefined;
  }
  try {
    return await dependencies.captureStore.get(frameKey);
  } catch (error) {
    console.error("[Screen OCR Translator] Could not read the capture", error);
    return undefined;
  }
}

async function writeCapture(
  dependencies: RouterDependencies,
  frameKey: string | undefined,
  mutate: (current: CaptureRecord | undefined) => CaptureDraft | undefined,
): Promise<void> {
  if (!frameKey) {
    return;
  }
  try {
    await dependencies.captureStore.update(frameKey, mutate);
  } catch (error) {
    console.error(
      "[Screen OCR Translator] Could not retain the capture",
      error,
    );
  }
}

async function handleOcrTranslateRequest(
  dependencies: RouterDependencies,
  message: Extract<RuntimeMessage, { type: "OCR_TRANSLATE_REQUEST" }>,
  tabId: number | undefined,
  frameKey: string | undefined,
  pageUrl: string | undefined,
  signal: AbortSignal,
): Promise<PipelineResult> {
  if ("imageUrl" in message) {
    sendPipelineStatus(tabId, message.requestId, { stage: "loading" });
  }
  // Replace the previous capture before any fallible setup so a retry cannot
  // reprocess stale pixels at the new selection's position.
  await writeCapture(dependencies, frameKey, () => ({
    requestId: message.requestId,
    sourceLanguage: "auto",
    displaySize:
      "rect" in message
        ? { width: message.rect.width, height: message.rect.height }
        : undefined,
  }));

  const settings = await dependencies.settingsRepository.get();
  const sourceLanguage = resolveOcrSourceLanguage(settings.ocr.sourceLang);
  await writeCapture(dependencies, frameKey, (current) =>
    current?.requestId === message.requestId
      ? { ...current, sourceLanguage: sourceLanguage.id }
      : undefined,
  );

  const ocrProvider = dependencies.createOcrProvider(settings.ocr);
  const translationProvider = dependencies.createTranslationProvider(
    settings.translation,
  );
  const image =
    "imageUrl" in message
      ? await dependencies.loadImage(message.imageUrl, pageUrl)
      : await dependencies.captureVisibleArea({
          rect: message.rect,
          viewport: message.viewport,
        });
  // A newer capture may have replaced this frame's entry while the screenshot
  // was being taken.
  await writeCapture(dependencies, frameKey, (current) =>
    current?.requestId === message.requestId ? { ...current, image } : undefined,
  );

  signal.throwIfAborted();

  const result = await runPipeline({
    image,
    ocrProvider,
    translationProvider,
    sourceLang: sourceLanguage.sourceLang,
    targetLang: settings.translation.targetLang,
    detectLanguage: dependencies.detectLanguage,
    signal,
    onStatus: (status) =>
      sendPipelineStatus(tabId, message.requestId, status),
    onOcrResult: (ocr) =>
      sendPipelineOcrResult(tabId, message.requestId, ocr),
  });
  return result;
}

// Hands the captured pixels to the overlay, which paints them under its boxes
// so they stay on the image the text was recognized from. The encoded copy is
// not kept: the overlay asks once per capture, so holding it would be megabytes
// nobody comes back for. Reports an absent snapshot rather than throwing — the
// overlay works without one, over whatever the page is showing now.
async function handleGetCaptureSnapshot(
  dependencies: RouterDependencies,
  frameKey: string | undefined,
): Promise<CaptureSnapshotResponse> {
  const capture = await readCapture(dependencies, frameKey);
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
): Promise<PipelineResult> {
  const selection = findOcrSourceLanguage(message.sourceLang);
  if (!selection) {
    throw new Error(`Unsupported OCR source language: ${message.sourceLang}`);
  }

  const capture = await readCapture(dependencies, frameKey);
  if (!capture?.image) {
    throw new Error(t("errorCapturedImageUnavailable"));
  }
  const image = capture.image;

  await writeCapture(dependencies, frameKey, (current) =>
    current?.requestId === capture.requestId
      ? { ...current, sourceLanguage: selection.id }
      : undefined,
  );

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
  return result;
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
async function handleGetOcrSourceLanguages(
  dependencies: RouterDependencies,
): Promise<OcrSourceLanguagesResponse> {
  const settings = await dependencies.settingsRepository.get();
  const [auto, ...supported] = COMMON_OCR_SOURCE_LANGUAGES.map(({ id }) => ({
    id,
  }));
  return {
    languages: [auto, ...supported],
    currentId: resolveOcrSourceLanguage(settings.ocr.sourceLang).id,
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
    sourceLang: await sourceLanguageForFrame(dependencies, frameKey),
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
    sourceLang: await sourceLanguageForFrame(dependencies, frameKey),
    targetLang: nextTranslation.targetLang,
    detectLanguage: dependencies.detectLanguage,
    onStatus: (status) =>
      sendPipelineStatus(tabId, message.requestId, status),
    signal,
  });

  return { ocr: { text: message.text }, translation, translationStatus };
}

async function sourceLanguageForFrame(
  dependencies: RouterDependencies,
  frameKey: string | undefined,
): Promise<string | "auto"> {
  const capture = await readCapture(dependencies, frameKey);
  return resolveTranslationSourceLanguage(capture?.sourceLanguage ?? "auto");
}
