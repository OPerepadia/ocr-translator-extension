import { browserApi } from "@/shared/browser";
import {
  isOcrTranslateOcrResult,
  isOcrTranslateStatus,
  isStartImageTranslationMessage,
  isStartSelectionMessage,
  serializeError,
} from "@/shared/messages";
import type {
  OcrImageSource,
  OcrSourceLanguagesResponse,
  TranslationProvidersResponse,
} from "@/shared/messages";
import type {
  LangCode,
  PipelineOcrResult,
  PipelineResult,
  PipelineStatus,
  Rect,
} from "@/shared/types";
import {
  getDisplayMode,
  getOverlayShowOriginal,
  type DisplayMode,
} from "@/shared/storage";
import { createRequestId } from "@/shared/request-id";
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
  setOnOverlaySourceLanguageChange,
  setOnOverlayTargetLangChange,
  setOnShowPanel,
  setOverlayDefaultMode,
  setOverlayOcrSourceLanguages,
  setOverlayTargetLanguages,
  setOverlayUiRoot,
  showOverlay,
  showOverlayError,
  showOverlayLoading,
} from "./overlay";
import {
  releaseSelectionDim,
  startSelectionOverlay,
} from "./selection-overlay";
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

    // Closing the popup drops the in-flight id so late status messages and the
    // eventual result no longer reopen it.
    setOnClose(() => {
      activeRequestId = null;
    });

    // "Select new region" in the popup menu restarts the capture.
    setOnNewSelection(() => {
      startNewSelection();
    });

    // The "Show as overlay" / "Show panel" buttons switch the current result
    // between the two views for this result only; the default for fresh captures
    // is set in Options.
    setOnShowOverlay(() => switchToOverlay());
    setOnShowPanel(() => switchToPanel());

    // The overlay's "Select new region" restarts the capture; closing it drops
    // the in-flight ids like the panel does.
    setOnOverlayNewSelection(() => {
      startNewSelection();
    });
    setOnOverlayClose(() => {
      activeRequestId = null;
    });

    // Changing the target language in the popup re-translates the same text.
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

    // Picking a different translation provider re-translates the current text.
    setOnProviderChange((providerId) => {
      void runSwitchProvider(providerId);
    });

    // The Translate button re-translates the edited recognized text into the
    // current target language.
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
        // so it is safe to drop the selection's dim.
        showActiveLoading(message.status);
        releaseSelectionDim();
        return undefined;
      }
      if (
        isOcrTranslateOcrResult(message) &&
        message.requestId === activeRequestId
      ) {
        pendingText = message.ocr.text;
        showActiveOcrResult(message.ocr);
        return undefined;
      }
      return undefined;
    });
  },
});

async function runSelectionFlow(): Promise<void> {
  if (!uiRoot) {
    return;
  }
  // Preload the OCR worker and model while the user is selecting a region,
  // so recognition can start as soon as the screenshot is ready.
  void browserApi.runtime.sendMessage({ type: "PRELOAD_OCR" }).catch(() => {});

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
  void browserApi.runtime.sendMessage({ type: "START_SELECTION" });
}

async function runImageFlow(imageUrl: string): Promise<void> {
  void browserApi.runtime.sendMessage({ type: "PRELOAD_OCR" }).catch(() => {});

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
  // A previous overlay (if any) is for a stale region; clear it before this run.
  closeOverlay();
  // Re-read the default view so a change made in Options this session is honored.
  displayMode = await getDisplayMode();
  setOverlayDefaultMode(
    (await getOverlayShowOriginal()) ? "original" : "translation",
  );
  // Head toward that view now so the loading spinner lands there; presentResult
  // falls back to the panel later if the result can't be drawn as an overlay.
  activeView = displayMode;

  // Load the target-language list, OCR source languages, and translation providers
  // (once each) so the popup pills can offer choices.
  void loadTargetLanguages();
  void loadOcrSourceLanguages();
  void loadTranslationProviders();

  // A fresh capture has no languages yet; clear the previous result's state so
  // the loading view doesn't show a stale pill that could re-translate old text.
  // The source selection is per-capture, so both pills go back to "auto".
  resetForNewCapture();
  setOverlayOcrSourceLanguages(ocrSourceLanguageList, "auto");
  pendingText = "";

  const requestId = createRequestId();
  activeRequestId = requestId;
  // For region captures, keep the loading panel hidden until the background has
  // taken its screenshot so the panel cannot appear in the captured image.

  try {
    const result = await browserApi.runtime.sendMessage<PipelineResult>({
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
    showOverlay({ result: enriched, rect: lastRect });
    return;
  }

  if (wantOverlay && lastRect && !enriched.ocr.text.trim()) {
    activeView = "overlay";
    closePopup({ notify: false });
    showOverlayError({ rect: lastRect, message: "No text detected." });
    return;
  }

  // A failed translation has no overlay text, but bouncing to the corner panel
  // is jarring in overlay mode; show the failure over the region instead.
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
        void browserApi.runtime.sendMessage({ type: "OPEN_OPTIONS" });
      },
    });
    return;
  }

  activeView = "panel";
  closeOverlay();
  showResult(enriched);
}

// Show a pipeline error in the current view: a chip over the region in overlay
// mode (with Retry when the failed step can be re-run), otherwise the panel.
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
        void browserApi.runtime.sendMessage({ type: "OPEN_OPTIONS" });
      },
    });
    return;
  }
  activeView = "panel";
  closeOverlay();
  showError(error, retry);
}

// Route the loading spinner to wherever the current view lives: over the region
// in overlay mode, otherwise the corner panel. Re-translate/re-recognize run from
// the panel, so activeView is "panel" then and they keep showing it there.
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

function toPageRect(rect: Rect): Rect {
  return {
    x: rect.x + window.scrollX,
    y: rect.y + window.scrollY,
    width: rect.width,
    height: rect.height,
  };
}

// Switch the current result from the panel to the overlay. Only changes the view
// for this result; the default for fresh captures stays as set in Options. No-op
// if there is nothing overlayable to show.
function switchToOverlay(): void {
  if (!lastResult || !lastRect || !isOverlayable(lastResult)) {
    return;
  }
  activeView = "overlay";
  closePopup({ notify: false });
  showOverlay({ result: lastResult, rect: lastRect });
}

// Switch the current result from the overlay back to the panel. Only changes the
// view for this result; the default for fresh captures stays as set in Options.
function switchToPanel(): void {
  if (!lastResult) {
    return;
  }
  activeView = "panel";
  closeOverlay();
  setOverlayAvailable(isOverlayable(lastResult) && Boolean(lastRect));
  showResult(lastResult);
}

// Re-translate the current recognized text into a new target language, chosen
// from the popup's language pill. The background persists the new default.
async function runRetranslate(targetLang: LangCode): Promise<void> {
  if (!pendingText) {
    return;
  }

  const requestId = createRequestId();
  activeRequestId = requestId;
  showActiveLoading({ stage: "translating" });

  try {
    const result = await browserApi.runtime.sendMessage<PipelineResult>({
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
  const requestId = createRequestId();
  activeRequestId = requestId;
  showActiveLoading();

  try {
    const result = await browserApi.runtime.sendMessage<PipelineResult>({
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

  const requestId = createRequestId();
  activeRequestId = requestId;
  showActiveLoading({ stage: "translating" });

  try {
    const result = await browserApi.runtime.sendMessage<PipelineResult>({
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
      await browserApi.runtime.sendMessage<OcrSourceLanguagesResponse>({
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
async function loadTranslationProviders(): Promise<void> {
  if (translationProvidersLoaded) {
    return;
  }
  try {
    const response =
      await browserApi.runtime.sendMessage<TranslationProvidersResponse>({
        type: "GET_TRANSLATION_PROVIDERS",
      });
    if (response && Array.isArray(response.providers)) {
      translationProvidersLoaded = true;
      setTranslationProviders(response.providers, response.currentId);
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
    const languages = await browserApi.runtime.sendMessage<LangCode[]>({
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
