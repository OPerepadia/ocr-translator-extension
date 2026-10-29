import { browser } from "wxt/browser";
import {
  isRuntimeMessage,
  serializeError,
} from "@/shared/messages";
import type {
  CaptureSnapshotResponse,
  LiveFrameResponse,
  LiveImageResponse,
  LiveTranslationResponse,
  OcrImageSource,
  OcrSourceLanguagesResponse,
  TranslationProvidersResponse,
} from "@/shared/messages";
import { base64ToBlob } from "@/shared/image";
import { DEFAULT_OCR_PROVIDER_ID } from "@/providers/catalog";
import { UNSUPPORTED_SCRIPT_ERROR } from "@/providers/ocr/types";
import type {
  LangCode,
  PipelineOcrResult,
  PipelineResult,
  PipelineStatus,
  Rect,
} from "@/shared/types";
import {
  getDefaultOverlayMode,
  getDisplayMode,
  getAdjustSelection,
  getLiveTextScale,
  setLiveTextScale,
  type DisplayMode,
  type LiveTextScale,
} from "@/shared/storage";
import { createRequestId } from "@/shared/request-id";
import { sendRequest } from "@/shared/runtime-messaging";
import { LatestRequestRunner } from "./latest-request";
import type { ContentControls } from "./content-controls";
import { translationProviderIcon } from "./icons";
import {
  initializeI18n,
  ocrProviderLabel,
  t,
  translationProviderLabel,
  uiDirection,
  uiLanguage,
} from "@/shared/i18n";
import {
  closePopup,
  configureResultPanel,
  dispose as disposeResultPanel,
  resetForNewCapture,
  setOverlayAvailable,
  setUiRoot,
  showError,
  showLoading,
  showRecognizedTextWhileTranslating,
  showResult,
} from "./result-panel";
import {
  closeOverlay,
  configureOverlay,
  dispose as disposeOverlay,
  isOverlayable,
  resetOverlayMode,
  setOverlaySnapshot,
  setOverlayUiRoot,
  showOverlay,
  showOverlayError,
  showOverlayLoading,
} from "./overlay";
import {
  cancelSelectionOverlay,
  releaseSelectionDim,
  startSelectionOverlay,
} from "./selection-overlay";
import { closeRegionOutline, showRegionOutline } from "./region-outline";
import { LiveSession } from "./live-session";
import { showLivePanel, type LivePanel } from "./live-panel";
import { followRegion, type LiveRegion } from "./live-region";
import { rectsOverlap } from "./live-layout";
import { readFromVideo, type LiveVideoSource } from "./live-video";
import {
  setNavigationContext,
  startNavigationWatch,
} from "./navigation-watch";
import { getRenderedImageRect } from "./overlay-layout";
import { getUiAnchor, watchFullscreen, watchUiModal } from "./modal-ui";
import { languageName } from "./language-picker";
import { findImageAtPoint } from "./image-picker";
import { answerFrameImageProbe, receiveFrameImage } from "./frame-images";
import "./style.css";

const FIRST_LIVE_READ_DELAY_MS = 250;

// The recognized text used by re-translate and provider-switch requests.
let pendingText = "";
// Container inside the shadow root that all extension UI renders into, so the
// host page's CSS cannot leak into the popup or selection overlay.
let uiRoot: HTMLElement | undefined;
// The most recent result and page region it was captured from, kept so the user
// can switch the same result between the panel and the overlay, and so the
// overlay survives a panel-driven re-translate (which echoes the text without
// the OCR blocks).
let lastResult: PipelineResult | undefined;
let lastRect: Rect | undefined;
let lastContextImage: HTMLImageElement | undefined;
// The captured pixels the overlay paints its region with, and a counter that
// tells a snapshot still being fetched that its capture has been superseded.
let lastSnapshot: ImageBitmap | undefined;
let captureGeneration = 0;
let requestedSnapshotGeneration = 0;
let selectionGeneration = 0;
// Which view is currently on screen, and the default for fresh captures (read
// from Options at the start of each capture).
let activeView: "panel" | "overlay" = "panel";
let displayMode: DisplayMode = "panel";
let activePipelineStage: PipelineStatus["stage"] | undefined;
// The running live translation, if any. It reads the screen on its own, so
// nothing else may draw over its region while it runs.
let live:
  | {
      session: LiveSession;
      panel: LivePanel;
      sessionId: string;
      measureRegion: () => Rect;
      retarget: (rect: Rect) => void;
      stopWatching: () => void;
    }
  | undefined;

const contentControls: ContentControls = {
  targetLanguages: [],
  ocrSourceLanguages: [],
  currentOcrSourceLanguageId: "auto",
  ocrProviders: [],
  translationProviders: [],
  selectTargetLanguage: (targetLang) => {
    void runRetranslate(targetLang);
  },
  selectOcrSourceLanguage: (sourceLang) => {
    contentControls.currentOcrSourceLanguageId = sourceLang;
    void runRerecognize(sourceLang);
  },
  selectOcrProvider: (providerId) => {
    contentControls.currentOcrProviderId = providerId;
    void runRerecognize(contentControls.currentOcrSourceLanguageId, providerId);
  },
  selectTranslationProvider: (providerId) => {
    contentControls.currentTranslationProviderId = providerId;
    void runSwitchProvider(providerId);
  },
};

const requestRunner = new LatestRequestRunner(createRequestId, (requestId) => {
  void browser.runtime
    .sendMessage({ type: "CANCEL_REQUEST", requestId })
    .catch(() => {});
});

export default defineContentScript({
  matches: ["<all_urls>"],
  allFrames: true,
  matchAboutBlank: true,
  matchOriginAsFallback: true,
  runAt: "document_idle",
  // Inject style.css into the shadow root (below) instead of the page, so the
  // page's stylesheet and ours stay isolated from each other.
  cssInjectionMode: "ui",
  async main(ctx) {
    setNavigationContext(ctx);
    const localeReady = initializeI18n();

    let uiPromise: ReturnType<typeof createShadowRootUi> | undefined;
    let stopModalWatch: (() => void) | undefined;
    let stopFullscreenWatch: (() => void) | undefined;
    const ensureUi = async (): Promise<void> => {
      try {
        await localeReady;
        const ui = await (uiPromise ??= createShadowRootUi(ctx, {
          name: "ocr-translate-ui",
          position: "inline",
          anchor: getUiAnchor,
          // Prevent page shortcuts from intercepting UI keystrokes
          isolateEvents: true,
          onMount: (container, _shadow, host) => {
            stopModalWatch?.();
            stopModalWatch = watchUiModal(host, container, closePageUi);
            stopFullscreenWatch?.();
            stopFullscreenWatch = watchFullscreen(host);
            container.lang = uiLanguage();
            container.dir = uiDirection();
            uiRoot = container;
            setUiRoot(container);
            setOverlayUiRoot(container);
          },
        }));
        if (ctx.isInvalid) {
          return;
        }
        ui.mount();
      } catch (error) {
        uiPromise = undefined;
        throw error;
      }
    };
    const withUi = (action: () => void): void => {
      void ensureUi()
        .then(() => {
          if (ctx.isValid) {
            action();
          }
        })
        .catch((error: unknown) => {
          console.error(
            "[Screen OCR Translator] Failed to initialize page UI",
            error,
          );
        });
    };

    ctx.addEventListener(
      document,
      "contextmenu",
      (event) => {
        lastContextImage = event
          .composedPath()
          .find(
            (target): target is HTMLImageElement =>
              target instanceof HTMLImageElement,
          );
      },
      true,
    );
    ctx.addEventListener(window, "message", (event) => {
      answerFrameImageProbe(event, getUiHost(), (answer) => {
        void sendRequest({ type: "FRAME_IMAGE_AT_POINT", ...answer }).catch(
          () => {},
        );
      });
    });

    configureResultPanel({
      controls: contentControls,
      onClose: () => {
        cancelActiveRequest();
        releaseSelectionDim();
        closeRegionOutline();
        clearCaptureSnapshot();
      },
      onNewSelection: startNewSelection,
      onShowOverlay: switchToOverlay,
      onTranslateRequest: (text, targetLang) => {
        pendingText = text;
        if (targetLang) {
          contentControls.selectTargetLanguage(targetLang);
        }
      },
    });
    configureOverlay({
      controls: contentControls,
      onClose: () => {
        cancelActiveRequest();
        if (activeView === "overlay") {
          clearCaptureSnapshot();
        }
      },
      onShowPanel: switchToPanel,
      onNewSelection: startNewSelection,
    });

    const startImageTranslation = (run: () => Promise<void>): void => {
      stopLive();
      cancelSelectionOverlay();
      closePopup();
      closeOverlay();
      withUi(() => void run());
    };

    const handleRuntimeMessage = (
      message: unknown,
      _sender: unknown,
      sendResponse: (response: unknown) => void,
    ): undefined => {
      if (isRuntimeMessage(message, "PING")) {
        sendResponse(true);
        return undefined;
      }
      if (isRuntimeMessage(message, "START_SELECTION")) {
        closePopup();
        closeOverlay();
        withUi(() => void runSelectionFlow());
        return undefined;
      }
      if (isRuntimeMessage(message, "START_LIVE_SELECTION")) {
        closePopup();
        closeOverlay();
        withUi(() => void runLiveSelectionFlow());
        return undefined;
      }
      if (isRuntimeMessage(message, "START_IMAGE_TRANSLATION")) {
        startImageTranslation(() => runImageFlow(message.imageUrl));
        return undefined;
      }
      if (isRuntimeMessage(message, "FRAME_IMAGE_AT_POINT")) {
        receiveFrameImage(message);
        return undefined;
      }
      if (isRuntimeMessage(message, "TRANSLATE_FRAME_IMAGE")) {
        const { x, y } = message.point;
        const image = findImageAtPoint(x, y, getUiHost());
        if (image instanceof HTMLImageElement) {
          startImageTranslation(() => runImageElementFlow(image));
        }
        return undefined;
      }
      if (
        isRuntimeMessage(message, "OCR_TRANSLATE_STATUS") &&
        message.requestId === requestRunner.activeRequestId
      ) {
        activePipelineStage = message.status.stage;
        showActiveLoading(message.status);
        // The loading view takes over; overlay mode draws its own dim.
        releaseSelectionDim();
        // Image URL requests report loading before their pixels are stored.
        if (message.status.stage !== "loading") {
          syncPanelRegionOutline();
          requestCaptureSnapshot();
        }
        return undefined;
      }
      if (
        isRuntimeMessage(message, "OCR_TRANSLATE_OCR_RESULT") &&
        message.requestId === requestRunner.activeRequestId
      ) {
        pendingText = message.ocr.text;
        showActiveOcrResult(message.ocr);
        // The pipeline always reports its OCR result, so the frozen region does
        // not depend on a recognizer that reports no status along the way.
        requestCaptureSnapshot();
        return undefined;
      }
      return undefined;
    };
    browser.runtime.onMessage.addListener(handleRuntimeMessage);
    ctx.onInvalidated(() => {
      stopModalWatch?.();
      stopFullscreenWatch?.();
      selectionGeneration += 1;
      stopLive();
      requestRunner.dispose();
      cancelSelectionOverlay();
      releaseSelectionDim();
      closeRegionOutline();
      clearCaptureSnapshot();
      disposeResultPanel();
      disposeOverlay();
      uiRoot = undefined;
      browser.runtime.onMessage.removeListener(handleRuntimeMessage);
    });
  },
});

// Navigation and modal dismissal invalidate the content behind the capture.
function closePageUi(): void {
  selectionGeneration += 1;
  stopLive();
  cancelActiveRequest();
  cancelSelectionOverlay();
  releaseSelectionDim();
  closeRegionOutline();
  closePopup({ notify: false });
  closeOverlay();
  clearCaptureSnapshot();
  lastResult = undefined;
  lastRect = undefined;
  lastContextImage = undefined;
  pendingText = "";
}

// Drops the in-flight request and tells the background to abort it.
function cancelActiveRequest(): void {
  requestRunner.cancel();
}

async function runSelectionFlow(): Promise<void> {
  if (!uiRoot) {
    return;
  }
  const generation = ++selectionGeneration;
  stopLive();
  cancelSelectionOverlay();
  closeRegionOutline();
  startNavigationWatch(closePageUi);
  // Preload the OCR worker and model while the user is selecting a region,
  // so recognition can start as soon as the screenshot is ready.
  void sendRequest({ type: "PRELOAD_OCR" }).catch(() => {});

  const adjustSelection = await getAdjustSelection();
  if (generation !== selectionGeneration) {
    return;
  }
  const selection = await startSelectionOverlay(uiRoot, adjustSelection);

  if (!selection || generation !== selectionGeneration) {
    return;
  }
  if (selection.kind === "image") {
    await runImageElementFlow(selection.image);
    return;
  }
  if (selection.kind === "frame-image") {
    const { frameId, point } = selection.image;
    void sendRequest({ type: "TRANSLATE_FRAME_IMAGE", frameId, point }).catch(
      () => {},
    );
    return;
  }

  await runCapture({
    rect: selection.rect,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
  });
}

// Pick a region and translate it continuously. Starting again while live
// translation runs closes it first, so cancelling the selection leaves
// nothing running.
async function runLiveSelectionFlow(): Promise<void> {
  if (!uiRoot) {
    return;
  }
  const generation = ++selectionGeneration;
  stopLive();
  cancelSelectionOverlay();
  closeRegionOutline();
  startNavigationWatch(closePageUi);
  void sendRequest({ type: "PRELOAD_OCR" }).catch(() => {});

  const [adjustSelection, textScale] = await Promise.all([
    getAdjustSelection(),
    getLiveTextScale(),
  ]);
  const selection =
    generation === selectionGeneration
      ? await startSelectionOverlay(uiRoot, adjustSelection, {
          pickImages: false,
          hint: t("liveSelectionHint"),
          confirmLabel: t("liveSelectionStart"),
        })
      : null;

  if (generation !== selectionGeneration) {
    return;
  }
  if (selection?.kind === "area") {
    startLive(selection.rect, textScale);
  }
}

function startLive(rect: Rect, textScale: LiveTextScale): void {
  if (!uiRoot) {
    return;
  }
  stopLive();
  // The result views are drawn on the page, so they would be read as well.
  cancelActiveRequest();
  closePopup({ notify: false });
  closeOverlay();
  closeRegionOutline();
  clearCaptureSnapshot();
  releaseSelectionDim();
  lastResult = undefined;
  lastRect = undefined;
  pendingText = "";

  const sessionId = createRequestId();
  const panel = showLivePanel(
    uiRoot,
    rect,
    {
      onPause: () => session.pause(),
      onResume: () => session.resume(),
      onRetry: () => session.retry(),
      onSelectNewRegion: () => void adjustLiveRegion(),
      onClose: stopLive,
      onTextScaleChange: (scale) =>
        void setLiveTextScale(scale).catch(() => {}),
    },
    textScale,
  );
  // Hit testing reports the panel as its shadow host.
  const shadow = uiRoot.getRootNode();
  const uiHost = shadow instanceof ShadowRoot ? shadow.host : undefined;
  const viewport = () => ({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  let region: LiveRegion;
  let video: LiveVideoSource | undefined;
  const follow = (target: Rect): void => {
    const followed = followRegion(target, uiHost, (moved) =>
      panel.moveRegion(moved),
    );
    region = followed;
    // A video is read from its own frames, which the panel is never in.
    // Anything else, or a video the page keeps from the extension, is read off
    // the screen.
    video =
      followed.picture?.element instanceof HTMLVideoElement
        ? readFromVideo(followed.picture.element, followed.picture.share, {
            isInView: () =>
              rectsOverlap(followed.measure(), { x: 0, y: 0, ...viewport() }),
            recognize: (requestId, image, minLineThickness) =>
              sendRequest<LiveImageResponse>({
                type: "LIVE_IMAGE_REQUEST",
                requestId,
                sessionId,
                image,
                minLineThickness,
              }),
            onWake: () => session.wake(),
          })
        : undefined;
    panel.setReadsScreen(!video);
  };
  follow(rect);
  const session = new LiveSession({
    readFrame: async (requestId, minLineThickness) => {
      const read = await video?.read(requestId, minLineThickness);
      panel.setReadsScreen(!read);
      return (
        read ??
        sendRequest<LiveFrameResponse>({
          type: "LIVE_FRAME_REQUEST",
          requestId,
          sessionId,
          // Measured first, so the mask below is taken with the panel moved.
          rect: region.measure(),
          viewport: viewport(),
          mask: panel.getMask(),
          minLineThickness,
        })
      );
    },
    translate: (requestId, text, context) =>
      sendRequest<LiveTranslationResponse>({
        type: "LIVE_TRANSLATE_REQUEST",
        requestId,
        text,
        context,
      }),
    cancel: (requestId) => {
      void sendRequest({ type: "CANCEL_REQUEST", requestId }).catch(() => {});
    },
    createId: createRequestId,
    isVisible: () => document.visibilityState === "visible",
    now: () => Date.now(),
    onChange: (state) => panel.render(state),
  });

  // The screen can only be read while this tab is the one on show, so pick up
  // right away when it returns rather than at the next idle check.
  const wakeWhenVisible = (): void => {
    if (document.visibilityState === "visible") {
      session.wake();
    }
  };
  document.addEventListener("visibilitychange", wakeWhenVisible);

  live = {
    session,
    panel,
    sessionId,
    measureRegion: () => region.measure(),
    retarget: (target) => {
      const previous = region.measure();
      video?.dispose();
      region.dispose();
      follow(target);
      panel.moveRegion(target);
      session.regionChanged(previous.height / target.height);
    },
    stopWatching: () => {
      document.removeEventListener("visibilitychange", wakeWhenVisible);
      video?.dispose();
      region.dispose();
    },
  };
  startNavigationWatch(closePageUi);
  // The selection overlay is torn down above, but a screenshot can lag a few
  // frames behind the page, and the first read would pick up its hint. Waiting
  // for a paint is not enough: the capture may still return an older frame.
  setTimeout(() => {
    if (live?.session === session) {
      session.start();
    }
  }, FIRST_LIVE_READ_DELAY_MS);
}

// Adjust the live region in the selection overlay. The session keeps running.
async function adjustLiveRegion(): Promise<void> {
  const current = live;
  if (!uiRoot || !current) {
    return;
  }
  const generation = ++selectionGeneration;
  const { session } = current;
  const wasPaused = session.isPaused;
  // The overlay's dim and handles would be read as text.
  session.pause();
  cancelSelectionOverlay();

  const selection = await startSelectionOverlay(uiRoot, true, {
    pickImages: false,
    confirmLabel: t("liveAdjustApply"),
    initialRect: current.measureRegion(),
  });

  // The session was stopped or replaced.
  if (generation !== selectionGeneration || live !== current) {
    return;
  }
  if (selection?.kind === "area") {
    current.retarget(selection.rect);
  }
  releaseSelectionDim();
  if (!wasPaused) {
    // A screenshot can still show the overlay.
    setTimeout(() => {
      if (live === current) {
        session.resume();
      }
    }, FIRST_LIVE_READ_DELAY_MS);
  }
}

function stopLive(): void {
  if (!live) {
    return;
  }
  const { session, panel, sessionId, stopWatching } = live;
  live = undefined;
  session.stop();
  stopWatching();
  panel.dispose();
  void sendRequest({ type: "LIVE_STOP", sessionId }).catch(() => {});
}

function startNewSelection(): void {
  if (window === window.top) {
    void runSelectionFlow();
    return;
  }

  closePopup();
  closeOverlay();
  void sendRequest({ type: "START_SELECTION" });
}

async function runImageFlow(imageUrl: string): Promise<void> {
  startNavigationWatch(closePageUi);
  void sendRequest({ type: "PRELOAD_OCR" }).catch(() => {});

  await runCapture({ imageUrl }, findImageRect(imageUrl));
}

async function runImageElementFlow(image: HTMLImageElement): Promise<void> {
  lastContextImage = image;
  await runImageFlow(image.currentSrc || image.src);
}

function getUiHost(): Element | undefined {
  const root = uiRoot?.getRootNode();
  return root instanceof ShadowRoot ? root.host : undefined;
}

function findImageRect(imageUrl: string): Rect | undefined {
  const image =
    lastContextImage?.isConnected
      ? lastContextImage
      : Array.from(document.images).find(
          (candidate) =>
            candidate.currentSrc === imageUrl || candidate.src === imageUrl,
        );
  if (!image) {
    return undefined;
  }
  const rect = image.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return undefined;
  }
  const style = getComputedStyle(image);
  return getRenderedImageRect({
    elementRect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    objectFit: style.objectFit,
    objectPosition: style.objectPosition,
  });
}

async function runCapture(
  source: OcrImageSource,
  imageRect?: Rect,
): Promise<void> {
  const generation = selectionGeneration;
  closeRegionOutline();
  const viewportRect = imageRect ?? ("rect" in source ? source.rect : undefined);
  lastRect = viewportRect ? toPageRect(viewportRect) : undefined;
  lastResult = undefined;
  setOverlayAvailable(false);
  closeOverlay();
  clearCaptureSnapshot();
  const [nextDisplayMode, initialOverlayMode] = await Promise.all([
    getDisplayMode(),
    getDefaultOverlayMode(),
  ]);
  if (generation !== selectionGeneration) {
    return;
  }
  displayMode = nextDisplayMode;
  resetOverlayMode(initialOverlayMode);
  // Head toward that view now so the loading spinner lands there; presentResult
  // falls back to the panel later if the result can't be drawn as an overlay.
  activeView = displayMode;

  // Clear result-specific state before refreshing the defaults. The refresh
  // finishes before the pipeline starts, so both views read the current source
  // and provider before any loading UI appears.
  resetForNewCapture();
  contentControls.currentOcrSourceLanguageId = "auto";
  pendingText = "";

  const [, sourceLanguageId] = await Promise.all([
    loadTargetLanguages(true),
    loadOcrSourceLanguages(),
    loadTranslationProviders(),
  ]);
  if (generation !== selectionGeneration) {
    return;
  }
  activePipelineStage = undefined;

  // For region captures, keep the loading panel hidden until the background has
  // taken its screenshot so the panel cannot appear in the captured image.
  await requestRunner.run({
    request: async (requestId) => {
      let requestSource = source;
      if ("imageUrl" in source && /^(blob|file):/.test(source.imageUrl)) {
        // The background cannot fetch a blob URL owned by this frame, nor a
        // file URL in Firefox. Chrome's content scripts can't fetch file URLs,
        // but its background can, so those go through as they are.
        const imageUrl = await readAsDataUrl(source.imageUrl).catch((error) => {
          if (source.imageUrl.startsWith("file:")) {
            return source.imageUrl;
          }
          throw error;
        });
        if (requestRunner.activeRequestId !== requestId) {
          throw new DOMException("Request cancelled", "AbortError");
        }
        requestSource = { imageUrl };
      }
      return sendRequest<PipelineResult>({
        type: "OCR_TRANSLATE_REQUEST",
        requestId,
        ...requestSource,
      });
    },
    onSuccess: (result) => {
      pendingText = result.ocr.text;
      presentResult(result, true);
    },
    onError: (error) => {
      presentError(serializeError(error), {
        retry:
          "imageUrl" in source
            ? () => void runImageFlow(source.imageUrl)
            : () => void runRerecognize(sourceLanguageId ?? "auto"),
        showSourceLanguageToolbar:
          activePipelineStage === "initializing" ||
          activePipelineStage === "recognizing",
      });
    },
    onSettled: () => {
      activePipelineStage = undefined;
      releaseSelectionDim();
      syncPanelRegionOutline();
    },
  });
}

async function readAsDataUrl(url: string): Promise<string> {
  const blob = await (await fetch(url)).blob();
  return new Promise<string>((resolve, reject) => {
    // FileReader also handles Firefox's page-owned Blob wrappers.
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Render a settled result in the right view: the overlay when overlay mode is
// active and the result can be drawn there, otherwise the panel. `fresh` picks
// the view from the saved default (a new capture); otherwise the current view is
// kept (a panel-driven re-translate stays in the panel). Carries the OCR blocks
// forward when an update echoes only the text, so the overlay stays available.
function presentResult(result: PipelineResult, fresh: boolean): void {
  const enriched = carryOcrDetails(result);
  lastResult = enriched;

  const overlayable = isOverlayable(enriched) && Boolean(lastRect);
  setOverlayAvailable(overlayable);

  const wantOverlay =
    fresh ? displayMode === "overlay" : activeView === "overlay";

  if (wantOverlay && overlayable && lastRect) {
    activeView = "overlay";
    closePopup({ notify: false });
    showResultOverlay(enriched, lastRect);
    return;
  }

  if (wantOverlay && lastRect && !enriched.ocr.text.trim()) {
    activeView = "overlay";
    closePopup({ notify: false });
    showOverlayError({
      rect: lastRect,
      message: t("commonNoTextDetected"),
      showSourceLanguageToolbar: true,
    });
    return;
  }

  // Without OCR geometry there are no boxes to retain, so keep the error-only
  // fallback for captures that cannot render a result overlay.
  const status = enriched.translationStatus;
  if (wantOverlay && lastRect && status.state === "failed") {
    const targetLang = status.targetLang;
    activeView = "overlay";
    closePopup({ notify: false });
    showOverlayError({
      rect: lastRect,
      message: status.reason ?? t("commonTranslationFailed"),
      onRetry:
        targetLang && pendingText
          ? () => void runRetranslate(targetLang)
          : undefined,
      onOpenSettings: () => {
        void sendRequest({ type: "OPEN_OPTIONS", section: "translation" });
      },
    });
    return;
  }

  activeView = "panel";
  closeOverlay();
  showResult(enriched);
  syncPanelRegionOutline();
}

function presentError(
  error: ReturnType<typeof serializeError>,
  options: {
    retry?: () => void;
    retryLabel?: string;
    showSourceLanguageToolbar?: boolean;
  } = {},
): void {
  if (error.name === UNSUPPORTED_SCRIPT_ERROR) {
    // The standard model has a recognizer for every script Auto detects.
    options = {
      ...options,
      retry: () => contentControls.selectOcrProvider(DEFAULT_OCR_PROVIDER_ID),
      retryLabel: t(
        "panelRecognizeWithModel",
        ocrProviderLabel(DEFAULT_OCR_PROVIDER_ID),
      ),
    };
  }
  if (activeView === "overlay" && lastRect) {
    showOverlayError({
      rect: lastRect,
      message: error.message,
      onRetry: options.retry,
      retryLabel: options.retryLabel,
      onOpenSettings: () => {
        void sendRequest({ type: "OPEN_OPTIONS" });
      },
      showSourceLanguageToolbar: options.showSourceLanguageToolbar,
    });
    return;
  }
  activeView = "panel";
  closeOverlay();
  showError(error, options.retry, options.retryLabel);
  syncPanelRegionOutline();
}

function showActiveLoading(status?: PipelineStatus): void {
  if (activeView === "overlay" && lastRect) {
    showOverlayLoading(lastRect, status);
  } else {
    showLoading(status);
  }
}

function showActiveOcrResult(ocr: PipelineOcrResult): void {
  if (activeView === "overlay" && lastRect) {
    showOverlayLoading(lastRect, { stage: "translating" });
  } else {
    showRecognizedTextWhileTranslating(ocr);
  }
}

// Re-translates and provider switches echo the recognized text without the OCR
// blocks/image size. Carry those over from the last result so the overlay can
// still be drawn for the same region.
function carryOcrDetails(result: PipelineResult): PipelineResult {
  if (result.ocr.blocks && result.ocr.blocks.length > 0) {
    return result;
  }
  if (!lastResult) {
    return result;
  }
  return { ...result, ocr: { ...lastResult.ocr, ...result.ocr } };
}

function requestCaptureSnapshot(): void {
  if (requestedSnapshotGeneration === captureGeneration) {
    return;
  }
  const generation = captureGeneration;
  requestedSnapshotGeneration = generation;

  void (async () => {
    try {
      const response =
        await sendRequest<CaptureSnapshotResponse>({
          type: "GET_CAPTURE_SNAPSHOT",
        });
      const encoded = response?.snapshot;
      if (!encoded || generation !== captureGeneration) {
        return;
      }
      const bitmap = await createImageBitmap(
        base64ToBlob(encoded.data, encoded.mediaType),
      );
      if (generation !== captureGeneration) {
        bitmap.close();
        return;
      }
      lastSnapshot = bitmap;
      setOverlaySnapshot(bitmap);
    } catch {
      // No frozen region for this capture; the overlay renders without one.
    }
  })();
}

// Drop the frozen region. The overlay lets go of the bitmap first, so nothing
// can draw it after it is closed.
function clearCaptureSnapshot(): void {
  captureGeneration += 1;
  setOverlaySnapshot(undefined);
  lastSnapshot?.close();
  lastSnapshot = undefined;
}

function toPageRect(rect: Rect): Rect {
  return {
    x: rect.x + window.scrollX,
    y: rect.y + window.scrollY,
    width: rect.width,
    height: rect.height,
  };
}

function switchToOverlay(): void {
  if (!lastResult || !lastRect || !isOverlayable(lastResult)) {
    return;
  }
  activeView = "overlay";
  releaseSelectionDim();
  closeRegionOutline();
  closePopup({ notify: false });
  showResultOverlay(lastResult, lastRect);
}

function showResultOverlay(result: PipelineResult, rect: Rect): void {
  const targetLang =
    result.translationStatus.state === "failed"
      ? result.translationStatus.targetLang
      : undefined;
  showOverlay({
    result,
    rect,
    onRetryTranslation:
      targetLang && pendingText
        ? () => void runRetranslate(targetLang)
        : undefined,
  });
}

function switchToPanel(): void {
  if (!lastResult) {
    return;
  }
  activeView = "panel";
  closeOverlay();
  setOverlayAvailable(isOverlayable(lastResult) && Boolean(lastRect));
  showResult(lastResult);
  syncPanelRegionOutline();
}

function syncPanelRegionOutline(): void {
  if (activeView === "panel" && uiRoot && lastRect) {
    showRegionOutline(uiRoot, lastRect);
  } else {
    closeRegionOutline();
  }
}

async function runRetranslate(targetLang: LangCode): Promise<void> {
  if (!pendingText) {
    return;
  }

  const text = pendingText;
  await requestRunner.run({
    onStart: () => showActiveLoading({ stage: "translating" }),
    request: (requestId) =>
      sendRequest<PipelineResult>({
        type: "RETRANSLATE_REQUEST",
        requestId,
        text,
        targetLang,
      }),
    onSuccess: (result) => presentResult(result, false),
    onError: (error) => {
      presentError(serializeError(error), {
        retry: () => void runRetranslate(targetLang),
      });
    },
  });
}

// Re-run OCR on the last captured image for a different source language or OCR
// model. The background also saves both as the defaults for future captures.
async function runRerecognize(
  sourceLang: LangCode | "auto",
  ocrProviderId?: string,
): Promise<void> {
  await requestRunner.run({
    onStart: () => showActiveLoading(),
    request: async (requestId) => {
      try {
        return await sendRequest<PipelineResult>({
          type: "RERECOGNIZE_REQUEST",
          requestId,
          sourceLang,
          ocrProviderId,
        });
      } finally {
        if (ocrProviderId && requestRunner.activeRequestId === requestId) {
          // The background saves the selection even if recognition fails.
          await loadOcrSourceLanguages(requestId);
        }
      }
    },
    onSuccess: (result) => {
      pendingText = result.ocr.text;
      presentResult(result, false);
    },
    onError: (error) => {
      presentError(serializeError(error), {
        retry: () => void runRerecognize(sourceLang, ocrProviderId),
        showSourceLanguageToolbar: true,
      });
    },
  });
}

// Switch the translation provider (picked in the panel) and re-translate the
// current recognized text with it. The background persists the new provider as
// the default. Different providers support different target languages, so the
// target-language list is refreshed before the result is shown.
async function runSwitchProvider(providerId: string): Promise<void> {
  if (!pendingText) {
    return;
  }

  const text = pendingText;
  await requestRunner.run({
    onStart: () => showActiveLoading({ stage: "translating" }),
    request: async (requestId) => {
      const result = await sendRequest<PipelineResult>({
        type: "SWITCH_PROVIDER_REQUEST",
        requestId,
        providerId,
        text,
      });
      if (requestRunner.activeRequestId === requestId) {
        // The new provider may translate into a different set of languages.
        await loadTargetLanguages(true);
      }
      return result;
    },
    onSuccess: (result) => presentResult(result, false),
    onError: (error) => presentError(serializeError(error)),
  });
}

// Fetch the supported OCR source languages and the saved default.
async function loadOcrSourceLanguages(
  requestId?: string,
): Promise<string | undefined> {
  try {
    const response =
      await sendRequest<OcrSourceLanguagesResponse>({
        type: "GET_OCR_SOURCE_LANGUAGES",
      });
    if (requestId && requestRunner.activeRequestId !== requestId) {
      return undefined;
    }
    if (response && Array.isArray(response.languages)) {
      const languages = response.languages.map(({ id }) => ({
        id,
        label: id === "auto" ? t("commonAuto") : languageName(id),
      }));
      contentControls.ocrSourceLanguages = languages;
      contentControls.currentOcrSourceLanguageId = response.currentId;
      contentControls.ocrProviders = (response.providers ?? []).map(({ id }) => ({
        id,
        label: ocrProviderLabel(id),
      }));
      contentControls.currentOcrProviderId = response.currentProviderId;
      return response.currentId;
    }
  } catch {
    // Leave the list empty; the picker won't show.
  }
  return undefined;
}

// Fetch the recognizer-independent translation providers and the saved default.
async function loadTranslationProviders(): Promise<void> {
  try {
    const response =
      await sendRequest<TranslationProvidersResponse>({
        type: "GET_TRANSLATION_PROVIDERS",
      });
    if (response && Array.isArray(response.providers)) {
      const providers = response.providers.map(({ id }) => ({
        id,
        label: translationProviderLabel(id),
        icon: translationProviderIcon(id),
      }));
      contentControls.translationProviders = providers;
      contentControls.currentTranslationProviderId = response.currentId;
    }
  } catch {
    // Leave the list empty; the picker won't show.
  }
}

// Fetch the active provider's target languages and hand them to the popup. Cached
// after the first call; pass force to re-fetch (e.g. after switching providers,
// which can change the supported set).
let targetLanguagesLoaded = false;
async function loadTargetLanguages(force = false): Promise<void> {
  if (targetLanguagesLoaded && !force) {
    return;
  }
  try {
    const languages = await sendRequest<LangCode[]>({
      type: "GET_TARGET_LANGUAGES",
    });
    if (Array.isArray(languages)) {
      targetLanguagesLoaded = true;
      contentControls.targetLanguages = languages;
    }
  } catch {
    // Leave the list empty; the pill falls back to the current target only.
  }
}
