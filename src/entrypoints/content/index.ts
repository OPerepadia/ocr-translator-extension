import { browserApi } from "@/shared/browser";
import {
  isOcrTranslateOcrResult,
  isOcrTranslateStatus,
  isStartImageTranslationMessage,
  isStartSelectionMessage,
  serializeError,
} from "@/shared/messages";
import type {
  CaptureSnapshotResponse,
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
  getDisplayMode,
  getOverlayMode,
  type DisplayMode,
} from "@/shared/storage";
import { createRequestId } from "@/shared/request-id";
import { sendRequest } from "@/shared/runtime-messaging";
import {
  closePopup,
  resetForNewCapture,
  setOcrSourceLanguages,
  setOnClose,
  setOnSourceLanguageChange,
  setOnNewSelection,
  setOnProviderChange,
  setOnShowOverlay,
  setOnTargetLangChange,
  setOnTranslateRequest,
  setOverlayAvailable,
  setTargetLanguages,
  setTranslationProviders,
  setUiRoot,
  showError,
  showLoading,
  showRecognizedTextWhileTranslating,
  showResult,
} from "./result-panel";
import {
  closeOverlay,
  isOverlayable,
  setOnOverlayClose,
  setOnOverlayNewSelection,
  setOnOverlayProviderChange,
  setOnOverlaySourceLanguageChange,
  setOnOverlayTargetLangChange,
  setOnShowPanel,
  setOverlayDefaultMode,
  setOverlayOcrSourceLanguages,
  setOverlaySnapshot,
  setOverlayTargetLanguages,
  setOverlayTranslationProviders,
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
import {
  setNavigationContext,
  startNavigationWatch,
} from "./navigation-watch";
import { getRenderedImageRect } from "./overlay-layout";
import "./style.css";

// Request id of the OCR/translate pipeline in flight, so status messages pushed
// from the background update this popup.
let activeRequestId: string | null = null;
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
// Which view is currently on screen, and the default for fresh captures (read
// from Options at the start of each capture).
let activeView: "panel" | "overlay" = "panel";
let displayMode: DisplayMode = "panel";

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

    const ui = await createShadowRootUi(ctx, {
      name: "ocr-translate-ui",
      position: "inline",
      anchor: "body",
      onMount: (container) => {
        uiRoot = container;
        setUiRoot(container);
        setOverlayUiRoot(container);
      },
    });
    ui.mount();

    document.addEventListener(
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

    setOnClose(() => {
      cancelActiveRequest();
      clearCaptureSnapshot();
    });

    setOnNewSelection(() => {
      startNewSelection();
    });

    setOnShowOverlay(() => switchToOverlay());
    setOnShowPanel(() => switchToPanel());

    setOnOverlayNewSelection(() => {
      startNewSelection();
    });
    setOnOverlayClose(() => {
      cancelActiveRequest();
      if (activeView === "overlay") {
        clearCaptureSnapshot();
      }
    });

    setOnTargetLangChange((targetLang) => {
      void runRetranslate(targetLang);
    });
    setOnOverlayTargetLangChange((targetLang) => {
      void runRetranslate(targetLang);
    });

    // Picking a source language re-runs OCR with the matching recognizer. The
    // pick is mirrored to the other view's pill so switching views agrees.
    setOnSourceLanguageChange((sourceLang) => {
      setOverlayOcrSourceLanguages(ocrSourceLanguageList, sourceLang);
      void runRerecognize(sourceLang);
    });
    setOnOverlaySourceLanguageChange((sourceLang) => {
      setOcrSourceLanguages(ocrSourceLanguageList, sourceLang);
      void runRerecognize(sourceLang);
    });

    setOnProviderChange((providerId) => {
      setOverlayTranslationProviders(translationProviderList, providerId);
      void runSwitchProvider(providerId);
    });
    setOnOverlayProviderChange((providerId) => {
      setTranslationProviders(translationProviderList, providerId);
      void runSwitchProvider(providerId);
    });

    setOnTranslateRequest((text, targetLang) => {
      pendingText = text;
      if (targetLang) {
        void runRetranslate(targetLang);
      }
    });

    browserApi.runtime.onMessage.addListener((message) => {
      if (isStartSelectionMessage(message)) {
        closePopup();
        closeOverlay();
        void runSelectionFlow();
        return undefined;
      }
      if (isStartImageTranslationMessage(message)) {
        closePopup();
        closeOverlay();
        void runImageFlow(message.imageUrl);
        return undefined;
      }
      if (
        isOcrTranslateStatus(message) &&
        message.requestId === activeRequestId
      ) {
        // For region captures, the first status means the screenshot is taken,
        // so it is safe to drop the selection's dim — and the pixels the
        // overlay freezes its region on are now available to ask for.
        showActiveLoading(message.status);
        releaseSelectionDim();
        requestCaptureSnapshot();
        return undefined;
      }
      if (
        isOcrTranslateOcrResult(message) &&
        message.requestId === activeRequestId
      ) {
        pendingText = message.ocr.text;
        showActiveOcrResult(message.ocr);
        // The pipeline always reports its OCR result, so the frozen region does
        // not depend on a recognizer that reports no status along the way.
        requestCaptureSnapshot();
        return undefined;
      }
      return undefined;
    });
  },
});

// The panel and overlay are anchored to a region of the page that was on screen
// when the capture ran. A same-document navigation replaces that content while
// our UI stays up, so drop everything and let the in-flight request finish
// unseen.
function closeOnNavigation(): void {
  cancelActiveRequest();
  cancelSelectionOverlay();
  releaseSelectionDim();
  closePopup({ notify: false });
  closeOverlay();
  clearCaptureSnapshot();
  lastResult = undefined;
  lastRect = undefined;
  pendingText = "";
}

// Drops the in-flight request and tells the background to abort it.
function cancelActiveRequest(): void {
  const requestId = activeRequestId;
  activeRequestId = null;
  if (!requestId) {
    return;
  }
  void browserApi.runtime
    .sendMessage({ type: "CANCEL_REQUEST", requestId })
    .catch(() => {});
}

async function runSelectionFlow(): Promise<void> {
  if (!uiRoot) {
    return;
  }
  startNavigationWatch(closeOnNavigation);
  // Preload the OCR worker and model while the user is selecting a region,
  // so recognition can start as soon as the screenshot is ready.
  void sendRequest({ type: "PRELOAD_OCR" }).catch(() => {});

  const viewportRect = await startSelectionOverlay(uiRoot);

  if (!viewportRect) {
    return;
  }

  await runCapture({
    rect: viewportRect,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
  });
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
  startNavigationWatch(closeOnNavigation);
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
  const viewportRect = imageRect ?? ("rect" in source ? source.rect : undefined);
  lastRect = viewportRect ? toPageRect(viewportRect) : undefined;
  lastResult = undefined;
  setOverlayAvailable(false);
  closeOverlay();
  clearCaptureSnapshot();
  displayMode = await getDisplayMode();
  setOverlayDefaultMode(await getOverlayMode());
  // Head toward that view now so the loading spinner lands there; presentResult
  // falls back to the panel later if the result can't be drawn as an overlay.
  activeView = displayMode;

  void loadTargetLanguages();
  void loadOcrSourceLanguages();
  void loadTranslationProviders();

  // A fresh capture has no languages yet; clear the previous result's state so
  // the loading view doesn't show a stale pill that could re-translate old text.
  // The source selection is per-capture, so both pills go back to "auto".
  resetForNewCapture();
  setOverlayOcrSourceLanguages(ocrSourceLanguageList, "auto");
  pendingText = "";

  cancelActiveRequest();
  const requestId = createRequestId();
  activeRequestId = requestId;
  // For region captures, keep the loading panel hidden until the background has
  // taken its screenshot so the panel cannot appear in the captured image.

  try {
    const result = await sendRequest<PipelineResult>({
      type: "OCR_TRANSLATE_REQUEST",
      requestId,
      ...source,
    });

    // Skip if the user closed the popup (or a newer request took over) while
    // OCR was running.
    if (activeRequestId !== requestId) {
      return;
    }
    pendingText = result.ocr.text;
    presentResult(result, true);
  } catch (error) {
    if (activeRequestId !== requestId) {
      return;
    }
    presentError(
      serializeError(error),
      "imageUrl" in source
        ? () => void runImageFlow(source.imageUrl)
        : () => void runRerecognize("auto"),
    );
  } finally {
    if (activeRequestId === requestId) {
      activeRequestId = null;
      releaseSelectionDim();
    }
  }
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
    showOverlayError({ rect: lastRect, message: "No text detected." });
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
      message: status.reason ?? "Translation failed.",
      onRetry:
        targetLang && pendingText
          ? () => void runRetranslate(targetLang)
          : undefined,
      onOpenSettings: () => {
        void sendRequest({ type: "OPEN_OPTIONS" });
      },
    });
    return;
  }

  activeView = "panel";
  closeOverlay();
  showResult(enriched);
}

function presentError(
  error: ReturnType<typeof serializeError>,
  retry?: () => void,
): void {
  if (activeView === "overlay" && lastRect) {
    showOverlayError({
      rect: lastRect,
      message: error.message,
      onRetry: retry,
      onOpenSettings: () => {
        void sendRequest({ type: "OPEN_OPTIONS" });
      },
    });
    return;
  }
  activeView = "panel";
  closeOverlay();
  showError(error, retry);
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
}

async function runRetranslate(targetLang: LangCode): Promise<void> {
  if (!pendingText) {
    return;
  }

  cancelActiveRequest();
  const requestId = createRequestId();
  activeRequestId = requestId;
  showActiveLoading({ stage: "translating" });

  try {
    const result = await sendRequest<PipelineResult>({
      type: "RETRANSLATE_REQUEST",
      requestId,
      text: pendingText,
      targetLang,
    });

    if (activeRequestId !== requestId) {
      return;
    }
    presentResult(result, false);
  } catch (error) {
    if (activeRequestId !== requestId) {
      return;
    }
    presentError(serializeError(error), () => void runRetranslate(targetLang));
  } finally {
    if (activeRequestId === requestId) {
      activeRequestId = null;
    }
  }
}

// Re-run OCR on the last captured image for a different source language. The
// background chooses the recognizer for the current capture only.
async function runRerecognize(sourceLang: LangCode | "auto"): Promise<void> {
  cancelActiveRequest();
  const requestId = createRequestId();
  activeRequestId = requestId;
  showActiveLoading();

  try {
    const result = await sendRequest<PipelineResult>({
      type: "RERECOGNIZE_REQUEST",
      requestId,
      sourceLang,
    });

    if (activeRequestId !== requestId) {
      return;
    }
    pendingText = result.ocr.text;
    presentResult(result, false);
  } catch (error) {
    if (activeRequestId !== requestId) {
      return;
    }
    presentError(
      serializeError(error),
      () => void runRerecognize(sourceLang),
    );
  } finally {
    if (activeRequestId === requestId) {
      activeRequestId = null;
    }
  }
}

// Switch the translation provider (picked in the panel) and re-translate the
// current recognized text with it. The background persists the new provider as
// the default. Different providers support different target languages, so the
// target-language list is refreshed before the result is shown.
async function runSwitchProvider(providerId: string): Promise<void> {
  if (!pendingText) {
    return;
  }

  cancelActiveRequest();
  const requestId = createRequestId();
  activeRequestId = requestId;
  showActiveLoading({ stage: "translating" });

  try {
    const result = await sendRequest<PipelineResult>({
      type: "SWITCH_PROVIDER_REQUEST",
      requestId,
      providerId,
      text: pendingText,
    });

    if (activeRequestId !== requestId) {
      return;
    }
    // The new provider may translate into a different set of languages, so
    // refresh the list the target-language pill offers before rendering. Re-check
    // afterward in case a new capture superseded this switch during the fetch.
    await loadTargetLanguages(true);
    if (activeRequestId !== requestId) {
      return;
    }
    presentResult(result, false);
  } catch (error) {
    if (activeRequestId !== requestId) {
      return;
    }
    presentError(serializeError(error));
  } finally {
    if (activeRequestId === requestId) {
      activeRequestId = null;
    }
  }
}

// Fetch the supported OCR source languages once and hand them to both views.
// The list is kept so a pick in one view can be mirrored to the other's pill.
let ocrSourceLanguagesLoaded = false;
let ocrSourceLanguageList: Array<{ id: string; label: string }> = [];
async function loadOcrSourceLanguages(): Promise<void> {
  if (ocrSourceLanguagesLoaded) {
    return;
  }
  try {
    const response =
      await sendRequest<OcrSourceLanguagesResponse>({
        type: "GET_OCR_SOURCE_LANGUAGES",
      });
    if (response && Array.isArray(response.languages)) {
      ocrSourceLanguagesLoaded = true;
      ocrSourceLanguageList = response.languages;
      setOcrSourceLanguages(response.languages, response.currentId);
      setOverlayOcrSourceLanguages(response.languages, response.currentId);
    }
  } catch {
    // Leave the list empty; the picker won't show.
  }
}

// Fetch the recognizer-independent translation providers once and hand them
// (with the current selection) to the popup so its picker can offer choices.
let translationProvidersLoaded = false;
let translationProviderList: Array<{ id: string; label: string }> = [];
async function loadTranslationProviders(): Promise<void> {
  if (translationProvidersLoaded) {
    return;
  }
  try {
    const response =
      await sendRequest<TranslationProvidersResponse>({
        type: "GET_TRANSLATION_PROVIDERS",
      });
    if (response && Array.isArray(response.providers)) {
      translationProvidersLoaded = true;
      translationProviderList = response.providers;
      setTranslationProviders(response.providers, response.currentId);
      setOverlayTranslationProviders(response.providers, response.currentId);
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
      setTargetLanguages(languages);
      setOverlayTargetLanguages(languages);
    }
  } catch {
    // Leave the list empty; the pill falls back to the current target only.
  }
}
