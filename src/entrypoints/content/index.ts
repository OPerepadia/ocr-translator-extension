import { browser } from "wxt/browser";
import {
  isRuntimeMessage,
  serializeError,
} from "@/shared/messages";
import type {
  CaptureSnapshotResponse,
  LiveFrameResponse,
  LiveTranslationResponse,
  OcrImageSource,
  OcrSourceLanguagesResponse,
  TranslationProvidersResponse,
} from "@/shared/messages";
import { base64ToBlob } from "@/shared/image";
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
  type DisplayMode,
} from "@/shared/storage";
import { createRequestId } from "@/shared/request-id";
import { sendRequest } from "@/shared/runtime-messaging";
import { LatestRequestRunner } from "./latest-request";
import type { ContentControls } from "./content-controls";
import {
  initializeI18n,
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
import {
  setNavigationContext,
  startNavigationWatch,
} from "./navigation-watch";
import { getRenderedImageRect } from "./overlay-layout";
import { getUiAnchor, watchFullscreen, watchUiModal } from "./modal-ui";
import { languageName } from "./language-picker";
import {
  cancelImagePickerOverlay,
  cleanupImagePickerOnNavigation,
  startImagePickerOverlay,
} from "./image-picker";
import "./style.css";

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
let activeImagePickerSessionId: string | undefined;
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
      stopWatchingVisibility: () => void;
    }
  | undefined;

const contentControls: ContentControls = {
  targetLanguages: [],
  ocrSourceLanguages: [],
  currentOcrSourceLanguageId: "auto",
  translationProviders: [],
  selectTargetLanguage: (targetLang) => {
    void runRetranslate(targetLang);
  },
  selectOcrSourceLanguage: (sourceLang) => {
    contentControls.currentOcrSourceLanguageId = sourceLang;
    void runRerecognize(sourceLang);
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
        endActiveImagePickerSession();
        closePopup();
        closeOverlay();
        withUi(() => void runSelectionFlow());
        return undefined;
      }
      if (isRuntimeMessage(message, "START_LIVE_SELECTION")) {
        endActiveImagePickerSession();
        closePopup();
        closeOverlay();
        withUi(() => void runLiveSelectionFlow());
        return undefined;
      }
      if (
        isRuntimeMessage(message, "START_IMAGE_PICKER") &&
        typeof message.sessionId === "string"
      ) {
        activeImagePickerSessionId = message.sessionId;
        stopLive();
        cancelSelectionOverlay();
        closePopup();
        closeOverlay();
        withUi(() => {
          if (activeImagePickerSessionId === message.sessionId) {
            void runImagePickerFlow(message.sessionId);
          }
        });
        return undefined;
      }
      if (
        isRuntimeMessage(message, "CANCEL_IMAGE_PICKER") &&
        typeof message.sessionId === "string"
      ) {
        cancelImagePickerSession(message.sessionId);
        return undefined;
      }
      if (isRuntimeMessage(message, "START_IMAGE_TRANSLATION")) {
        stopLive();
        cancelSelectionOverlay();
        endActiveImagePickerSession();
        closePopup();
        closeOverlay();
        withUi(() => void runImageFlow(message.imageUrl));
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
      clearActiveImagePickerSession();
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
  cleanupImagePickerOnNavigation(
    window === window.top,
    clearActiveImagePickerSession,
    endActiveImagePickerSession,
  );
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

  await runCapture({
    rect: selection.rect,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
  });
}

// Pick a region and translate it continuously. Starting again while live
// translation runs picks a new region; the old one keeps going only if the
// selection is cancelled.
async function runLiveSelectionFlow(): Promise<void> {
  if (!uiRoot) {
    return;
  }
  const generation = ++selectionGeneration;
  cancelSelectionOverlay();
  closeRegionOutline();
  startNavigationWatch(closePageUi);
  void sendRequest({ type: "PRELOAD_OCR" }).catch(() => {});

  // The selection dim would otherwise be read as part of the region.
  const interrupted = live;
  const wasPaused = interrupted?.session.current.status === "paused";
  interrupted?.session.pause();

  const adjustSelection = await getAdjustSelection();
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
    startLive(selection.rect);
  } else if (interrupted && live === interrupted && !wasPaused) {
    interrupted.session.resume();
  }
}

function startLive(rect: Rect): void {
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
  const panel = showLivePanel(uiRoot, rect, {
    onPause: () => session.pause(),
    onResume: () => session.resume(),
    onRetry: () => session.retry(),
    onSelectNewRegion: () => void runLiveSelectionFlow(),
    onClose: stopLive,
  });
  const session = new LiveSession({
    readFrame: (requestId) =>
      sendRequest<LiveFrameResponse>({
        type: "LIVE_FRAME_REQUEST",
        requestId,
        sessionId,
        rect,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        mask: panel.getMask(),
      }),
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
    stopWatchingVisibility: () =>
      document.removeEventListener("visibilitychange", wakeWhenVisible),
  };
  startNavigationWatch(closePageUi);
  // The selection overlay is torn down above, but until the browser paints that
  // it is still on screen, and the first read would pick up its hint.
  void afterNextPaint().then(() => {
    if (live?.session === session) {
      session.start();
    }
  });
}

// Resolves once the page has painted. The timeout covers a tab that is hidden,
// where animation frames do not run.
function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    const fallback = setTimeout(resolve, 150);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(fallback);
        resolve();
      }),
    );
  });
}

function stopLive(): void {
  if (!live) {
    return;
  }
  const { session, panel, sessionId, stopWatchingVisibility } = live;
  live = undefined;
  session.stop();
  stopWatchingVisibility();
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

  const imageRect = findImageRect(imageUrl);
  if (imageUrl.startsWith("file:") && imageRect) {
    await runCapture({
      rect: imageRect,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
    });
    return;
  }

  await runCapture({ imageUrl }, imageRect);
}

async function runImageElementFlow(image: HTMLImageElement): Promise<void> {
  lastContextImage = image;
  await runImageFlow(image.currentSrc || image.src);
}

async function runImagePickerFlow(sessionId: string): Promise<void> {
  if (!uiRoot) {
    return;
  }
  releaseSelectionDim();
  closeRegionOutline();
  startNavigationWatch(closePageUi);
  if (window === window.top) {
    void sendRequest({ type: "PRELOAD_OCR" }).catch(() => {});
  }

  const isTopFrame = window === window.top;
  const image = await startImagePickerOverlay(uiRoot, {
    // A parent-frame scrim would paint over highlights inside child frames.
    showDim: false,
    showHint: isTopFrame,
  });
  if (activeImagePickerSessionId !== sessionId) {
    return;
  }
  activeImagePickerSessionId = undefined;
  notifyImagePickerEnded(sessionId);
  if (!image) {
    return;
  }

  await runImageElementFlow(image);
}

function endActiveImagePickerSession(): void {
  const sessionId = activeImagePickerSessionId;
  clearActiveImagePickerSession();
  if (sessionId) {
    notifyImagePickerEnded(sessionId);
  }
}

function clearActiveImagePickerSession(): void {
  activeImagePickerSessionId = undefined;
  cancelImagePickerOverlay();
}

function cancelImagePickerSession(sessionId: string): void {
  if (activeImagePickerSessionId !== sessionId) {
    return;
  }
  clearActiveImagePickerSession();
}

function notifyImagePickerEnded(sessionId: string): void {
  void sendRequest({ type: "END_IMAGE_PICKER", sessionId }).catch(() => {});
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
      if ("imageUrl" in source && source.imageUrl.startsWith("blob:")) {
        // The background cannot fetch a blob URL owned by this frame.
        const response = await fetch(source.imageUrl);
        const blob = await response.blob();
        const imageUrl = await new Promise<string>((resolve, reject) => {
          // FileReader also handles Firefox's page-owned Blob wrappers.
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
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
    showSourceLanguageToolbar?: boolean;
  } = {},
): void {
  if (activeView === "overlay" && lastRect) {
    showOverlayError({
      rect: lastRect,
      message: error.message,
      onRetry: options.retry,
      onOpenSettings: () => {
        void sendRequest({ type: "OPEN_OPTIONS" });
      },
      showSourceLanguageToolbar: options.showSourceLanguageToolbar,
    });
    return;
  }
  activeView = "panel";
  closeOverlay();
  showError(error, options.retry);
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

// Re-run OCR on the last captured image for a different source language. The
// background also saves it as the default for future captures.
async function runRerecognize(sourceLang: LangCode | "auto"): Promise<void> {
  await requestRunner.run({
    onStart: () => showActiveLoading(),
    request: (requestId) =>
      sendRequest<PipelineResult>({
        type: "RERECOGNIZE_REQUEST",
        requestId,
        sourceLang,
      }),
    onSuccess: (result) => {
      pendingText = result.ocr.text;
      presentResult(result, false);
    },
    onError: (error) => {
      presentError(serializeError(error), {
        retry: () => void runRerecognize(sourceLang),
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
async function loadOcrSourceLanguages(): Promise<string | undefined> {
  try {
    const response =
      await sendRequest<OcrSourceLanguagesResponse>({
        type: "GET_OCR_SOURCE_LANGUAGES",
      });
    if (response && Array.isArray(response.languages)) {
      const languages = response.languages.map(({ id }) => ({
        id,
        label: id === "auto" ? t("commonAuto") : languageName(id),
      }));
      contentControls.ocrSourceLanguages = languages;
      contentControls.currentOcrSourceLanguageId = response.currentId;
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
