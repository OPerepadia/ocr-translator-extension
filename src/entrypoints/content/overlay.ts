import { sendRequest } from "../../shared/runtime-messaging";
import type { LangCode, PipelineResult, PipelineStatus, Rect } from "@/shared/types";
import { t } from "@/shared/i18n";
import {
  CHECK_ICON,
  CLOSE_ICON,
  COPY_ICON,
  MENU_ICON,
  RETRANSLATE_ICON,
  SELECT_REGION_ICON,
  SETTINGS_ICON,
  SPEAK_ICON,
  STOP_SPEAK_ICON,
  TRANSLATE_ICON,
  WARNING_ICON,
} from "./icons";
import { setOverlayMode } from "../../shared/storage";
import { createLanguagePill } from "./language-picker";
import { createOptionPicker } from "./option-picker";
import {
  pipelineStatusMessage,
  pipelineStatusProgress,
} from "./pipeline-status";
import {
  buildOverlayLayout,
  moveOverlayLayout,
  rotatedBounds,
  type OverlayLayout,
  type OverlayLine,
} from "./overlay-layout";
import { isSpeaking, requestSpeak, stopSpeaking } from "./tts";
import type { ContentControls } from "./content-controls";

type OverlayMode = "translation" | "original";
export interface OverlayConfig {
  controls: ContentControls;
  onClose(): void;
  onShowPanel(): void;
  onNewSelection(): void;
}
const OVERLAY_SPEECH_OWNER = "overlay";

const PANEL_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
  '<rect x="4" y="4" width="16" height="16" rx="2.4" stroke="currentColor" stroke-width="1.8"/>' +
  '<path d="M8.5 8.5L13.5 13.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
  '<path d="M13.5 10.3V13.5H10.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<rect x="14.5" y="14.5" width="5" height="5" rx="1.2" fill="currentColor"/>' +
  "</svg>";

let uiRoot: HTMLElement | undefined;
let container: HTMLElement | undefined;
let toolbar: HTMLElement | undefined;
let modeButton: HTMLButtonElement | undefined;
let boxes: HTMLElement[] = [];
let boxRects: Rect[] = [];
let boxAngles: number[] = [];
let boxContents: Array<{ original: string; translated: string }> = [];
type PopoverView = {
  el: HTMLElement;
  body?: HTMLElement;
  boxIndex: number;
  speechButtons: Partial<Record<OverlayMode, HTMLButtonElement>>;
};
let activePopover: PopoverView | undefined;
let popoverEl: HTMLElement | undefined;
let regionBackdrop: HTMLElement | undefined;
let regionFrame: HTMLElement | undefined;
// The captured pixels, painted under the boxes so the overlay keeps sitting on
// the image it was built from. Without it the boxes are left over whatever the
// page paints next, which for animated content is something else entirely.
let regionSnapshot: HTMLCanvasElement | undefined;
let currentSnapshot: ImageBitmap | undefined;
// The loading spinner shown over the region while OCR/translation runs, and a
// patcher for its label and progress bar, kept so repeated status updates don't
// restart the spinner animation.
let statusChip: HTMLElement | undefined;
let updateLoadingChip: ((status: PipelineStatus) => void) | undefined;
let currentTranslationError:
  | {
      message: string;
      onRetry?: () => void;
    }
  | undefined;

let currentLayout: OverlayLayout | undefined;
let currentRect: Rect | undefined;
// Which view the boxes are in. "translation" paints the translated text over
// the image, the way a dub replaces the original; "original" leaves the image
// alone behind transparent frames, and the text is read from the popover and
// selected off the picture itself.
let mode: OverlayMode = "translation";
let defaultMode: OverlayMode = "translation";
let hasTranslationText = false;
let currentOriginalText = "";
let currentDisplayText = "";
let currentSourceLang: LangCode | undefined;
let currentTargetLang: LangCode | undefined;
let config: OverlayConfig | undefined;

let keydownHandler: ((event: KeyboardEvent) => void) | undefined;
let resizeHandler: (() => void) | undefined;
let scrollHandler: (() => void) | undefined;
let controlDisposers: Array<() => void> = [];
let anchor:
  | {
      element: Element;
      x: number;
      y: number;
    }
  | undefined;

// Smallest/largest font the auto-fit will use inside a painted box.
const MIN_FONT_PX = 12;
const MAX_FONT_PX_HORIZONTAL_SOURCE = 24;
const MAX_FONT_PX_VERTICAL_SOURCE = 18;
// How far past its frame a panel may spill, in fractions of a line, so a last
// line that only just misses is kept rather than dropped. The frame is only an
// approximate OCR box, so a slight overhang beats losing a line.
const CLAMP_SPILL_LINES = 0.35;

export function setOverlayUiRoot(root: HTMLElement): void {
  uiRoot = root;
}

/** Freeze the region on the pixels the capture was recognized from, so a page
 * that repaints underneath (an animated banner, a carousel, a video) cannot
 * leave the boxes over unrelated content. Applies to whatever is on screen and
 * to every later render, until cleared with undefined. The caller owns the
 * bitmap and must clear it here before closing it. */
export function setOverlaySnapshot(snapshot: ImageBitmap | undefined): void {
  currentSnapshot = snapshot;
  refreshRegionSnapshot();
}

export function setOverlayDefaultMode(nextMode: OverlayMode): void {
  defaultMode = nextMode;
}

export function configureOverlay(nextConfig: OverlayConfig): void {
  config = nextConfig;
}

/** The text used to build the overlay. Failed translations fall back to the
 * recognized text so the source boxes and toolbar remain available. */
export function overlayDisplayText(result: PipelineResult): string | undefined {
  if (result.translation) {
    return result.translation.text;
  }
  if (
    result.translationStatus.state === "same_language" ||
    result.translationStatus.state === "failed"
  ) {
    return result.ocr.text;
  }
  return undefined;
}

/** Whether a result can be drawn as an overlay: it has display text, detected
 * blocks, and the recognized image size to map them with. */
export function isOverlayable(result: PipelineResult): boolean {
  return Boolean(
    overlayDisplayText(result) !== undefined &&
      result.ocr.blocks &&
      result.ocr.blocks.length > 0 &&
      result.ocr.imageWidth &&
      result.ocr.imageHeight,
  );
}

export function overlayTargetLanguage(
  result: PipelineResult,
): LangCode | undefined {
  return (
    result.translation?.targetLang ??
    result.translationStatus.targetLang
  );
}

export function showOverlay(args: {
  result: PipelineResult;
  rect: Rect;
  onRetryTranslation?: () => void;
}): void {
  const { result, rect } = args;
  const displayText = overlayDisplayText(result);
  if (displayText === undefined || !result.ocr.blocks) {
    return;
  }
  if (isSpeaking(OVERLAY_SPEECH_OWNER)) {
    stopSpeaking();
  }

  currentRect = rect;
  hasTranslationText = Boolean(result.translation?.text);
  currentOriginalText = result.ocr.text;
  currentDisplayText = displayText;
  const sourceLanguageId = config?.controls.currentOcrSourceLanguageId;
  currentSourceLang =
    result.translation?.sourceLang ??
    result.ocr.lang ??
    result.translationStatus.sourceLang ??
    (sourceLanguageId !== "auto" ? sourceLanguageId : undefined);
  currentTargetLang = overlayTargetLanguage(result);
  currentTranslationError =
    result.translationStatus.state === "failed"
      ? {
          message:
            result.translationStatus.reason ?? t("commonTranslationFailed"),
          onRetry: args.onRetryTranslation,
        }
      : undefined;
  captureAnchor();
  currentLayout = buildOverlayLayout({
    ocrText: result.ocr.text,
    translationText: displayText,
    blocks: result.ocr.blocks,
    imageWidth: result.ocr.imageWidth ?? rect.width,
    imageHeight: result.ocr.imageHeight ?? rect.height,
    rect,
    orientation: result.ocr.orientation,
  });
  mode = hasTranslationText ? defaultMode : "original";

  render();
}

export function showOverlayLoading(
  rect: Rect,
  status: PipelineStatus = { stage: "recognizing" },
): void {
  currentRect = rect;

  if (container && updateLoadingChip) {
    updateLoadingChip(status);
    reposition();
    return;
  }

  captureAnchor();
  renderLoading(status);
}

export function showOverlayError(args: {
  rect: Rect;
  message: string;
  onRetry?: () => void;
  onOpenSettings?: () => void;
}): void {
  currentRect = args.rect;
  captureAnchor();
  // Unlike the loading chip, there's nothing to patch in place; drop the stale
  // patcher so a later showOverlayLoading rebuilds instead of patching it.
  updateLoadingChip = undefined;
  mountChip(createErrorChip(args));
}

export function closeOverlay(): void {
  if (isSpeaking(OVERLAY_SPEECH_OWNER)) {
    stopSpeaking();
  }
  if (!container) {
    return;
  }
  const closingContainer = container;
  const closingToolbar = toolbar;
  if (keydownHandler) {
    document.removeEventListener("keydown", keydownHandler, true);
    keydownHandler = undefined;
  }
  if (resizeHandler) {
    window.removeEventListener("resize", resizeHandler);
    resizeHandler = undefined;
  }
  if (scrollHandler) {
    window.removeEventListener("scroll", scrollHandler);
    scrollHandler = undefined;
  }
  clearOutsideClickHandlers();
  container = undefined;
  toolbar = undefined;
  modeButton = undefined;
  boxes = [];
  boxRects = [];
  boxAngles = [];
  boxContents = [];
  teardownPopover();
  regionBackdrop = undefined;
  regionFrame = undefined;
  regionSnapshot = undefined;
  statusChip = undefined;
  updateLoadingChip = undefined;
  currentLayout = undefined;
  currentRect = undefined;
  hasTranslationText = false;
  currentOriginalText = "";
  currentDisplayText = "";
  currentSourceLang = undefined;
  currentTargetLang = undefined;
  currentTranslationError = undefined;
  anchor = undefined;
  config?.onClose();

  if (!closingToolbar) {
    closingContainer.remove();
    return;
  }

  closingContainer.replaceChildren(closingToolbar);
  closingToolbar.classList.add("is-closing");
  const animations = closingToolbar.getAnimations();
  if (animations.length === 0) {
    closingContainer.remove();
    return;
  }
  const remove = (): void => closingContainer.remove();
  void Promise.all(animations.map((animation) => animation.finished)).then(
    remove,
    remove,
  );
}

function render(): void {
  // Rebuild from scratch so a re-translate clears the busy state cleanly.
  clearOutsideClickHandlers();
  if (container) {
    container.remove();
  }

  container = document.createElement("div");
  container.className = "ocr-translate-overlay";

  // A settled result replaces any loading spinner. The popover is a child of the
  // old container, so drop the stale reference; it's recreated when next opened.
  statusChip = undefined;
  updateLoadingChip = undefined;
  teardownPopover();

  renderRegionLayers();
  toolbar = createToolbar();
  container.append(toolbar);
  if (currentTranslationError) {
    statusChip = createErrorChip({
      ...currentTranslationError,
      onOpenSettings: openSettings,
      onDismiss: dismissTranslationError,
    });
    statusChip.classList.add("is-result-error");
    container.append(statusChip);
  }

  (uiRoot ?? document.documentElement).append(container);
  renderBoxes();
  positionToolbar();
  if (statusChip) {
    positionChip(statusChip);
  }
  ensureGlobalHandlers();
}

function renderLoading(status: PipelineStatus): void {
  mountChip(createLoadingChip(status));
}

function mountChip(chip: HTMLElement): void {
  if (isSpeaking(OVERLAY_SPEECH_OWNER)) {
    stopSpeaking();
  }
  if (container) {
    container.remove();
  }
  boxes = [];
  boxRects = [];
  boxAngles = [];
  boxContents = [];
  teardownPopover();
  toolbar = undefined;
  modeButton = undefined;
  clearOutsideClickHandlers();
  currentLayout = undefined;
  currentTranslationError = undefined;

  container = document.createElement("div");
  container.className = "ocr-translate-overlay";
  renderRegionLayers();

  statusChip = chip;
  container.append(statusChip);

  (uiRoot ?? document.documentElement).append(container);
  positionChip(statusChip);
  ensureGlobalHandlers();
}

function ensureGlobalHandlers(): void {
  if (!keydownHandler) {
    keydownHandler = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeOverlay();
      }
    };
    document.addEventListener("keydown", keydownHandler, true);
  }
  if (!resizeHandler) {
    resizeHandler = (): void => {
      updateAnchor();
      reposition();
    };
    window.addEventListener("resize", resizeHandler);
  }
  if (!scrollHandler) {
    scrollHandler = (): void => reposition();
    window.addEventListener("scroll", scrollHandler, { passive: true });
  }
}

function reposition(): void {
  if (regionSnapshot && currentRect) {
    positionRectElement(regionSnapshot, currentRect);
  }
  if (regionBackdrop && currentRect) {
    positionRectElement(regionBackdrop, currentRect);
  }
  if (regionFrame && currentRect) {
    positionRectElement(regionFrame, currentRect);
  }
  boxes.forEach((box, index) => {
    const rect = boxRects[index];
    if (rect) {
      positionRectElement(box, rect);
    }
  });
  if (toolbar) {
    positionToolbar();
  }
  if (statusChip) {
    positionChip(statusChip);
  }
  positionPopover();
}

function clearOutsideClickHandlers(): void {
  for (const disposeControl of controlDisposers) {
    disposeControl();
  }
  controlDisposers = [];
}

function createToolbar(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "ocr-translate-overlay-toolbar";

  const modeButtonWrapper = document.createElement("span");
  modeButtonWrapper.className = "ocr-translate-overlay-mode-button-wrap";
  if (!hasTranslationText) {
    modeButtonWrapper.title = currentTranslationError
      ? t("overlayTranslationUnavailable")
      : t("overlayAlreadyInTargetLanguage");
  }
  modeButtonWrapper.append(createModeButton());

  const sourcePicker = createSourceLanguagePicker();
  const languagePicker = createLanguagePicker();
  const providerPicker = createProviderPicker();
  const retranslateButton = createRetranslateButton();
  const menu = createMenu();
  controlDisposers.push(menu.dispose);
  const selectButton = iconButton(
    SELECT_REGION_ICON,
    t("panelSelectNewRegion"),
    () => {
      closeOverlay();
      config?.onNewSelection();
    },
  );
  const closeButton = iconButton(CLOSE_ICON, t("commonClose"), () => {
    closeOverlay();
  });
  closeButton.classList.add("ocr-translate-overlay-close");

  const divider = document.createElement("span");
  divider.className = "ocr-translate-overlay-divider";
  divider.setAttribute("aria-hidden", "true");

  if (sourcePicker) {
    bar.append(sourcePicker);
  }
  if (sourcePicker && languagePicker) {
    const direction = document.createElement("span");
    direction.className = "ocr-translate-overlay-direction";
    direction.setAttribute("aria-hidden", "true");
    direction.textContent = "→";
    bar.append(direction);
  }
  if (languagePicker) {
    bar.append(languagePicker);
  }
  if (providerPicker) {
    bar.append(providerPicker);
  }
  bar.append(retranslateButton);
  bar.append(modeButtonWrapper);
  bar.append(selectButton, menu.element, divider, closeButton);
  return bar;
}

function createRetranslateButton(): HTMLButtonElement {
  const button = iconButton(RETRANSLATE_ICON, t("commonTranslateAgain"), () => {
    if (currentTargetLang) {
      config?.controls.selectTargetLanguage(currentTargetLang);
    }
  });
  button.disabled = !hasTranslationText || !currentTargetLang || !config;
  return button;
}

function createModeButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className =
    "ocr-translate-overlay-icon-button ocr-translate-overlay-mode-button";
  button.disabled = !hasTranslationText;
  button.innerHTML = TRANSLATE_ICON;
  modeButton = button;
  updateModeButton();

  // Both views are built from the same toolbar, so only the boxes and the
  // button's own state changes; rebuilding the bar would replay its entry
  // animation on every flip.
  button.addEventListener("click", () => {
    if (isSpeaking(OVERLAY_SPEECH_OWNER)) {
      stopSpeaking();
    }
    mode = mode === "translation" ? "original" : "translation";
    defaultMode = mode;
    void setOverlayMode(mode);
    renderBoxes();
    updateModeButton();
  });

  return button;
}

function updateModeButton(): void {
  if (!modeButton) {
    return;
  }
  const showingTranslation = mode === "translation";
  const label = t("overlayToggleTranslation");
  modeButton.setAttribute("aria-pressed", String(showingTranslation));
  modeButton.setAttribute("aria-label", label);
  if (hasTranslationText) {
    modeButton.title = label;
  }
}

function createMenu(): {
  element: HTMLElement;
  dispose: () => void;
} {
  const wrapper = document.createElement("div");
  wrapper.className = "ocr-translate-popup-menu ocr-translate-overlay-menu";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "ocr-translate-overlay-icon-button";
  button.setAttribute("aria-label", t("commonMenu"));
  button.setAttribute("aria-haspopup", "true");
  button.setAttribute("aria-expanded", "false");
  button.title = t("commonMenu");
  button.innerHTML = MENU_ICON;

  const list = document.createElement("div");
  list.className = "ocr-translate-popup-menu-list";
  list.setAttribute("role", "menu");
  list.hidden = true;

  function closeMenu(): void {
    list.hidden = true;
    wrapper.classList.remove("is-open-above");
    button.setAttribute("aria-expanded", "false");
  }

  function addItem(
    iconMarkup: string,
    labelText: string,
    onSelect: () => void,
  ): void {
    const entry = document.createElement("button");
    entry.type = "button";
    entry.className = "ocr-translate-popup-menu-item";
    entry.setAttribute("role", "menuitem");

    const icon = document.createElement("span");
    icon.className = "ocr-translate-popup-menu-icon";
    icon.innerHTML = iconMarkup;

    const label = document.createElement("span");
    label.textContent = labelText;

    entry.append(icon, label);
    entry.addEventListener("click", () => {
      closeMenu();
      void onSelect();
    });
    list.append(entry);
  }

  if (hasTranslationText) {
    addItem(COPY_ICON, t("overlayCopyAllOriginal"), () => {
      void copyAllText(currentOriginalText);
    });
    addItem(COPY_ICON, t("overlayCopyAllTranslated"), () => {
      void copyAllText(currentDisplayText);
    });
    addItem(SPEAK_ICON, t("overlayReadAllOriginal"), () => {
      speakAll("original");
    });
    addItem(SPEAK_ICON, t("overlayReadAllTranslated"), () => {
      speakAll("translation");
    });
  } else {
    addItem(COPY_ICON, t("overlayCopyAllText"), () => {
      void copyAllText(currentOriginalText);
    });
    addItem(SPEAK_ICON, t("overlayReadAllText"), () => {
      speakAll("original");
    });
  }
  addItem(PANEL_ICON, t("overlayShowInPanel"), () => config?.onShowPanel());
  addItem(SETTINGS_ICON, t("commonSettings"), openSettings);

  button.addEventListener("click", () => {
    const open = list.hidden;
    list.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    wrapper.classList.remove("is-open-above");
    if (open && list.getBoundingClientRect().bottom > window.innerHeight - 8) {
      wrapper.classList.add("is-open-above");
    }
  });

  function handleOutsideClick(event: MouseEvent): void {
    if (!list.hidden && !event.composedPath().includes(wrapper)) {
      closeMenu();
    }
  }
  document.addEventListener("click", handleOutsideClick);

  wrapper.append(button, list);
  return {
    element: wrapper,
    dispose: () => document.removeEventListener("click", handleOutsideClick),
  };
}

function openSettings(): void {
  void sendRequest({ type: "OPEN_OPTIONS" });
}

function dismissTranslationError(): void {
  if (!statusChip?.classList.contains("is-result-error")) {
    return;
  }
  statusChip.remove();
  statusChip = undefined;
}

async function copyAllText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return;
  }
}

function speakAll(target: OverlayMode): void {
  if (isSpeaking(OVERLAY_SPEECH_OWNER)) {
    const wasTarget =
      speakingTarget === target && speakingBoxIndex === undefined;
    stopSpeaking();
    if (wasTarget) {
      return;
    }
  }

  requestSpeak({
    text: target === "original" ? currentOriginalText : currentDisplayText,
    lang: modeLang(target),
    owner: OVERLAY_SPEECH_OWNER,
    onStart: () => {
      setPopoverSpeakState(true, target);
    },
    onEnd: () => {
      setPopoverSpeakState(false);
    },
  });
}

function createSourceLanguagePicker(): HTMLElement | undefined {
  const controls = config?.controls;
  if (!controls || controls.ocrSourceLanguages.length < 2) {
    return undefined;
  }
  const pill = createLanguagePill({
    target: controls.currentOcrSourceLanguageId,
    languages: controls.ocrSourceLanguages
      .map(({ id }) => id)
      .filter((id) => id !== "auto"),
    specialEntries: [
      {
        code: "auto",
        name:
          controls.ocrSourceLanguages.find(({ id }) => id === "auto")?.label ??
          t("commonAuto"),
      },
    ],
    position: "auto",
    title: (name) => t("panelSourceLanguage", name),
    onChange: controls.selectOcrSourceLanguage,
  });
  controlDisposers.push(pill.dispose);
  return pill.element;
}

function createLanguagePicker(): HTMLElement | undefined {
  const controls = config?.controls;
  if (!controls || !currentTargetLang) {
    return undefined;
  }

  const pill = createLanguagePill({
    target: currentTargetLang,
    languages: controls.targetLanguages,
    position: "auto",
    onChange: (targetLang) => {
      if (targetLang !== currentTargetLang) {
        currentTargetLang = targetLang;
        controls.selectTargetLanguage(targetLang);
      }
    },
  });
  controlDisposers.push(pill.dispose);
  return pill.element;
}

function createProviderPicker(): HTMLElement | undefined {
  const controls = config?.controls;
  if (!controls) {
    return undefined;
  }
  const picker = createOptionPicker({
    options: controls.translationProviders,
    currentId: controls.currentTranslationProviderId,
    overlay: true,
    title: (current) => t("panelTranslationProvider", current.label),
    onSelect: controls.selectTranslationProvider,
  });
  if (!picker) {
    return undefined;
  }
  controlDisposers.push(picker.dispose);
  return picker.element;
}

function renderBoxes(): void {
  if (!container || !currentLayout) {
    return;
  }
  for (const box of boxes) {
    box.remove();
  }
  boxes = [];
  boxRects = [];
  boxAngles = [];
  boxContents = [];
  hidePopover();

  if (mode === "translation") {
    renderTranslationBoxes(currentLayout, container);
  } else {
    renderSourceBoxes(currentLayout, container);
  }
  applyBoxAngles();
}

// Tilts go on last, after every box has been fitted. `fitTextLayers` measures
// with getBoundingClientRect, which reports the wider bounds a rotated element
// covers rather than the box itself, and would size the spans to those.
function applyBoxAngles(): void {
  boxes.forEach((box, index) => {
    const angle = boxAngles[index] ?? 0;
    if (angle !== 0) {
      box.style.transform = `rotate(${angle}rad)`;
    }
  });
}

function renderTranslationBoxes(
  layout: OverlayLayout,
  overlayContainer: HTMLElement,
): void {
  const verticalBoxes: boolean[] = [];
  // Without a per-paragraph split, one combined box, so the whole translation is
  // never misattributed to a single region.
  if (!layout.segmented) {
    const box = createTranslationBox(
      layout.combinedRect,
      layout.combinedTranslation,
      0,
    );
    overlayContainer.append(box);
    boxes.push(box);
    verticalBoxes.push(
      layout.paragraphs.length > 0 &&
        layout.paragraphs.every((paragraph) => paragraph.vertical),
    );
    boxRects.push(layout.combinedRect);
    boxAngles.push(0);
    boxContents.push({
      original: currentOriginalText,
      translated: layout.combinedTranslation,
    });
  } else {
    layout.paragraphs.forEach((paragraph, index) => {
      const box = createTranslationBox(
        paragraph.translationRect,
        paragraph.translated ?? "",
        index,
      );
      overlayContainer.append(box);
      boxes.push(box);
      verticalBoxes.push(paragraph.vertical);
      boxRects.push(paragraph.translationRect);
      boxAngles.push(paragraph.angle);
      boxContents.push({
        original: paragraph.original,
        translated: paragraph.translated ?? "",
      });
    });
  }

  boxes.forEach((box, index) => {
    fitFontSize(box, verticalBoxes[index]);
  });
}

function renderSourceBoxes(
  layout: OverlayLayout,
  overlayContainer: HTMLElement,
): void {
  if (hasTranslationText && !layout.segmented) {
    const box = createBox(
      layout.combinedSourceRect,
      currentOriginalText,
      layout.paragraphs.flatMap((paragraph) => paragraph.lines),
      0,
      0,
    );
    overlayContainer.append(box);
    boxes.push(box);
    boxRects.push(layout.combinedSourceRect);
    boxAngles.push(0);
    boxContents.push({
      original: currentOriginalText,
      translated: layout.combinedTranslation,
    });
  } else {
    layout.paragraphs.forEach((paragraph, index) => {
      const rect = paragraph.sourceRect;
      const box = createBox(
        rect,
        paragraph.original,
        paragraph.lines,
        index,
        paragraph.angle,
      );
      overlayContainer.append(box);
      boxes.push(box);
      boxRects.push(rect);
      boxAngles.push(paragraph.angle);
      boxContents.push({
        original: paragraph.original,
        translated: paragraph.translated ?? "",
      });
    });
  }
  fitTextLayers();
}

function createTranslationBox(
  rect: Rect,
  text: string,
  index: number,
): HTMLElement {
  const box = document.createElement("div");
  box.className =
    "ocr-translate-overlay-box ocr-translate-overlay-translation-box";
  box.tabIndex = 0;
  box.setAttribute("role", "button");
  box.setAttribute("aria-haspopup", "dialog");
  box.setAttribute("aria-controls", POPOVER_ID);
  setBoxPopoverState(box, false);
  positionRectElement(box, rect);

  const panel = document.createElement("span");
  panel.className = "ocr-translate-overlay-translation-text";
  panel.textContent = text;
  panel.dir = "auto";
  if (currentTargetLang) {
    panel.lang = currentTargetLang;
  }
  box.append(panel);

  // Dragging out of the box would otherwise run the selection on into the page.
  box.addEventListener("pointerdown", () => {
    beginSelection("box");
  });
  attachBoxPopoverTriggers(box, index);
  return box;
}

// Shrink the font with a binary search until the translation fits, flooring at
// the configured minimum. `clampToWholeLines` truncates whatever still
// overflows. The panel is capped at the box's width, so a wide word overflows
// the panel rather than widening it. Its height is measured against the box.
function fitFontSize(box: HTMLElement, vertical: boolean): void {
  const panel = box.firstElementChild;
  if (!(panel instanceof HTMLElement)) {
    return;
  }
  const maxFontSize = vertical
    ? MAX_FONT_PX_VERTICAL_SOURCE
    : MAX_FONT_PX_HORIZONTAL_SOURCE;
  const cap = Math.max(
    MIN_FONT_PX,
    Math.min(maxFontSize, Math.floor(box.clientHeight)),
  );
  let lo = MIN_FONT_PX;
  let hi = cap;
  let best = MIN_FONT_PX;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    box.style.fontSize = `${mid}px`;
    if (
      panel.offsetHeight <= box.clientHeight &&
      panel.scrollWidth <= panel.clientWidth
    ) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  box.style.fontSize = `${best}px`;
  clampToWholeLines(panel, box);
}

// Cut a too-long translation to whole lines with an ellipsis rather than at
// whatever glyph the box edge lands on; the popover still carries it in full.
// Set on every box, since one that already fits is under the limit anyway.
function clampToWholeLines(panel: HTMLElement, box: HTMLElement): void {
  // Firefox ignores `text-overflow` on the legacy box the clamp needs, so a word
  // too wide for a line is broken instead. Read before clamping, while the panel
  // still reports its untruncated width.
  if (panel.scrollWidth > panel.clientWidth) {
    panel.style.overflowWrap = "anywhere";
  }
  const styles = getComputedStyle(panel);
  const lineHeight = Number.parseFloat(styles.lineHeight);
  // A unitless `line-height` may come back as the bare multiplier, not px, which
  // parses below the font size; clamping on that would clip mid-glyph.
  const fontSize = Number.parseFloat(styles.fontSize);
  const padding =
    Number.parseFloat(styles.paddingTop) +
    Number.parseFloat(styles.paddingBottom);
  if (
    !Number.isFinite(lineHeight) ||
    !Number.isFinite(fontSize) ||
    lineHeight < fontSize ||
    !Number.isFinite(padding)
  ) {
    return;
  }
  const lines = Math.floor(
    (box.clientHeight - padding) / lineHeight + CLAMP_SPILL_LINES,
  );
  panel.style.setProperty("-webkit-line-clamp", `${Math.max(1, lines)}`);
}

function createBox(
  rect: Rect,
  text: string,
  lines: OverlayLine[],
  index: number,
  angle: number,
): HTMLElement {
  const box = document.createElement("div");
  box.className = "ocr-translate-overlay-box ocr-translate-overlay-frame-box";
  box.tabIndex = 0;
  box.setAttribute("role", "button");
  box.setAttribute("aria-haspopup", "dialog");
  box.setAttribute("aria-controls", POPOVER_ID);
  setBoxPopoverState(box, false);
  positionRectElement(box, rect);
  box.dir = "auto";

  // The box text is for screen readers only; the visible text stays in the page
  // image, with the selectable copy of it laid over the glyphs below.
  const label = document.createElement("span");
  label.className = "ocr-translate-overlay-sr-only";
  label.textContent = text;
  if (currentSourceLang) {
    label.lang = currentSourceLang;
  }
  box.append(label, createTextLayer(lines, rect, angle));
  attachBoxPopoverTriggers(box, index);
  return box;
}

const POPOVER_ID = "ocr-translate-overlay-popover";

export function isOverlayBoxActivationKey(key: string): boolean {
  return key === "Enter" || key === " ";
}

// Hovering a box opens its popover once the pointer settles on it. A short close
// delay lets the pointer cross the empty corners around a tilted box.
function attachBoxPopoverTriggers(box: HTMLElement, index: number): void {
  box.addEventListener("pointerenter", (event) => {
    clearPopoverCloseTimer();
    // A touch has no travel across the page to settle from, and waiting would
    // just lose taps shorter than the wait.
    if (event.pointerType === "touch") {
      showPopover(index);
      return;
    }
    waitForPointerToSettle(index, event);
  });
  box.addEventListener("pointermove", (event) => {
    keepWaitingForPointerToSettle(index, event);
  });
  box.addEventListener("pointerleave", handlePopoverPointerLeave);

  // The keyboard equivalent of hovering: activation pins the popover open, and
  // it closes on the next activation or a click elsewhere.
  box.addEventListener("keydown", (event) => {
    if (event.repeat || !isOverlayBoxActivationKey(event.key)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    togglePopover(index);
  });
}

// How long the pointer has to hold still on a box before its popover opens. The
// wait runs from the last movement, not from entering the box, so crossing a run
// of small regions opens nothing on the way — only where the pointer comes to
// rest.
const POPOVER_SETTLE_MS = 100;
// Movement under this is a shaky hand rather than travel, and doesn't restart the
// wait.
const POPOVER_SETTLE_MOVE_PX = 4;
const POPOVER_CLOSE_DELAY_MS = 200;

let settleTimer: ReturnType<typeof setTimeout> | undefined;
// Where the pointer was when the pending wait started, to measure movement from.
let settleOrigin: { x: number; y: number } | undefined;
let popoverCloseTimer: ReturnType<typeof setTimeout> | undefined;

function waitForPointerToSettle(index: number, event: PointerEvent): void {
  clearSettleTimer();
  if (activePopover?.boxIndex === index) {
    return;
  }
  settleOrigin = { x: event.clientX, y: event.clientY };
  settleTimer = setTimeout(() => {
    settleTimer = undefined;
    settleOrigin = undefined;
    showPopover(index);
  }, POPOVER_SETTLE_MS);
}

function keepWaitingForPointerToSettle(
  index: number,
  event: PointerEvent,
): void {
  // Nothing pending: this box's popover is already open, or a touch opened it.
  if (!settleTimer || !settleOrigin) {
    return;
  }
  const travelled = Math.hypot(
    event.clientX - settleOrigin.x,
    event.clientY - settleOrigin.y,
  );
  if (travelled > POPOVER_SETTLE_MOVE_PX) {
    waitForPointerToSettle(index, event);
  }
}

function clearSettleTimer(): void {
  clearTimeout(settleTimer);
  settleTimer = undefined;
  settleOrigin = undefined;
}

function clearPopoverCloseTimer(): void {
  clearTimeout(popoverCloseTimer);
  popoverCloseTimer = undefined;
}

function handlePopoverPointerLeave(event: PointerEvent): void {
  // The pointer left before settling, so whatever it was about to open is off,
  // for a lifted finger as much as for a pointer moving on.
  clearSettleTimer();
  // A touch pointer stops existing when the finger lifts, which would close the
  // popover that same tap opened. Those close on a tap elsewhere instead.
  if (!activePopover || event.pointerType === "touch") {
    return;
  }
  // Moving between the popover and its box leaves neither of them.
  const into = event.relatedTarget;
  if (
    into instanceof Node &&
    (activePopover.el.contains(into) ||
      boxes[activePopover.boxIndex]?.contains(into))
  ) {
    return;
  }
  if (isPopoverBusy()) {
    return;
  }
  clearPopoverCloseTimer();
  popoverCloseTimer = setTimeout(() => {
    popoverCloseTimer = undefined;
    if (!isPopoverBusy()) {
      hidePopover();
    }
  }, POPOVER_CLOSE_DELAY_MS);
}

// Work the popover is in the middle of outlives the hover: a selection being
// dragged or already made in it, and text it is reading aloud. Closing would
// drop the selection or cut the reading off. A click elsewhere still closes it.
function isPopoverBusy(): boolean {
  if (!activePopover) {
    return false;
  }
  return (
    selectingFrom === "popover" ||
    hasSelectionInside(activePopover.el) ||
    (speakingBoxIndex === activePopover.boxIndex &&
      isSpeaking(OVERLAY_SPEECH_OWNER))
  );
}

function hasSelectionInside(element: HTMLElement): boolean {
  const selection = window.getSelection();
  return Boolean(
    selection &&
      !selection.isCollapsed &&
      selection.anchorNode &&
      selection.focusNode &&
      element.contains(selection.anchorNode) &&
      element.contains(selection.focusNode),
  );
}

function togglePopover(index: number): void {
  if (activePopover?.boxIndex === index) {
    hidePopover();
    return;
  }
  showPopover(index);
}

function setBoxPopoverState(box: HTMLElement, open: boolean): void {
  box.classList.toggle("is-active", open);
  box.setAttribute("aria-expanded", String(open));
}

function syncBoxPopoverStates(): void {
  boxes.forEach((box, index) => {
    setBoxPopoverState(box, activePopover?.boxIndex === index);
  });
}

// An invisible, selectable copy of the recognized text, one span per detected
// OCR line, laid over the image's own glyphs. Selecting it draws the highlight
// across the image text instead of over a hidden translation. Each span is
// stretched to its line's box (`fitTextLayers`) so the two roughly line up, and
// each takes its own line's orientation: one box can gather lines of both, when
// a translation that didn't split per paragraph puts the whole capture in the
// combined box.
function createTextLayer(
  lines: OverlayLine[],
  boxRect: Rect,
  angle: number,
): HTMLElement {
  const layer = document.createElement("div");
  layer.className = "ocr-translate-overlay-text-layer";
  layer.addEventListener("pointerdown", () => {
    beginSelection("layer");
  });
  // The screen-reader label above already carries the text.
  layer.setAttribute("aria-hidden", "true");

  for (const line of lines) {
    if (!line.text) {
      continue;
    }
    for (const piece of textLayerPieces(line, boxRect, angle)) {
      if (!piece.text) {
        continue;
      }
      layer.append(createTextLayerPiece(piece, line.vertical));
    }
  }
  return layer;
}

// Where each piece of a line sits inside the box element, whose own frame a tilt
// turns away from the page's.
//
// One span per character when the recognizer located them, so a selection covers
// exactly the glyphs it crosses. Otherwise the whole line goes in one span,
// stretched to fit, and lands only roughly. A tilted box reads the pieces' own
// tilted boxes, which follow the glyphs where the axis-aligned ones have grown
// around the tilt, and places them in the box's frame.
function textLayerPieces(
  line: OverlayLine,
  boxRect: Rect,
  angle: number,
): Array<{ rect: Rect; text: string }> {
  const pieces = line.chars?.length
    ? line.chars
    : [{ rect: line.rect, oriented: line.oriented, text: line.text }];
  if (angle !== 0) {
    return pieces.map((piece) => ({
      rect: toBoxFrame(piece.oriented?.rect ?? piece.rect, boxRect, angle),
      text: piece.text,
    }));
  }
  return pieces.map((piece) => ({
    rect: {
      ...piece.rect,
      x: piece.rect.x - boxRect.x,
      y: piece.rect.y - boxRect.y,
    },
    text: piece.text,
  }));
}

/** A page rect in the coordinates of a box tilted by `angle`, which the browser
 * rotates about its centre — the one point the two frames share. */
function toBoxFrame(rect: Rect, boxRect: Rect, angle: number): Rect {
  const dx = rect.x + rect.width / 2 - (boxRect.x + boxRect.width / 2);
  const dy = rect.y + rect.height / 2 - (boxRect.y + boxRect.height / 2);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: dx * cos + dy * sin + boxRect.width / 2 - rect.width / 2,
    y: dy * cos - dx * sin + boxRect.height / 2 - rect.height / 2,
    width: rect.width,
    height: rect.height,
  };
}

function createTextLayerPiece(
  piece: { rect: Rect; text: string },
  vertical: boolean,
): HTMLElement {
  const span = document.createElement("span");
  span.className = "ocr-translate-overlay-text-layer-line";
  span.textContent = piece.text;
  span.style.left = `${piece.rect.x}px`;
  span.style.top = `${piece.rect.y}px`;
  // Starting size: the piece's thickness. `fitTextLayers` corrects it once it
  // can measure what the font actually paints.
  span.style.fontSize = `${vertical ? piece.rect.width : piece.rect.height}px`;
  if (vertical) {
    span.classList.add("is-vertical");
  }
  span.dataset.x = `${piece.rect.x}`;
  span.dataset.y = `${piece.rect.y}`;
  span.dataset.width = `${piece.rect.width}`;
  span.dataset.height = `${piece.rect.height}`;
  return span;
}

// Fit each span to its OCR line, the way a PDF text layer does. The selection
// band is the font's ascent+descent, which runs 15-20% taller than the em box,
// so the font size comes from what the span actually paints rather than from
// the line's thickness; the length is then stretched to match. Every span is
// measured before anything is written, so the boxes lay out once.
function fitTextLayers(): void {
  const spans: HTMLElement[] = [];
  for (const box of boxes) {
    spans.push(
      ...box.querySelectorAll<HTMLElement>(
        ".ocr-translate-overlay-text-layer-line",
      ),
    );
  }

  const fits = spans.map((span) => {
    const vertical = span.classList.contains("is-vertical");
    const width = Number(span.dataset.width);
    const height = Number(span.dataset.height);
    const painted = paintedRect(span);
    const fontSize = Number.parseFloat(span.style.fontSize);
    // Along the reading direction the line runs; across it the glyphs sit.
    const length = vertical ? height : width;
    const thickness = vertical ? width : height;
    const paintedLength = vertical ? painted.height : painted.width;
    const paintedThickness = vertical ? painted.width : painted.height;
    if (paintedLength <= 0 || paintedThickness <= 0 || !fontSize) {
      return undefined;
    }
    const nextFontSize = (fontSize * thickness) / paintedThickness;
    // Lengths scale with the font size, so the stretch is measured against what
    // the resized span will paint.
    const scale = length / (paintedLength * (nextFontSize / fontSize));
    // Centre the band on the line: the highlight grows around the text's middle.
    const offset = (thickness - nextFontSize) / 2;
    return { fontSize: nextFontSize, scale, offset, vertical };
  });

  spans.forEach((span, index) => {
    const fit = fits[index];
    if (!fit) {
      return;
    }
    span.style.fontSize = `${fit.fontSize}px`;
    if (fit.vertical) {
      span.style.left = `${Number(span.dataset.x) + fit.offset}px`;
      span.style.transform = `scaleY(${fit.scale})`;
    } else {
      span.style.top = `${Number(span.dataset.y) + fit.offset}px`;
      span.style.transform = `scaleX(${fit.scale})`;
    }
  });
}

// The box the selection highlight would cover: the text's own client rect,
// which follows the font's metrics rather than the element's line box.
function paintedRect(span: HTMLElement): DOMRect {
  const range = document.createRange();
  range.selectNodeContents(span);
  return range.getBoundingClientRect();
}

// Selecting text drags across whatever is under the pointer, and the browser
// happily runs the range on into the page — swallowing the image and every
// other text layer. While a drag is in progress, everything except the part it
// started in is made unselectable, so the selection stays where it began.
let selectingFrom: "popover" | "layer" | "box" | undefined;
let pageUserSelect: string | undefined;

function beginSelection(from: "popover" | "layer" | "box"): void {
  if (selectingFrom) {
    return;
  }
  selectingFrom = from;
  container?.classList.add(`is-selecting-${from}`);
  pageUserSelect = document.documentElement.style.userSelect;
  document.documentElement.style.userSelect = "none";
  document.addEventListener("pointerup", endSelection, true);
  document.addEventListener("pointercancel", endSelection, true);
}

function endSelection(): void {
  if (!selectingFrom) {
    return;
  }
  container?.classList.remove(`is-selecting-${selectingFrom}`);
  selectingFrom = undefined;
  document.documentElement.style.userSelect = pageUserSelect ?? "";
  pageUserSelect = undefined;
  document.removeEventListener("pointerup", endSelection, true);
  document.removeEventListener("pointercancel", endSelection, true);
}

// Open the popover for a box, taking it over from whichever box had it. Already
// showing that box is left alone: the pointer crossing back from the popover
// onto its box must not rebuild the panel under it.
function showPopover(index: number): void {
  clearPopoverCloseTimer();
  if (activePopover?.boxIndex === index) {
    return;
  }
  // Moving the popover to another box takes away the stop button of whatever the
  // old one was reading, so the reading stops with it.
  if (speakingBoxIndex !== undefined && isSpeaking(OVERLAY_SPEECH_OWNER)) {
    stopSpeaking();
  }
  activePopover = openPopover(index) ?? activePopover;
  syncBoxPopoverStates();
}

function openPopover(index: number): PopoverView | undefined {
  const content = boxContents[index];
  const el = content ? ensurePopoverElement() : undefined;
  if (!content || !el) {
    return undefined;
  }
  const view: PopoverView = {
    el,
    boxIndex: index,
    speechButtons: {},
  };
  renderPopover(view, content);
  el.hidden = false;
  positionPopoverView(view);
  return view;
}

// Reuse one element across boxes so opening many of them doesn't pile up nodes.
function ensurePopoverElement(): HTMLElement | undefined {
  if (popoverEl) {
    return popoverEl;
  }
  if (!container) {
    return undefined;
  }
  const el = document.createElement("div");
  el.className = "ocr-translate-overlay-popover";
  el.id = POPOVER_ID;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", t("overlayRecognizedAndTranslatedText"));
  el.addEventListener("pointerdown", () => {
    beginSelection("popover");
  });
  el.addEventListener("pointerenter", clearPopoverCloseTimer);
  el.addEventListener("pointerleave", handlePopoverPointerLeave);
  container.append(el);
  document.addEventListener("click", handlePopoverOutsideClick);
  popoverEl = el;
  return el;
}

// A click anywhere but the popover or its box closes it.
function handlePopoverOutsideClick(event: MouseEvent): void {
  if (!activePopover) {
    return;
  }
  const path = event.composedPath();
  if (
    !path.includes(activePopover.el) &&
    !path.includes(boxes[activePopover.boxIndex])
  ) {
    hidePopover();
  }
}

function availablePopoverMode(content: {
  original: string;
  translated: string;
}): OverlayMode {
  return content.original.trim() ? "original" : "translation";
}

// Both texts, each with its own speak/copy, so neither has to be switched to.
// The translation leads in both views, so the rows keep their places wherever
// the popover was opened from and a text long enough to scroll never pushes it
// below the fold. Over a painted box it is the whole translation, including what
// a box too small to paint all of it had to cut. The original follows in a muted
// row, for reading and copying exactly what was recognized.
function renderPopover(
  view: PopoverView,
  content: { original: string; translated: string },
): void {
  view.el.replaceChildren();
  view.speechButtons = {};

  const body = document.createElement("div");
  body.className = "ocr-translate-overlay-popover-body";

  const both = hasBothTexts(content);
  const lead = both ? "translation" : availablePopoverMode(content);
  body.append(createPopoverRow(view, lead, content, false));
  if (both) {
    body.append(createPopoverRow(view, "original", content, true));
  }

  view.body = body;
  view.el.append(body);
}

function createPopoverText(
  textMode: OverlayMode,
  content: { original: string; translated: string },
): HTMLElement {
  const body = document.createElement("div");
  body.className = "ocr-translate-overlay-popover-text";
  body.textContent = modeText(textMode, content);
  body.dir = "auto";
  const lang = modeLang(textMode);
  if (lang) {
    body.lang = lang;
  }
  return body;
}

function createPopoverRow(
  view: PopoverView,
  textMode: OverlayMode,
  content: { original: string; translated: string },
  isSource: boolean,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "ocr-translate-overlay-popover-row";
  if (isSource) {
    row.classList.add("is-source");
  }

  const controls = document.createElement("div");
  controls.className = "ocr-translate-overlay-popover-row-controls";
  controls.append(
    createSpeakButton(view, textMode, content),
    createPopoverCopyButton(textMode, content),
  );

  row.append(createPopoverText(textMode, content), controls);
  return row;
}

function hasBothTexts(content: {
  original: string;
  translated: string;
}): boolean {
  return (
    hasTranslationText &&
    Boolean(content.original.trim()) &&
    Boolean(content.translated.trim())
  );
}

function modeText(
  textMode: OverlayMode,
  content: { original: string; translated: string },
): string {
  return textMode === "original" ? content.original : content.translated;
}

function modeLang(textMode: OverlayMode): LangCode | undefined {
  return textMode === "original" ? currentSourceLang : currentTargetLang;
}

function createSpeakButton(
  view: PopoverView,
  target: OverlayMode,
  content: { original: string; translated: string },
): HTMLButtonElement {
  const button = popoverButton(SPEAK_ICON, t("commonReadAloud"), () => {
    if (isSpeaking(OVERLAY_SPEECH_OWNER)) {
      const wasTarget =
        speakingTarget === target && speakingBoxIndex === view.boxIndex;
      stopSpeaking();
      // Speaking the other text takes over instead of just stopping.
      if (wasTarget) {
        return;
      }
    }
    requestSpeak({
      text: modeText(target, content),
      lang: modeLang(target),
      owner: OVERLAY_SPEECH_OWNER,
      onStart: () => {
        setPopoverSpeakState(true, target, view.boxIndex);
      },
      onEnd: () => {
        setPopoverSpeakState(false);
      },
    });
  });
  view.speechButtons[target] = button;
  setSpeakButtonState(
    button,
    isSpeaking(OVERLAY_SPEECH_OWNER) &&
      speakingTarget === target &&
      speakingBoxIndex === view.boxIndex,
  );
  return button;
}

function createPopoverCopyButton(
  target: OverlayMode,
  content: { original: string; translated: string },
): HTMLButtonElement {
  const button = popoverButton(COPY_ICON, t("commonCopy"), () => {
    void copyPopoverText(button, modeText(target, content));
  });
  return button;
}

function popoverButton(
  icon: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ocr-translate-overlay-popover-button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = icon;
  button.addEventListener("click", onClick);
  return button;
}

// Which text the popover is reading aloud, so only that exact box button shows
// as active. Whole-selection speech has no box index and lights none.
let speakingTarget: OverlayMode | undefined;
let speakingBoxIndex: number | undefined;

function setPopoverSpeakState(
  active: boolean,
  target?: OverlayMode,
  boxIndex?: number,
): void {
  speakingTarget = active ? target : undefined;
  speakingBoxIndex = active ? boxIndex : undefined;
  for (const textMode of ["original", "translation"] as const) {
    setSpeakButtonState(
      activePopover?.speechButtons[textMode],
      active &&
        speakingTarget === textMode &&
        speakingBoxIndex === activePopover?.boxIndex,
    );
  }
}

function setSpeakButtonState(
  button: HTMLButtonElement | undefined,
  active: boolean,
): void {
  if (!button) {
    return;
  }
  const label = active ? t("commonStopSpeaking") : t("commonReadAloud");
  button.innerHTML = active ? STOP_SPEAK_ICON : SPEAK_ICON;
  button.classList.toggle("is-active", active);
  button.setAttribute("aria-label", label);
  button.title = label;
}

const popoverCopyResetTimers = new Map<
  HTMLButtonElement,
  ReturnType<typeof setTimeout>
>();
async function copyPopoverText(
  button: HTMLButtonElement,
  text: string,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return;
  }
  button.innerHTML = CHECK_ICON;
  button.classList.add("is-active");
  clearTimeout(popoverCopyResetTimers.get(button));
  const resetTimer = setTimeout(() => {
    button.innerHTML = COPY_ICON;
    button.classList.remove("is-active");
    popoverCopyResetTimers.delete(button);
  }, 1500);
  popoverCopyResetTimers.set(button, resetTimer);
}

function hidePopover(): void {
  clearSettleTimer();
  clearPopoverCloseTimer();
  if (!activePopover) {
    return;
  }
  // Closing takes away the stop button of whatever this popover is reading, so
  // the reading stops with it.
  if (
    speakingBoxIndex === activePopover.boxIndex &&
    isSpeaking(OVERLAY_SPEECH_OWNER)
  ) {
    stopSpeaking();
  }
  activePopover.el.hidden = true;
  activePopover = undefined;
  syncBoxPopoverStates();
}

function teardownPopover(): void {
  clearSettleTimer();
  clearPopoverCloseTimer();
  for (const timer of popoverCopyResetTimers.values()) {
    clearTimeout(timer);
  }
  popoverCopyResetTimers.clear();
  endSelection();
  document.removeEventListener("click", handlePopoverOutsideClick);
  activePopover = undefined;
  popoverEl = undefined;
}

// Gap kept between the popover and the viewport edges. There is deliberately no
// added gap against the box itself; the close delay only needs to cover the
// empty corners introduced by rotation.
const POPOVER_MARGIN = 8;
// A popover narrower than this reads as a column of fragments even for a narrow
// box; wider than this the line becomes too long to scan comfortably.
const POPOVER_MIN_WIDTH = 384;
const POPOVER_MAX_WIDTH = 640;
// Even with room to spare, a popover taller than this much of the viewport hides
// too much of the page, so it scrolls instead.
const POPOVER_MAX_HEIGHT_RATIO = 0.6;
// Floor for the cap, so a box that leaves almost no room still gets a popover
// worth reading rather than a sliver.
const POPOVER_MIN_HEIGHT = 120;

/** How wide the popover may grow for a box of `boxWidth`. It follows the box, so
 * the text wraps at roughly the width it was recognized at, bounded by what
 * reads well and by the viewport. */
export function popoverMaxWidth(
  boxWidth: number,
  viewportWidth: number,
): number {
  const room = viewportWidth - POPOVER_MARGIN * 2;
  return Math.min(
    Math.max(boxWidth, POPOVER_MIN_WIDTH),
    Math.max(Math.min(POPOVER_MAX_WIDTH, room), 0),
  );
}

/** Where the popover sits vertically, and how tall it may get there. It sits
 * flush against the box, on the side with room for the whole text; when neither
 * side has it, on the roomier side, with the height capped so the text scrolls
 * inside the viewport instead of running off it. */
export function popoverVerticalPlacement(args: {
  boxY: number;
  boxHeight: number;
  height: number;
  viewportHeight: number;
}): { top: number; maxHeight: number } {
  const { boxY, boxHeight, height, viewportHeight } = args;
  const cap = Math.max(
    POPOVER_MIN_HEIGHT,
    viewportHeight * POPOVER_MAX_HEIGHT_RATIO,
  );
  const roomBelow = Math.min(
    cap,
    viewportHeight - boxY - boxHeight - POPOVER_MARGIN,
  );
  const roomAbove = Math.min(cap, boxY - POPOVER_MARGIN);
  const fitsAbove = height > roomBelow && height <= roomAbove;
  const below = !fitsAbove && (height <= roomBelow || roomBelow >= roomAbove);

  const maxHeight = Math.max(POPOVER_MIN_HEIGHT, below ? roomBelow : roomAbove);
  const shown = Math.min(height, maxHeight);
  const top = below ? boxY + boxHeight : boxY - shown;
  return {
    top: clamp(
      top,
      POPOVER_MARGIN,
      Math.max(POPOVER_MARGIN, viewportHeight - shown - POPOVER_MARGIN),
    ),
    maxHeight,
  };
}

function positionPopover(): void {
  if (activePopover) {
    positionPopoverView(activePopover);
  }
}

function positionPopoverView(view: PopoverView): void {
  if (view.el.hidden) {
    return;
  }
  const pageRect = boxRects[view.boxIndex];
  if (!pageRect) {
    return;
  }
  const box = boxes[view.boxIndex];
  const translationPanel =
    mode === "translation" ? box?.firstElementChild : undefined;
  // In translation mode, anchor to the visible panel rather than the full OCR box.
  const rect =
    translationPanel instanceof HTMLElement
      ? translationPanel.getBoundingClientRect()
      : pageToViewportRect(
          rotatedBounds(pageRect, boxAngles[view.boxIndex] ?? 0),
        );
  // Widen to the box before measuring: a wide box gets a wide popover, which is
  // what keeps a long paragraph from turning into a narrow column of many lines.
  view.el.style.maxWidth = `${popoverMaxWidth(rect.width, window.innerWidth)}px`;
  // The height cap has to come off to measure what the text really needs. That
  // collapses the scroll position of a body that no longer overflows, so put it
  // back once the cap is on again; both happen before the next paint.
  const scrollTop = view.body?.scrollTop ?? 0;
  view.el.style.maxHeight = "";
  const width = view.el.offsetWidth;
  const height = view.el.offsetHeight;
  const x = clamp(
    rect.x + rect.width / 2 - width / 2,
    POPOVER_MARGIN,
    Math.max(POPOVER_MARGIN, window.innerWidth - width - POPOVER_MARGIN),
  );
  const vertical = popoverVerticalPlacement({
    boxY: rect.y,
    boxHeight: rect.height,
    height,
    viewportHeight: window.innerHeight,
  });
  view.el.style.maxHeight = `${vertical.maxHeight}px`;
  if (view.body) {
    view.body.scrollTop = scrollTop;
  }
  view.el.style.left = `${x}px`;
  view.el.style.top = `${vertical.top}px`;
}

function positionToolbar(): void {
  if (!toolbar || !currentRect) {
    return;
  }
  const rect = pageToViewportRect(currentRect);
  const width = toolbar.offsetWidth || 280;
  const height = toolbar.offsetHeight || 40;
  const x = clamp(
    rect.x + rect.width / 2 - width / 2,
    8,
    Math.max(8, window.innerWidth - width - 8),
  );
  const belowY = rect.y + rect.height + 8;
  const aboveY = rect.y - height - 8;
  // Above the region by default, so the controls sit away from the popovers,
  // which open below their box whenever there is room. Drops below when the
  // region starts too close to the top of the viewport.
  const y =
    aboveY >= 8
      ? aboveY
      : belowY + height <= window.innerHeight - 8
        ? belowY
        : clamp(aboveY, 8, Math.max(8, window.innerHeight - height - 8));
  toolbar.style.left = `${x}px`;
  toolbar.style.top = `${y}px`;
}

function createLoadingChip(status: PipelineStatus): HTMLElement {
  const chip = document.createElement("div");
  chip.className = "ocr-translate-overlay-status is-loading";

  const spinner = document.createElement("div");
  spinner.className = "ocr-translate-overlay-spinner";

  const label = document.createElement("p");
  label.className = "ocr-translate-overlay-status-label";

  const progress = document.createElement("div");
  progress.className = "ocr-translate-overlay-progress";
  const fill = document.createElement("div");
  fill.className = "ocr-translate-overlay-progress-fill";
  progress.append(fill);

  updateLoadingChip = (next: PipelineStatus): void => {
    label.textContent = pipelineStatusMessage(next);
    const fraction = pipelineStatusProgress(next);
    progress.hidden = fraction === undefined;
    fill.style.transform = `scaleX(${fraction ?? 0})`;
  };
  updateLoadingChip(status);

  chip.append(
    spinner,
    label,
    iconButton(CLOSE_ICON, t("commonClose"), closeOverlay),
    progress,
  );
  return chip;
}

function createErrorChip(args: {
  message: string;
  onRetry?: () => void;
  onOpenSettings?: () => void;
  onDismiss?: () => void;
}): HTMLElement {
  const chip = document.createElement("div");
  chip.className = "ocr-translate-overlay-status is-error";

  const icon = document.createElement("span");
  icon.className = "ocr-translate-overlay-status-warning";
  icon.innerHTML = WARNING_ICON;

  const label = document.createElement("p");
  label.className = "ocr-translate-overlay-status-label";
  label.textContent = args.message;

  chip.append(icon, label);
  if (args.onRetry) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "ocr-translate-overlay-retry";
    retry.textContent = t("commonRetry");
    retry.addEventListener("click", args.onRetry, { once: true });
    chip.append(retry);
  }
  if (args.onOpenSettings) {
    chip.append(
      iconButton(SETTINGS_ICON, t("commonSettings"), args.onOpenSettings),
    );
  }
  chip.append(
    iconButton(
      CLOSE_ICON,
      args.onDismiss ? t("commonDismiss") : t("commonClose"),
      args.onDismiss ?? closeOverlay,
    ),
  );
  return chip;
}

function renderRegionLayers(): void {
  regionBackdrop = undefined;
  regionFrame = undefined;
  if (container && currentRect) {
    regionBackdrop = createRegionBackdrop(currentRect);
    regionFrame = createRegionFrame(currentRect);
    container.append(regionBackdrop, regionFrame);
  }
  refreshRegionSnapshot();
}

// Put the current snapshot (or none) on screen. Separate from the layers around
// it because it also arrives on its own: it is fetched while the pipeline runs
// and lands under whatever the overlay is already showing.
function refreshRegionSnapshot(): void {
  regionSnapshot?.remove();
  regionSnapshot = undefined;
  if (!container || !currentRect || !currentSnapshot) {
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.className = "ocr-translate-overlay-snapshot";
  canvas.setAttribute("aria-hidden", "true");
  // The backing store keeps the capture's own resolution; CSS scales it to the
  // region, so a HiDPI capture stays sharp.
  canvas.width = currentSnapshot.width;
  canvas.height = currentSnapshot.height;
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.drawImage(currentSnapshot, 0, 0);
  positionRectElement(canvas, currentRect);
  container.prepend(canvas);
  regionSnapshot = canvas;
}

function createRegionBackdrop(rect: Rect): HTMLElement {
  const backdrop = document.createElement("div");
  backdrop.className = "ocr-translate-overlay-dim";
  positionRectElement(backdrop, rect);
  return backdrop;
}

function createRegionFrame(rect: Rect): HTMLElement {
  const frame = document.createElement("div");
  frame.className = "ocr-translate-overlay-region";
  positionRectElement(frame, rect);
  return frame;
}

function positionChip(chip: HTMLElement): void {
  if (!currentRect) {
    return;
  }
  const rect = pageToViewportRect(currentRect);
  const width = chip.offsetWidth || 220;
  const height = chip.offsetHeight || 64;
  const x = clamp(
    rect.x + rect.width / 2 - width / 2,
    8,
    Math.max(8, window.innerWidth - width - 8),
  );
  const y = chip.classList.contains("is-result-error")
    ? resultErrorChipY(rect, height)
    : clamp(
        rect.y + rect.height / 2 - height / 2,
        8,
        Math.max(8, window.innerHeight - height - 8),
      );
  chip.style.left = `${x}px`;
  chip.style.top = `${y}px`;
}

function resultErrorChipY(rect: Rect, height: number): number {
  const margin = 8;
  const maxY = Math.max(margin, window.innerHeight - height - margin);
  const toolbarRect = toolbar?.getBoundingClientRect();
  const candidates = toolbarRect
    ? toolbarRect.bottom <= rect.y
      ? [rect.y + rect.height + margin, toolbarRect.top - height - margin]
      : [rect.y - height - margin, toolbarRect.bottom + margin]
    : [rect.y + rect.height + margin, rect.y - height - margin];
  return (
    candidates.find((candidate) => candidate >= margin && candidate <= maxY) ??
    clamp(rect.y + rect.height / 2 - height / 2, margin, maxY)
  );
}

function captureAnchor(): void {
  if (!currentRect) {
    anchor = undefined;
    return;
  }

  const rect = pageToViewportRect(currentRect);
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
    return;
  }

  const display = container?.style.display;
  if (container) {
    container.style.display = "none";
  }
  const element = document.elementFromPoint(x, y);
  if (container && display !== undefined) {
    container.style.display = display;
  }

  if (!element || element === document.body || element === document.documentElement) {
    return;
  }

  const anchorRect = element.getBoundingClientRect();
  anchor = {
    element,
    x: anchorRect.left + window.scrollX,
    y: anchorRect.top + window.scrollY,
  };
}

function updateAnchor(): void {
  if (!anchor || !anchor.element.isConnected) {
    return;
  }
  const rect = anchor.element.getBoundingClientRect();
  const x = rect.left + window.scrollX;
  const y = rect.top + window.scrollY;
  const dx = x - anchor.x;
  const dy = y - anchor.y;
  if (dx === 0 && dy === 0) {
    return;
  }

  anchor.x = x;
  anchor.y = y;
  moveCurrentLayout(dx, dy);
}

function moveCurrentLayout(dx: number, dy: number): void {
  if (currentRect) {
    currentRect = moveRect(currentRect, dx, dy);
  }
  if (currentLayout) {
    currentLayout = moveOverlayLayout(currentLayout, dx, dy);
  }
  boxRects = boxRects.map((rect) => moveRect(rect, dx, dy));
}

function moveRect(rect: Rect, dx: number, dy: number): Rect {
  return { ...rect, x: rect.x + dx, y: rect.y + dy };
}

function positionRectElement(element: HTMLElement, pageRect: Rect): void {
  const rect = pageToViewportRect(pageRect);
  element.style.left = `${rect.x}px`;
  element.style.top = `${rect.y}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
}

function pageToViewportRect(rect: Rect): Rect {
  return {
    x: rect.x - window.scrollX,
    y: rect.y - window.scrollY,
    width: rect.width,
    height: rect.height,
  };
}

function iconButton(
  icon: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ocr-translate-overlay-icon-button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = icon;
  button.addEventListener("click", onClick);
  return button;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, value), Math.max(min, max));
}

export function dispose(): void {
  config = undefined;
  closeOverlay();
  uiRoot = undefined;
  currentSnapshot = undefined;
}
