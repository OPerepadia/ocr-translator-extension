import type { OcrProvider } from "../providers/ocr/types";
import type { TranslationProvider } from "../providers/translation/types";
import { resolveTargetLanguage, translationTargetLanguages } from "../providers/translation/target-languages";
import { browser, type Browser } from "wxt/browser";
import type {
  BackgroundRequest,
  BackgroundRequestOf,
  CaptureSnapshotResponse,
  ContentMessage,
  OcrSourceLanguagesResponse,
  SpeakResponse,
  TranslationProvidersResponse,
} from "../shared/messages";
import { encodeSnapshot } from "../shared/image";
import { t } from "../shared/i18n";
import { onRequest, sendToContent } from "../shared/runtime-messaging";
import {
  findOcrSourceLanguage,
  OCR_PROVIDERS,
  ocrSourceLanguagesForProvider,
  resolveOcrSourceLanguage,
  resolveTranslationSourceLanguage,
  TRANSLATION_PROVIDERS,
} from "../providers/catalog";
import type { SettingsRepository } from "../shared/storage";
import type {
  LangCode,
  PipelineResult,
  PipelineStatus,
  Rect,
  Settings,
  Viewport,
} from "../shared/types";
import type { LiveFrame } from "./capture";
import type {
  CaptureDraft,
  CaptureRecord,
  CaptureStore,
} from "./capture-store";
import { createKeepAlive } from "./keepalive";
import {
  handleLiveFrameRequest,
  handleLiveImageRequest,
  handleLiveTranslateRequest,
  type LiveSessions,
} from "./live";
import { runPipeline, translateText } from "./pipeline";

export interface RouterDependencies {
  settingsRepository: SettingsRepository;
  /** Screenshots retained past the request that took them. */
  captureStore: CaptureStore;
  captureVisibleArea(args: { rect: Rect; viewport: Viewport }): Promise<Blob>;
  /** Capture a region for live translation, with the `mask` rect painted over. */
  captureLiveFrame(args: {
    rect: Rect;
    viewport: Viewport;
    mask?: Rect;
    tabId: number;
    windowId: number;
  }): Promise<LiveFrame | undefined>;
  loadImage(url: string, pageUrl?: string): Promise<Blob>;
  createOcrProvider(settings: Settings["ocr"]): OcrProvider;
  /** Free the cached OCR provider's worker and models. */
  releaseOcrProvider(): void;
  createTranslationProvider(
    settings: Settings["translation"],
  ): TranslationProvider;
  /** Detect the source language of text (browser.i18n.detectLanguage). */
  detectLanguage(text: string): Promise<LangCode | undefined>;
  speakText(text: string, lang: LangCode): Promise<string[]>;
}

interface Origin {
  sender: Browser.runtime.MessageSender;
  tabId: number | undefined;
  frameKey: string | undefined;
}

export function startRouter(
  dependencies: RouterDependencies,
  localeReady: Promise<unknown> = Promise.resolve(),
): void {
  const withKeepAlive = createKeepAlive(
    () => browser.runtime.getPlatformInfo(),
    KEEPALIVE_INTERVAL_MS,
    {
      lingerMs: WARM_MS,
      onIdle: () => dependencies.releaseOcrProvider(),
    },
  );

  const cancellable = <T>(
    requestId: string,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => withKeepAlive(() => withAbort(requestId, run));

  const liveSessions: LiveSessions = new Map();

  onRequest(async (rawMessage, sender) => {
    await localeReady;
    const message = rawMessage as BackgroundRequest;
    const origin = originOf(sender);
    const { tabId } = origin;

    switch (message?.type) {
      case "START_SELECTION":
        return sendToFrame(tabId, message, 0);
      case "FRAME_IMAGE_AT_POINT":
        return sendToFrame(
          tabId,
          { ...message, frameId: origin.sender.frameId ?? 0 },
          0,
        );
      case "TRANSLATE_FRAME_IMAGE":
        return sendToFrame(tabId, message, message.frameId);
      case "CANCEL_REQUEST":
        inFlight.get(message.requestId)?.abort();
        return undefined;
      case "OCR_TRANSLATE_REQUEST":
        return cancellable(message.requestId, (signal) =>
          handleOcrTranslateRequest(dependencies, message, origin, signal),
        );
      case "RETRANSLATE_REQUEST":
        return cancellable(message.requestId, (signal) =>
          handleRetranslateRequest(dependencies, message, origin, signal),
        );
      case "SWITCH_PROVIDER_REQUEST":
        return cancellable(message.requestId, (signal) =>
          handleSwitchProviderRequest(dependencies, message, origin, signal),
        );
      case "RERECOGNIZE_REQUEST":
        return cancellable(message.requestId, (signal) =>
          handleRerecognizeRequest(dependencies, message, origin, signal),
        );
      case "LIVE_FRAME_REQUEST":
        return cancellable(message.requestId, (signal) =>
          handleLiveFrameRequest(
            dependencies,
            liveSessions,
            message,
            origin.sender.tab,
            signal,
          ),
        );
      case "LIVE_IMAGE_REQUEST":
        return cancellable(message.requestId, (signal) =>
          handleLiveImageRequest(dependencies, liveSessions, message, signal),
        );
      case "LIVE_TRANSLATE_REQUEST":
        return cancellable(message.requestId, (signal) =>
          handleLiveTranslateRequest(dependencies, message, signal),
        );
      case "LIVE_STOP":
        liveSessions.delete(message.sessionId);
        return undefined;
      case "PRELOAD_OCR":
        return withKeepAlive(() => handlePreloadOcrRequest(dependencies));
      case "GET_CAPTURE_SNAPSHOT":
        return withKeepAlive(() =>
          handleGetCaptureSnapshot(dependencies, origin.frameKey),
        );
      case "SPEAK_REQUEST":
        return withKeepAlive(() => handleSpeakRequest(dependencies, message));
      case "GET_TARGET_LANGUAGES":
        return handleGetTargetLanguages(dependencies);
      case "GET_OCR_SOURCE_LANGUAGES":
        return handleGetOcrSourceLanguages(dependencies);
      case "GET_TRANSLATION_PROVIDERS":
        return handleGetTranslationProviders(dependencies);
      case "OPEN_OPTIONS":
        if (message.section) {
          return openOptionsSection(message.section);
        }
        void browser.runtime.openOptionsPage();
        return undefined;
      default:
        message satisfies never;
        return undefined;
    }
  });
}

function originOf(sender: Browser.runtime.MessageSender): Origin {
  const tabId = sender.tab?.id;
  return {
    sender,
    tabId,
    frameKey:
      tabId === undefined ? undefined : `${tabId}:${sender.frameId ?? 0}`,
  };
}

function sendToFrame(
  tabId: number | undefined,
  message: ContentMessage,
  frameId: number,
): Promise<unknown> | undefined {
  return tabId === undefined
    ? undefined
    : sendToContent(tabId, message, { frameId });
}

// Updates the originating tab; ignores a tab that closed.
async function notifyTab(
  tabId: number | undefined,
  message: ContentMessage,
): Promise<void> {
  if (tabId !== undefined) {
    await sendToContent(tabId, message).catch(() => {});
  }
}

async function openOptionsSection(section: "translation"): Promise<void> {
  const optionsUrl = browser.runtime.getURL("/options.html");
  const targetUrl = `${optionsUrl}#${section}`;
  const contexts = await browser.runtime.getContexts({ contextTypes: ["TAB"] });
  const existing = contexts.find(
    (context) => context.documentUrl?.split("#", 1)[0] === optionsUrl,
  );

  if (existing) {
    await browser.tabs.update(existing.tabId, {
      active: true,
      url: targetUrl,
    });
    await browser.windows.update(existing.windowId, { focused: true });
    return;
  }

  await browser.tabs.create({ url: targetUrl });
}

async function handleSpeakRequest(
  dependencies: RouterDependencies,
  message: BackgroundRequestOf<"SPEAK_REQUEST">,
): Promise<SpeakResponse> {
  return {
    audioChunks: await dependencies.speakText(message.text, message.lang),
  };
}

// Firefox unloads the non-persistent event page after a short idle period
// (~30s in practice; see Bugzilla 1851373), and Chrome stops the service
// worker the same way. Either kills in-flight OCR and translation, and drops
// the loaded OCR models. Calling a cheap extension API every 20s resets the
// idle timer while any background request is active.
const KEEPALIVE_INTERVAL_MS = 20_000;
// Keep the background, and with it the loaded OCR models, up this long after
// the last request, so the next capture skips the model cold start.
const WARM_MS = 5 * 60_000;

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
  message: BackgroundRequestOf<"OCR_TRANSLATE_REQUEST">,
  { tabId, frameKey, sender }: Origin,
  signal: AbortSignal,
): Promise<PipelineResult> {
  const { requestId } = message;
  if ("imageUrl" in message) {
    sendPipelineStatus(tabId, requestId, { stage: "loading" });
  }
  // Replace the previous capture before any fallible setup so a retry cannot
  // reprocess stale pixels at the new selection's position.
  await writeCapture(dependencies, frameKey, () => ({
    requestId,
    sourceLanguage: "auto",
    displaySize:
      "rect" in message
        ? { width: message.rect.width, height: message.rect.height }
        : undefined,
  }));

  const settings = await dependencies.settingsRepository.get();
  const sourceLanguage = resolveOcrSourceLanguage(
    settings.ocr.sourceLang,
    settings.ocr.providerId,
  );
  await writeCapture(dependencies, frameKey, (current) =>
    current?.requestId === requestId
      ? { ...current, sourceLanguage: sourceLanguage.id }
      : undefined,
  );

  const image =
    "imageUrl" in message
      ? await dependencies.loadImage(message.imageUrl, sender.url)
      : await dependencies.captureVisibleArea({
          rect: message.rect,
          viewport: message.viewport,
        });
  // A newer capture may have replaced this frame's entry while the screenshot
  // was being taken.
  await writeCapture(dependencies, frameKey, (current) =>
    current?.requestId === requestId ? { ...current, image } : undefined,
  );

  signal.throwIfAborted();

  return runTabPipeline(dependencies, {
    settings,
    image,
    sourceLang: sourceLanguage.sourceLang,
    requestId,
    tabId,
    signal,
  });
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
// source language or OCR model and uses the selection as the default for future
// captures.
async function handleRerecognizeRequest(
  dependencies: RouterDependencies,
  message: BackgroundRequestOf<"RERECOGNIZE_REQUEST">,
  { tabId, frameKey }: Origin,
  signal: AbortSignal,
): Promise<PipelineResult> {
  const settings = await dependencies.settingsRepository.get();
  const providerId =
    OCR_PROVIDERS.find(({ id }) => id === message.ocrProviderId)?.id ??
    settings.ocr.providerId;
  // A model switch keeps the language when the new model can read it.
  const selection = message.ocrProviderId
    ? resolveOcrSourceLanguage(message.sourceLang, providerId)
    : findOcrSourceLanguage(message.sourceLang, providerId);
  if (!selection) {
    throw new Error(`Unsupported OCR source language: ${message.sourceLang}`);
  }

  const capture = await readCapture(dependencies, frameKey);
  if (!capture?.image) {
    throw new Error(t("errorCapturedImageUnavailable"));
  }

  await writeCapture(dependencies, frameKey, (current) =>
    current?.requestId === capture.requestId
      ? { ...current, sourceLanguage: selection.id }
      : undefined,
  );

  const ocr = {
    ...settings.ocr,
    providerId,
    sourceLang: selection.id,
  };
  if (
    selection.id !== settings.ocr.sourceLang ||
    providerId !== settings.ocr.providerId
  ) {
    await dependencies.settingsRepository.set({ ...settings, ocr });
  }

  return runTabPipeline(dependencies, {
    settings: { ...settings, ocr },
    image: capture.image,
    sourceLang: selection.sourceLang,
    requestId: message.requestId,
    tabId,
    signal,
  });
}

function runTabPipeline(
  dependencies: RouterDependencies,
  args: {
    settings: Settings;
    image: Blob;
    sourceLang: LangCode | "auto";
    requestId: string;
    tabId: number | undefined;
    signal: AbortSignal;
  },
): Promise<PipelineResult> {
  const { settings, requestId, tabId } = args;
  return runPipeline({
    image: args.image,
    ocrProvider: dependencies.createOcrProvider(settings.ocr),
    translationProvider: dependencies.createTranslationProvider(
      settings.translation,
    ),
    sourceLang: args.sourceLang,
    targetLang: settings.translation.targetLang,
    detectLanguage: dependencies.detectLanguage,
    signal: args.signal,
    onStatus: (status) => sendPipelineStatus(tabId, requestId, status),
    onOcrResult: (ocr) =>
      notifyTab(tabId, { type: "OCR_TRANSLATE_OCR_RESULT", requestId, ocr }),
  });
}

// Fire-and-forget: status updates must not hold up the pipeline.
function sendPipelineStatus(
  tabId: number | undefined,
  requestId: string,
  status: PipelineStatus,
): void {
  void notifyTab(tabId, { type: "OCR_TRANSLATE_STATUS", requestId, status });
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

// Reports the OCR providers and the source languages the current one can read.
async function handleGetOcrSourceLanguages(
  dependencies: RouterDependencies,
): Promise<OcrSourceLanguagesResponse> {
  const settings = await dependencies.settingsRepository.get();
  const { providerId } = settings.ocr;
  return {
    languages: ocrSourceLanguagesForProvider(providerId).map(({ id }) => ({
      id,
    })),
    currentId: resolveOcrSourceLanguage(settings.ocr.sourceLang, providerId).id,
    providers: OCR_PROVIDERS.map(({ id }) => ({ id })),
    currentProviderId: providerId,
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
  message: BackgroundRequestOf<"RETRANSLATE_REQUEST">,
  origin: Origin,
  signal: AbortSignal,
): Promise<PipelineResult> {
  const settings = await dependencies.settingsRepository.get();
  const translation = {
    ...settings.translation,
    targetLang: message.targetLang,
  };
  await dependencies.settingsRepository.set({ ...settings, translation });
  return translateRecognizedText(
    dependencies,
    translation,
    message,
    origin,
    signal,
  );
}

// Switches the active translation provider (picked in the panel), saves it as the
// new default, and re-translates the already-recognized text with it.
async function handleSwitchProviderRequest(
  dependencies: RouterDependencies,
  message: BackgroundRequestOf<"SWITCH_PROVIDER_REQUEST">,
  origin: Origin,
  signal: AbortSignal,
): Promise<PipelineResult> {
  const settings = await dependencies.settingsRepository.get();
  const { providerId } = message;
  const provider = dependencies.createTranslationProvider({
    ...settings.translation,
    providerId,
  });
  // The new provider may not translate into the current target.
  const targetLang = resolveTargetLanguage(
    settings.translation.targetLang,
    provider.listTargetLanguages?.() ?? translationTargetLanguages(providerId),
  );
  const translation = { ...settings.translation, providerId, targetLang };
  if (
    providerId !== settings.translation.providerId ||
    targetLang !== settings.translation.targetLang
  ) {
    await dependencies.settingsRepository.set({ ...settings, translation });
  }
  return translateRecognizedText(
    dependencies,
    translation,
    message,
    origin,
    signal,
  );
}

async function translateRecognizedText(
  dependencies: RouterDependencies,
  translationSettings: Settings["translation"],
  message: { requestId: string; text: string },
  { tabId, frameKey }: Origin,
  signal: AbortSignal,
): Promise<PipelineResult> {
  const capture = await readCapture(dependencies, frameKey);
  const { translation, translationStatus } = await translateText({
    text: message.text,
    translationProvider:
      dependencies.createTranslationProvider(translationSettings),
    sourceLang: resolveTranslationSourceLanguage(
      capture?.sourceLanguage ?? "auto",
    ),
    targetLang: translationSettings.targetLang,
    detectLanguage: dependencies.detectLanguage,
    onStatus: (status) => sendPipelineStatus(tabId, message.requestId, status),
    signal,
  });

  // The recognized text is unchanged, so echo it back; only the translation is
  // recomputed.
  return { ocr: { text: message.text }, translation, translationStatus };
}
