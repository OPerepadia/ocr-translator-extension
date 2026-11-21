import { sendRequest } from "../../shared/runtime-messaging";
import type {
  LangCode,
  OverlayMode,
  PipelineResult,
  PipelineStatus,
  Rect,
} from "@/shared/types";
import { t } from "@/shared/i18n";
import { setDefaultOverlayMode } from "@/shared/storage";
import {
  CLOSE_ICON,
  COPY_ICON,
  DRAG_HANDLE_ICON,
  OVERLAY_ICON,
  PANEL_ICON,
  RECOGNIZE_TEXT_ICON,
  RETRANSLATE_ICON,
  SELECT_REGION_ICON,
  SETTINGS_ICON,
  SPEAK_ICON,
  TRANSLATE_ICON,
  WARNING_ICON,
} from "./icons";
import {
  createActionMenu,
  type ActionMenu,
  type ActionMenuChoiceGroup,
  type ActionMenuItem,
} from "./action-menu";
import {
  createOcrSourceLanguagePicker,
  createTargetLanguagePicker,
  createTranslationProviderPicker,
  type ContentControlPicker,
} from "./content-control-pickers";
import {
  pipelineStatusMessage,
  pipelineStatusProgress,
  pipelineStatusShowsSpinner,
} from "./pipeline-status";
import {
  buildOverlayLayout,
  moveOverlayLayout,
  fitRectNearBounds,
  separateCards,
  type OverlayLayout,
  type OverlayLine,
} from "./overlay-layout";
import { isSpeaking, requestSpeak, stopSpeaking } from "./tts";
import { startTextSelection } from "./overlay-selection";
import { estimateSurroundingTint } from "./overlay-background";
import type { ContentControls } from "./content-controls";
import {
  createOverlayPopover,
  OVERLAY_POPOVER_ID,
  type OverlayPopover,
  type OverlayPopoverBox,
} from "./overlay-popover";

export interface OverlayConfig {
  controls: ContentControls;
  onClose(): void;
  onShowPanel(): void;
  onNewSelection(): void;
}
const OVERLAY_SPEECH_OWNER = "overlay";

let uiRoot: HTMLElement | undefined;
let container: HTMLElement | undefined;
let toolbar: HTMLElement | undefined;
let toolbarPosition: { x: number; y: number } | undefined;
let modeButton: HTMLButtonElement | undefined;
let renderedBoxes: OverlayPopoverBox[] = [];
let boxLayers: Partial<
  Record<
    OverlayMode,
    { element: HTMLElement; boxes: OverlayPopoverBox[] }
  >
> = {};
let popover: OverlayPopover | undefined;
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
let selectedMode: OverlayMode = "translation";
// The saved view that new overlays start in, shown in the toolbar menu.
let defaultMode: OverlayMode = "translation";
let activeReadAllMode: OverlayMode | undefined;
let hasTranslationText = false;
let currentOriginalText = "";
let currentDisplayText = "";
let currentSourceLang: LangCode | undefined;
let currentTargetLang: LangCode | undefined;
let config: OverlayConfig | undefined;

let keydownHandler: ((event: KeyboardEvent) => void) | undefined;
let keyupHandler: ((event: KeyboardEvent) => void) | undefined;
let pointerdownHandler: (() => void) | undefined;
// Shift toggles the view on release, but only when pressed on its own
let loneShiftDown = false;
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
// Cap for horizontal text of ordinary size. Larger lines may go up to
// MAX_FONT_PX_LARGE_HORIZONTAL_SOURCE.
const MAX_FONT_PX_HORIZONTAL_SOURCE = 24;
// Ceiling for large horizontal text such as titles, so a huge headline or a
// logo does not get a card that covers half the image.
const MAX_FONT_PX_LARGE_HORIZONTAL_SOURCE = 32;
const MAX_FONT_PX_VERTICAL_SOURCE = 18;
const MAX_FONT_PX_EXPANDED_VERTICAL_SOURCE = 16;
// Target font for vertical source text, as a share of the column width, and
// the font cap for large horizontal text, as a share of the line height. Latin
// and Cyrillic letters look larger than CJK glyphs at the same size.
const FONT_PER_SOURCE_SIZE = 0.6;
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
  refreshTranslationBackgrounds();
}

export function resetOverlayMode(initialMode: OverlayMode): void {
  mode = initialMode;
  selectedMode = initialMode;
  defaultMode = initialMode;
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
  mode = hasTranslationText ? selectedMode : "original";

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
  retryLabel?: string;
  onOpenSettings?: () => void;
  showSourceLanguageToolbar?: boolean;
}): void {
  currentRect = args.rect;
  captureAnchor();
  // Unlike the loading chip, there's nothing to patch in place; drop the stale
  // patcher so a later showOverlayLoading rebuilds instead of patching it.
  updateLoadingChip = undefined;
  mountChip(
    createErrorChip({
      ...args,
      onOpenSettings: args.showSourceLanguageToolbar
        ? undefined
        : args.onOpenSettings,
      showClose: !args.showSourceLanguageToolbar,
    }),
    args.showSourceLanguageToolbar,
  );
}

export function closeOverlay(options: { notify?: boolean } = {}): void {
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
  if (keyupHandler) {
    document.removeEventListener("keyup", keyupHandler, true);
    keyupHandler = undefined;
  }
  if (pointerdownHandler) {
    document.removeEventListener("pointerdown", pointerdownHandler, true);
    pointerdownHandler = undefined;
  }
  loneShiftDown = false;
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
  toolbarPosition = undefined;
  renderedBoxes = [];
  boxLayers = {};
  disposePopover();
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
  if (options.notify !== false) {
    config?.onClose();
  }

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
  disposePopover();

  renderRegionLayers();
  toolbar = createToolbar();
  container.append(toolbar);
  if (currentTranslationError) {
    statusChip = createErrorChip({
      ...currentTranslationError,
      onOpenSettings: openTranslationSettings,
      onDismiss: dismissTranslationError,
    });
    statusChip.classList.add("is-result-error");
    container.append(statusChip);
  }

  (uiRoot ?? document.documentElement).append(container);
  popover = createOverlayPopover({
    container,
    speechOwner: OVERLAY_SPEECH_OWNER,
    getState: () => ({
      boxes: renderedBoxes,
      mode,
      hasTranslation: hasTranslationText,
      sourceLang: currentSourceLang,
      targetLang: currentTargetLang,
      selectingFromPopover: selectingFrom === "popover",
      selectingFromLayer: selectingFrom === "layer",
    }),
    beginSelection: () => beginSelection("popover"),
    endSelection,
  });
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

function mountChip(chip: HTMLElement, showSourceLanguageToolbar = false): void {
  if (isSpeaking(OVERLAY_SPEECH_OWNER)) {
    stopSpeaking();
  }
  if (container) {
    container.remove();
  }
  renderedBoxes = [];
  boxLayers = {};
  disposePopover();
  toolbar = undefined;
  modeButton = undefined;
  clearOutsideClickHandlers();
  currentLayout = undefined;
  currentTranslationError = undefined;

  container = document.createElement("div");
  container.className = "ocr-translate-overlay";
  container.classList.add("is-status");
  renderRegionLayers();

  if (showSourceLanguageToolbar) {
    toolbar = createOcrRecoveryToolbar();
    container.append(toolbar);
  }
  statusChip = chip;
  container.append(statusChip);

  (uiRoot ?? document.documentElement).append(container);
  if (toolbar) {
    positionToolbar();
  }
  positionChip(statusChip);
  ensureGlobalHandlers();
}

function ensureGlobalHandlers(): void {
  if (!keydownHandler) {
    keydownHandler = (event: KeyboardEvent): void => {
      if (event.key !== "Shift") {
        loneShiftDown = false;
      } else if (!event.repeat) {
        loneShiftDown = !event.ctrlKey && !event.altKey && !event.metaKey;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        // Close an open language list or the ⋯ menu before the overlay itself.
        const openControlButton = toolbar?.querySelector<HTMLButtonElement>(
          '.ocr-translate-popup-langpill-button[aria-expanded="true"], .ocr-translate-popup-menu > button[aria-expanded="true"]',
        );
        if (openControlButton) {
          openControlButton.click();
          openControlButton.focus();
          return;
        }
        if (!popover?.dismiss()) {
          closeOverlay();
        }
      }
    };
    document.addEventListener("keydown", keydownHandler, true);
  }
  if (!keyupHandler) {
    keyupHandler = (event: KeyboardEvent): void => {
      if (event.key !== "Shift" || !loneShiftDown) {
        return;
      }
      loneShiftDown = false;
      if (
        modeButton &&
        !modeButton.disabled &&
        !isEditableTarget(event.composedPath()[0])
      ) {
        toggleMode();
      }
    };
    document.addEventListener("keyup", keyupHandler, true);
  }
  if (!pointerdownHandler) {
    pointerdownHandler = (): void => {
      loneShiftDown = false;
    };
    document.addEventListener("pointerdown", pointerdownHandler, true);
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
  Object.values(boxLayers).forEach((layer) => {
    layer.boxes.forEach((box) => {
      positionRectElement(box.element, box.rect);
    });
  });
  if (toolbar) {
    positionToolbar();
  }
  if (statusChip) {
    positionChip(statusChip);
  }
  popover?.reposition();
}

function clearOutsideClickHandlers(): void {
  for (const disposeControl of controlDisposers) {
    disposeControl();
  }
  controlDisposers = [];
}

function mountControlPicker(
  picker: ContentControlPicker | undefined,
): HTMLElement | undefined {
  if (!picker) {
    return undefined;
  }
  controlDisposers.push(picker.dispose);
  return picker.element;
}

function disposePopover(): void {
  endSelection();
  popover?.dispose();
  popover = undefined;
}

function createToolbar(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "ocr-translate-overlay-toolbar";
  bar.append(createToolbarDragHandle(bar));

  const modeButtonWrapper = document.createElement("span");
  modeButtonWrapper.className = "ocr-translate-overlay-mode-button-wrap";
  if (!hasTranslationText) {
    modeButtonWrapper.title = currentTranslationError
      ? t("overlayTranslationUnavailable")
      : t("overlayAlreadyInTargetLanguage");
  }
  modeButtonWrapper.append(createModeButton());

  const controls = config?.controls;
  const sourcePicker = mountControlPicker(
    controls
      ? createOcrSourceLanguagePicker(controls, {
          position: "auto",
          compact: true,
        })
      : undefined,
  );
  const targetPicker = mountControlPicker(
    controls
      ? createTargetLanguagePicker({
          controls,
          target: currentTargetLang,
          position: "auto",
          compact: true,
          onSelect: (targetLang) => {
            currentTargetLang = targetLang;
          },
        })
      : undefined,
  );
  const providerPicker = mountControlPicker(
    controls
      ? createTranslationProviderPicker(controls, { overlay: true })
      : undefined,
  );
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
  if (sourcePicker && targetPicker) {
    const direction = document.createElement("span");
    direction.className = "ocr-translate-overlay-direction";
    direction.setAttribute("aria-hidden", "true");
    direction.textContent = "→";
    bar.append(direction);
  }
  if (targetPicker) {
    bar.append(targetPicker);
  }
  if (providerPicker) {
    bar.append(providerPicker);
  }
  bar.append(modeButtonWrapper);
  bar.append(selectButton, menu.element, divider, closeButton);
  return bar;
}

function createOcrRecoveryToolbar(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "ocr-translate-overlay-toolbar";
  bar.append(createToolbarDragHandle(bar));

  const sourcePicker = mountControlPicker(
    config
      ? createOcrSourceLanguagePicker(config.controls, {
          position: "auto",
          compact: true,
        })
      : undefined,
  );
  if (sourcePicker) {
    bar.append(sourcePicker);
  }

  bar.append(
    iconButton(SELECT_REGION_ICON, t("panelSelectNewRegion"), () => {
      closeOverlay();
      config?.onNewSelection();
    }),
    iconButton(SETTINGS_ICON, t("commonSettings"), openSettings),
  );

  const divider = document.createElement("span");
  divider.className = "ocr-translate-overlay-divider";
  divider.setAttribute("aria-hidden", "true");
  const closeButton = iconButton(CLOSE_ICON, t("commonClose"), () => closeOverlay());
  closeButton.classList.add("ocr-translate-overlay-close");
  bar.append(divider, closeButton);
  return bar;
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

  button.addEventListener("click", toggleMode);

  return button;
}

function toggleMode(): void {
  // Both views are built from the same toolbar, so only the boxes and the
  // button's own state changes; rebuilding the bar would replay its entry
  // animation on every flip.
  if (isSpeaking(OVERLAY_SPEECH_OWNER)) {
    stopSpeaking();
  }
  mode = mode === "translation" ? "original" : "translation";
  selectedMode = mode;
  showBoxLayer();
  updateModeButton();
}

function isEditableTarget(target: EventTarget | undefined): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement)
  );
}

function updateModeButton(): void {
  if (!modeButton) {
    return;
  }
  const showingTranslation = mode === "translation";
  const label = t(
    showingTranslation ? "overlayHideTranslation" : "overlayShowTranslation",
  );
  modeButton.setAttribute("aria-pressed", String(showingTranslation));
  modeButton.setAttribute("aria-label", label);
  if (hasTranslationText) {
    modeButton.setAttribute("aria-keyshortcuts", "Shift");
    modeButton.title = `${label} (Shift)`;
  }
}

function createMenu(): ActionMenu {
  const items: Array<ActionMenuItem | ActionMenuChoiceGroup> = [];
  const addItem = (
    iconMarkup: string,
    labelText: string,
    onSelect: () => void,
    separatorBefore = false,
  ): void => {
    items.push({
      icon: iconMarkup,
      label: labelText,
      onSelect,
      separatorBefore,
    });
  };

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
  const canRetranslate = Boolean(
    hasTranslationText && currentTargetLang && config,
  );
  if (canRetranslate) {
    addItem(
      RETRANSLATE_ICON,
      t("commonTranslateAgain"),
      () => {
        if (currentTargetLang) {
          config?.controls.selectTargetLanguage(currentTargetLang);
        }
      },
      true,
    );
  }
  addItem(
    PANEL_ICON,
    t("overlayShowInPanel"),
    () => config?.onShowPanel(),
    !canRetranslate,
  );
  const views: Array<{ mode: OverlayMode; label: string }> = [
    { mode: "translation", label: t("optionsOverlayViewTranslation") },
    { mode: "original", label: t("optionsOverlayViewOriginal") },
  ];
  items.push({
    icon: OVERLAY_ICON,
    label: t("overlayInitialView"),
    separatorBefore: true,
    currentLabel: () =>
      views.find((view) => view.mode === defaultMode)?.label ?? "",
    choices: views.map((view) => ({
      label: view.label,
      isChecked: () => defaultMode === view.mode,
      onSelect: () => saveDefaultMode(view.mode),
    })),
  });
  addItem(SETTINGS_ICON, t("commonSettings"), openSettings);
  return createActionMenu({ items, overlay: true });
}

// Same setting as the options page
function saveDefaultMode(next: OverlayMode): void {
  const previous = defaultMode;
  defaultMode = next;
  void setDefaultOverlayMode(next).catch(() => {
    defaultMode = previous;
  });
}

function openSettings(): void {
  void sendRequest({ type: "OPEN_OPTIONS" });
}

function openTranslationSettings(): void {
  void sendRequest({ type: "OPEN_OPTIONS", section: "translation" });
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
    const wasTarget = activeReadAllMode === target;
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
      activeReadAllMode = target;
      popover?.setWholeSpeechState(true, target);
    },
    onEnd: () => {
      activeReadAllMode = undefined;
      popover?.setWholeSpeechState(false);
    },
  });
}

function renderBoxes(): void {
  if (!container || !currentLayout) {
    return;
  }
  endSelection();
  for (const layer of Object.values(boxLayers)) {
    layer.element.remove();
  }
  popover?.clearBoxes();
  boxLayers = {};

  const modes: OverlayMode[] = hasTranslationText
    ? ["translation", "original"]
    : ["original"];
  for (const layerMode of modes) {
    const layer = document.createElement("div");
    layer.className = "ocr-translate-overlay-box-layer";
    container.append(layer);
    const boxes =
      layerMode === "translation"
        ? renderTranslationBoxes(currentLayout, layer)
        : renderSourceBoxes(currentLayout, layer);
    applyBoxAngles(boxes);
    boxLayers[layerMode] = { element: layer, boxes };
  }

  showBoxLayer(false);
  refreshTranslationBackgrounds();
}

function refreshTranslationBackgrounds(): void {
  const layer = boxLayers.translation;
  const capture = currentRect;
  if (!layer || !currentLayout || !capture) {
    return;
  }
  for (const box of layer.boxes) {
    box.element.style.removeProperty("--ocr-text-background");
    box.element.style.removeProperty("--ocr-text-foreground");
  }
  if (!regionSnapshot) {
    return;
  }
  const context = regionSnapshot.getContext("2d");
  if (!context) {
    return;
  }
  let pixels: ImageData;
  try {
    pixels = context.getImageData(0, 0, regionSnapshot.width, regionSnapshot.height);
  } catch {
    return;
  }
  const groups = currentLayout.segmented
    ? currentLayout.paragraphs.map((paragraph) => [paragraph])
    : [currentLayout.paragraphs];
  groups.forEach((paragraphs, index) => {
    const box = layer.boxes[index];
    if (!box?.content.translated.trim()) {
      return;
    }
    const tint = estimateSurroundingTint(
      pixels,
      capture,
      paragraphs.flatMap((paragraph) => paragraph.lines),
    );
    if (!tint) {
      return;
    }
    box.element.style.setProperty("--ocr-text-background", tint.background);
    box.element.style.setProperty("--ocr-text-foreground", tint.foreground);
  });
}

function showBoxLayer(dismissPopover = true): void {
  if (dismissPopover) {
    endSelection();
    popover?.clearBoxes();
  }
  for (const [layerMode, layer] of Object.entries(boxLayers)) {
    layer.element.hidden = layerMode !== mode;
  }
  renderedBoxes = boxLayers[mode]?.boxes ?? [];
}

// Tilts go on last, after every box has been fitted. `fitTextLayers` measures
// with getBoundingClientRect, which reports the wider bounds a rotated element
// covers rather than the box itself, and would size the spans to those.
function applyBoxAngles(boxes: OverlayPopoverBox[]): void {
  boxes.forEach(({ element, angle }) => {
    if (angle !== 0) {
      element.style.transform = `rotate(${angle}rad)`;
    }
  });
}

function renderTranslationBoxes(
  layout: OverlayLayout,
  overlayContainer: HTMLElement,
): OverlayPopoverBox[] {
  const boxes: OverlayPopoverBox[] = [];
  const fitOptions: Array<{
    vertical: boolean;
    expanded: boolean;
    textSize: number;
    sourceWidth: number;
    bubbleRoom?: Rect;
    /** Where the card is centred before cards are moved apart. */
    center: Rect;
    slide: Rect;
  }> = [];
  // Without a per-paragraph split, one combined box, so the whole translation is
  // never misattributed to a single region.
  if (!layout.segmented) {
    const vertical =
      layout.paragraphs.length > 0 &&
      layout.paragraphs.every((paragraph) => paragraph.vertical);
    const box = createTranslationBox(
      layout.combinedRect,
      layout.combinedTranslation,
      vertical,
    );
    overlayContainer.append(box);
    addRenderedBox(
      boxes,
      {
        element: box,
        rect: layout.combinedRect,
        angle: 0,
        content: {
          original: currentOriginalText,
          translated: layout.combinedTranslation,
        },
      },
      "translation",
    );
    fitOptions.push({
      vertical,
      expanded: layout.combinedRect.width > layout.combinedSourceRect.width,
      textSize: layout.combinedTextSize,
      sourceWidth: layout.combinedSourceRect.width,
      center: centerPoint(layout.combinedRect),
      slide: centerPoint(layout.combinedRect),
    });
  } else {
    layout.paragraphs.forEach((paragraph) => {
      const box = createTranslationBox(
        paragraph.translationRect,
        paragraph.translated ?? "",
        paragraph.vertical,
      );
      overlayContainer.append(box);
      addRenderedBox(
        boxes,
        {
          element: box,
          rect: paragraph.translationRect,
          angle: paragraph.angle,
          content: {
            original: paragraph.original,
            translated: paragraph.translated ?? "",
          },
        },
        "translation",
      );
      fitOptions.push({
        vertical: paragraph.vertical,
        expanded: paragraph.translationRect.width > paragraph.sourceRect.width,
        textSize: paragraph.textSize,
        sourceWidth: paragraph.sourceRect.width,
        bubbleRoom: paragraph.bubbleRoom,
        // A card in a bubble covers its source text; the rest stay centred in
        // their room, which keeps them inside the capture.
        center: centerPoint(
          paragraph.bubbleRoom ? paragraph.sourceRect : paragraph.translationRect,
        ),
        // A card may slide within its bubble, or else over its source text. A
        // tilted card stays put: sliding it would drag it off its text.
        slide:
          paragraph.angle !== 0
            ? centerPoint(paragraph.translationRect)
            : (paragraph.bubbleRoom ?? paragraph.sourceRect),
      });
    });
  }

  boxes.forEach((box, index) => {
    fitTranslationCard(box.element, fitOptions[index]);
  });
  shrinkBoxesToCards(
    boxes,
    fitOptions.map((options) => ({
      slide: options.slide,
      center: options.center,
      room: options.bubbleRoom,
    })),
  );
  return boxes;
}

// Shrink each box from the room it was given to its fitted card, shift a card
// that spills out of its bubble back inside, then move cards apart where they
// overlap. Boxes keep the card's size for hovering and for placing the popover.
function shrinkBoxesToCards(
  boxes: OverlayPopoverBox[],
  places: Array<{ slide: Rect; center: Rect; room?: Rect }>,
): void {
  const cards = boxes.map((box, index) => {
    const panel = box.element.firstElementChild;
    const width = panel instanceof HTMLElement ? panel.offsetWidth : box.rect.width;
    const height =
      panel instanceof HTMLElement ? panel.offsetHeight : box.rect.height;
    const { slide, center, room } = places[index];
    const rect = {
      x: center.x - width / 2,
      y: center.y - height / 2,
      width,
      height,
    };
    return { rect: room ? fitRectNearBounds(rect, room) : rect, slide };
  });
  const placed = separateCards(cards, currentRect);
  boxes.forEach((box, index) => {
    box.rect = placed[index];
    positionRectElement(box.element, box.rect);
  });
}

function centerPoint(rect: Rect): Rect {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
    width: 0,
    height: 0,
  };
}

function renderSourceBoxes(
  layout: OverlayLayout,
  overlayContainer: HTMLElement,
): OverlayPopoverBox[] {
  const boxes: OverlayPopoverBox[] = [];
  if (hasTranslationText && !layout.segmented) {
    const box = createBox(
      layout.combinedSourceRect,
      currentOriginalText,
      layout.paragraphs.flatMap((paragraph) => paragraph.lines),
      0,
    );
    overlayContainer.append(box);
    addRenderedBox(
      boxes,
      {
        element: box,
        rect: layout.combinedSourceRect,
        angle: 0,
        content: {
          original: currentOriginalText,
          translated: layout.combinedTranslation,
        },
      },
      "original",
    );
  } else {
    layout.paragraphs.forEach((paragraph) => {
      const rect = paragraph.sourceRect;
      const box = createBox(
        rect,
        paragraph.original,
        paragraph.lines,
        paragraph.angle,
      );
      overlayContainer.append(box);
      addRenderedBox(
        boxes,
        {
          element: box,
          rect,
          angle: paragraph.angle,
          content: {
            original: paragraph.original,
            translated: paragraph.translated ?? "",
          },
        },
        "original",
      );
    });
  }
  fitTextLayers(boxes);
  return boxes;
}

function addRenderedBox(
  boxes: OverlayPopoverBox[],
  box: OverlayPopoverBox,
  boxMode: OverlayMode,
): void {
  const index = boxes.push(box) - 1;
  popover?.attach(box.element, index, boxMode);
}

function createTranslationBox(
  rect: Rect,
  text: string,
  vertical: boolean,
): HTMLElement {
  const box = document.createElement("div");
  box.className =
    "ocr-translate-overlay-box ocr-translate-overlay-translation-box";
  box.tabIndex = 0;
  box.setAttribute("role", "button");
  box.setAttribute("aria-haspopup", "dialog");
  box.setAttribute("aria-controls", OVERLAY_POPOVER_ID);
  positionRectElement(box, rect);

  const panel = document.createElement("span");
  panel.className = "ocr-translate-overlay-translation-text";
  panel.classList.toggle("is-vertical-source", vertical);
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
  return box;
}

// Pick the card's font and width. For vertical source text the font aims at
// the source's size; horizontal text starts from the largest font. In
// a speech bubble the card first tries the room inside it: if the text fits
// there at that font, the card keeps the line count it has across the room and
// narrows to even lines. Otherwise, the font shrinks if the text does not fit
// the whole box, down to the minimum, and then words may break. The card then
// takes the narrowest width that keeps the text from growing taller or
// breaking words, but stays as wide as the source text unless the translation
// is shorter. `clampToWholeLines` truncates whatever still overflows.
function fitTranslationCard(
  box: HTMLElement,
  {
    textSize,
    sourceWidth,
    vertical,
    expanded,
    bubbleRoom,
  }: {
    textSize: number;
    sourceWidth: number;
    vertical: boolean;
    expanded: boolean;
    bubbleRoom?: Rect;
  },
): void {
  const panel = box.firstElementChild;
  if (!(panel instanceof HTMLElement)) {
    return;
  }
  // Large horizontal text, such as a title, may get a larger font, in step
  // with its line height.
  const maxFontSize = vertical
    ? expanded
      ? MAX_FONT_PX_EXPANDED_VERTICAL_SOURCE
      : MAX_FONT_PX_VERTICAL_SOURCE
    : clamp(
        Math.round(textSize * FONT_PER_SOURCE_SIZE),
        MAX_FONT_PX_HORIZONTAL_SOURCE,
        MAX_FONT_PX_LARGE_HORIZONTAL_SOURCE,
      );
  const cap = Math.max(
    MIN_FONT_PX,
    Math.min(maxFontSize, Math.floor(box.clientHeight)),
  );
  // Horizontal text keeps the largest font that fits its box, so the card
  // covers the source lines.
  const target =
    vertical && textSize > 0
      ? clamp(Math.round(textSize * FONT_PER_SOURCE_SIZE), MIN_FONT_PX, cap)
      : cap;
  let maxWidth = box.clientWidth;
  // The tallest the card may grow. Raised below when even the smallest font
  // overflows the box, so narrowing never makes that worse.
  let maxHeight = box.clientHeight;
  const fits = (): boolean =>
    panel.offsetHeight <= maxHeight && !textOverflowsPanel(panel);

  // Without hyphenation a word too long for the line overflows, which `fits`
  // can see. Hyphenation would hide it by splitting the word.
  panel.style.hyphens = "manual";
  box.style.fontSize = `${target}px`;

  const roomWidth = bubbleRoom ? Math.min(maxWidth, bubbleRoom.width) : 0;
  panel.style.width = `${roomWidth}px`;
  if (
    bubbleRoom &&
    panel.offsetHeight <= Math.min(maxHeight, bubbleRoom.height) &&
    !textOverflowsPanel(panel)
  ) {
    maxWidth = roomWidth;
    maxHeight = panel.offsetHeight;
  } else {
    panel.style.width = `${maxWidth}px`;
    if (!fits()) {
      const font =
        largestFit(MIN_FONT_PX, target - 1, (size) => {
          box.style.fontSize = `${size}px`;
          return fits();
        }) ?? MIN_FONT_PX;
      box.style.fontSize = `${font}px`;
      if (!fits()) {
        // Still too big at the smallest font: break words rather than cut them.
        panel.style.removeProperty("hyphens");
        maxHeight = Math.max(maxHeight, panel.offsetHeight);
      }
    }
  }

  // Narrow without hyphenation even where the text needs it: the browser would
  // otherwise split words to keep the line count while the card narrows.
  const hyphens = panel.style.hyphens;
  panel.style.hyphens = "manual";
  // A one-line translation shorter than the source needs no more room. Read
  // the exact width: offsetWidth rounds, and a line a fraction of a pixel too
  // narrow wraps.
  panel.style.width = "max-content";
  const oneLine = panel.getBoundingClientRect().width;
  const minWidth = Math.ceil(Math.min(sourceWidth, oneLine, maxWidth));
  panel.style.width = `${narrowestFit(minWidth, maxWidth, (width) => {
    panel.style.width = `${width}px`;
    return fits();
  })}px`;
  panel.style.hyphens = hyphens;
  clampToWholeLines(panel, box);
}

// True when a line runs into the panel's side padding or past it. scrollWidth
// cannot tell: Chrome reports no overflow for this box at all, and Firefox only
// once the text passes the padding. A line wider than the panel starts at its
// start edge, so a centred card would show it hugging one side.
function textOverflowsPanel(panel: HTMLElement): boolean {
  const bounds = wordBounds(panel);
  if (!bounds) {
    return false;
  }
  const box = panel.getBoundingClientRect();
  const styles = getComputedStyle(panel);
  const left =
    box.left +
    Number.parseFloat(styles.borderLeftWidth) +
    Number.parseFloat(styles.paddingLeft);
  const right =
    box.right -
    Number.parseFloat(styles.borderRightWidth) -
    Number.parseFloat(styles.paddingRight);
  // Half a pixel of slack for subpixel text positions.
  return bounds.left < left - 0.5 || bounds.right > right + 0.5;
}

// The horizontal extent of the panel's words. Spaces are left out: with
// `pre-wrap` each line keeps its trailing space, which sits past the last word.
function wordBounds(panel: HTMLElement): { left: number; right: number } | undefined {
  const text = panel.firstChild;
  if (!text || text.nodeType !== Node.TEXT_NODE) {
    return undefined;
  }
  const range = document.createRange();
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const word of (text.textContent ?? "").matchAll(/\S+/g)) {
    range.setStart(text, word.index);
    range.setEnd(text, word.index + word[0].length);
    for (const rect of range.getClientRects()) {
      left = Math.min(left, rect.left);
      right = Math.max(right, rect.right);
    }
  }
  return left < right ? { left, right } : undefined;
}

/** The smallest value in [low, high] that `test` accepts, assuming it accepts
 * every value above one it accepts. Returns `high` when none is smaller. */
function narrowestFit(
  low: number,
  high: number,
  test: (value: number) => boolean,
): number {
  let best = high;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (test(mid)) {
      best = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return best;
}

/** The largest value in [low, high] that `test` accepts, assuming it accepts
 * every value below one it accepts. Undefined when it accepts none. */
function largestFit(
  low: number,
  high: number,
  test: (value: number) => boolean,
): number | undefined {
  let best: number | undefined;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (test(mid)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
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
  const clampLines = Math.max(1, lines);
  panel.querySelector(".ocr-translate-overlay-truncation-marker")?.remove();
  const contentHeight = panel.scrollHeight - padding;
  panel.style.setProperty("-webkit-line-clamp", `${clampLines}`);
  if (isClampTruncated(contentHeight, clampLines, lineHeight)) {
    panel.append(createTruncationMarker(panel));
  }
}

// Half a line of slack keeps rounding from flagging text that fits.
export function isClampTruncated(
  contentHeight: number,
  clampLines: number,
  lineHeight: number,
): boolean {
  return contentHeight > clampLines * lineHeight + lineHeight / 2;
}

// The clamp's ellipsis looks like one in the text itself, so a marker tells
// a cut-off translation from one that ends in "…".
function createTruncationMarker(panel: HTMLElement): HTMLElement {
  const marker = document.createElement("span");
  marker.className = "ocr-translate-overlay-truncation-marker";
  marker.setAttribute("aria-hidden", "true");
  marker.dataset.end =
    getComputedStyle(panel).direction === "rtl" ? "left" : "right";
  return marker;
}

function createBox(
  rect: Rect,
  text: string,
  lines: OverlayLine[],
  angle: number,
): HTMLElement {
  const box = document.createElement("div");
  box.className = "ocr-translate-overlay-box ocr-translate-overlay-frame-box";
  box.tabIndex = 0;
  box.setAttribute("role", "button");
  box.setAttribute("aria-haspopup", "dialog");
  box.setAttribute("aria-controls", OVERLAY_POPOVER_ID);
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
  return box;
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
  let mouseSelection = false;
  layer.addEventListener("pointerdown", (event) => {
    mouseSelection = event.pointerType === "mouse";
    beginSelection("layer");
  });
  layer.addEventListener("mousedown", (event) => {
    if (!mouseSelection) return;
    stopTextSelection?.();
    stopTextSelection = startTextSelection(event, layer, angle, endSelection);
  });
  // The screen-reader label above already carries the text.
  layer.setAttribute("aria-hidden", "true");

  for (const [index, line] of lines.entries()) {
    if (!line.text) {
      continue;
    }
    for (const piece of textLayerPieces(line, boxRect, angle)) {
      if (!piece.text) {
        continue;
      }
      const span = createTextLayerPiece(piece, line.vertical);
      span.dataset.line = `${index}`;
      span.dataset.character = `${Boolean(line.chars?.length)}`;
      layer.append(span);
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
function fitTextLayers(boxes: OverlayPopoverBox[]): void {
  const spans: HTMLElement[] = [];
  for (const box of boxes) {
    spans.push(
      ...box.element.querySelectorAll<HTMLElement>(
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
let stopTextSelection: (() => void) | undefined;

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
  stopTextSelection?.();
  stopTextSelection = undefined;
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

function modeLang(textMode: OverlayMode): LangCode | undefined {
  return textMode === "original" ? currentSourceLang : currentTargetLang;
}

function createToolbarDragHandle(bar: HTMLElement): HTMLButtonElement {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "ocr-translate-overlay-icon-button ocr-translate-overlay-drag";
  handle.innerHTML = DRAG_HANDLE_ICON;
  handle.title = t("overlayMoveToolbar");
  handle.setAttribute("aria-label", handle.title);

  let drag:
    | { pointerId: number; x: number; y: number; left: number; top: number }
    | undefined;

  const move = (x: number, y: number): void => {
    toolbarPosition = { x, y };
    positionToolbar();
    if (statusChip) {
      positionChip(statusChip);
    }
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !event.isPrimary || drag) {
      return;
    }
    drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: bar.offsetLeft,
      top: bar.offsetTop,
    };
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-dragging");
    event.preventDefault();
  });
  handle.addEventListener("pointermove", (event) => {
    if (drag?.pointerId !== event.pointerId) {
      return;
    }
    move(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
  });
  const stopDragging = (event: PointerEvent): void => {
    if (drag?.pointerId !== event.pointerId) {
      return;
    }
    drag = undefined;
    handle.classList.remove("is-dragging");
    if (handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
  };
  handle.addEventListener("pointerup", stopDragging);
  handle.addEventListener("pointercancel", stopDragging);
  handle.addEventListener("lostpointercapture", stopDragging);
  handle.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 40 : 10;
    let x = bar.offsetLeft;
    let y = bar.offsetTop;
    switch (event.key) {
      case "ArrowLeft":
        x -= step;
        break;
      case "ArrowRight":
        x += step;
        break;
      case "ArrowUp":
        y -= step;
        break;
      case "ArrowDown":
        y += step;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    move(x, y);
  });
  return handle;
}

function positionToolbar(): void {
  if (!toolbar || !currentRect) {
    return;
  }
  const rect = pageToViewportRect(currentRect);
  const width = toolbar.offsetWidth || 280;
  const height = toolbar.offsetHeight || 40;
  if (toolbarPosition) {
    toolbarPosition.x = clamp(
      toolbarPosition.x, 8, Math.max(8, window.innerWidth - width - 8),
    );
    toolbarPosition.y = clamp(
      toolbarPosition.y, 8, Math.max(8, window.innerHeight - height - 8),
    );
    toolbar.style.left = `${toolbarPosition.x}px`;
    toolbar.style.top = `${toolbarPosition.y}px`;
    return;
  }
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

  const icon = document.createElement("span");
  icon.className = "ocr-translate-overlay-status-icon";
  icon.innerHTML = RECOGNIZE_TEXT_ICON;

  const label = document.createElement("p");
  label.className = "ocr-translate-overlay-status-label";

  const progress = document.createElement("div");
  progress.className = "ocr-translate-overlay-progress";
  const fill = document.createElement("div");
  fill.className = "ocr-translate-overlay-progress-fill";
  progress.append(fill);

  updateLoadingChip = (next: PipelineStatus): void => {
    label.textContent = pipelineStatusMessage(next);
    const showsSpinner = pipelineStatusShowsSpinner(next);
    spinner.hidden = !showsSpinner;
    icon.hidden = showsSpinner;
    const fraction = pipelineStatusProgress(next);
    progress.hidden = fraction === undefined;
    fill.style.transform = `scaleX(${fraction ?? 0})`;
  };
  updateLoadingChip(status);

  chip.append(
    spinner,
    icon,
    label,
    iconButton(CLOSE_ICON, t("commonClose"), () => closeOverlay()),
    progress,
  );
  return chip;
}

function createErrorChip(args: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  onOpenSettings?: () => void;
  onDismiss?: () => void;
  showClose?: boolean;
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
    retry.textContent = args.retryLabel ?? t("commonRetry");
    retry.addEventListener("click", args.onRetry, { once: true });
    chip.append(retry);
  }
  if (args.onOpenSettings) {
    chip.append(
      iconButton(SETTINGS_ICON, t("commonSettings"), args.onOpenSettings),
    );
  }
  if (args.showClose !== false) {
    chip.append(
      iconButton(
        CLOSE_ICON,
        args.onDismiss ? t("commonDismiss") : t("commonClose"),
        args.onDismiss ?? (() => closeOverlay()),
      ),
    );
  }
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
  const toolbarRect = toolbar?.getBoundingClientRect();
  const y = toolbarRect && chip.classList.contains("is-error")
    ? toolbarErrorChipY(rect, height, window.innerHeight, toolbarRect)
    : clamp(
        rect.y + rect.height / 2 - height / 2,
        8,
        Math.max(8, window.innerHeight - height - 8),
      );
  chip.style.left = `${x}px`;
  chip.style.top = `${y}px`;
}

export function toolbarErrorChipY(
  rect: Rect,
  height: number,
  viewportHeight: number,
  toolbarRect: Pick<DOMRect, "top" | "bottom">,
): number {
  const margin = 8;
  const maxY = Math.max(margin, viewportHeight - height - margin);
  const candidates =
    toolbarRect.bottom <= rect.y
      ? [rect.y + rect.height + margin, toolbarRect.top - height - margin]
      : [rect.y - height - margin, toolbarRect.bottom + margin];
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
  Object.values(boxLayers).forEach((layer) => {
    layer.boxes.forEach((box) => {
      box.rect = moveRect(box.rect, dx, dy);
    });
  });
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
