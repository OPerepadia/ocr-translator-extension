import { browserApi } from "../../shared/browser";
import type { LangCode, PipelineResult, PipelineStatus, Rect } from "@/shared/types";
import {
  CHECK_ICON,
  CLOSE_ICON,
  COPY_ICON,
  MENU_ICON,
  SELECT_REGION_ICON,
  SETTINGS_ICON,
  SPEAK_ICON,
  STOP_SPEAK_ICON,
  TRANSLATE_ICON,
  WARNING_ICON,
} from "./icons";
import { createLanguagePill } from "./language-picker";
import { buildOverlayLayout, type OverlayLayout } from "./overlay-layout";
import { isSpeaking, requestSpeak, stopSpeaking } from "./tts";

const OVERLAY_SPEECH_OWNER = "overlay";

const PANEL_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
  '<rect x="4" y="4" width="16" height="16" rx="2.4" stroke="currentColor" stroke-width="1.8"/>' +
  '<path d="M8.5 8.5L13.5 13.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
  '<path d="M13.5 10.3V13.5H10.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<rect x="14.5" y="14.5" width="5" height="5" rx="1.2" fill="currentColor"/>' +
  "</svg>";

type OverlayMode = "translation" | "original";

let uiRoot: HTMLElement | undefined;
let container: HTMLElement | undefined;
let toolbar: HTMLElement | undefined;
let toggleButton: HTMLButtonElement | undefined;
let boxes: HTMLElement[] = [];
let boxRects: Rect[] = [];
let activeBoxIndex: number | undefined;
let regionBackdrop: HTMLElement | undefined;
let regionFrame: HTMLElement | undefined;
// The loading spinner shown over the region while OCR/translation runs, and its
// label, kept so repeated status updates patch the text without restarting the
// spinner animation.
let statusChip: HTMLElement | undefined;
let loadingLabel: HTMLElement | undefined;

let currentLayout: OverlayLayout | undefined;
let currentRect: Rect | undefined;
let mode: OverlayMode = "translation";
// The mode a fresh overlay opens in, from the Options page.
let defaultMode: OverlayMode = "translation";
let hasTranslationText = false;
// Full texts of the two modes, kept for the toolbar's copy action (box text
// isn't selectable: pointerdown activates the box instead).
let currentOriginalText = "";
let currentDisplayText = "";
let copyButton: HTMLButtonElement | undefined;
let speechButton: HTMLButtonElement | undefined;
let currentSourceLang: LangCode | undefined;
let currentTargetLang: LangCode | undefined;
let targetLanguages: LangCode[] = [];
// Source languages supported by the packaged recognizers, and the current
// selection shown by the toolbar's source pill (updated optimistically when
// the user picks one).
let ocrSourceLanguages: Array<{ id: string; label: string }> = [];
let currentSourceLanguageId: string | undefined;

let onClose: (() => void) | undefined;
let onShowPanel: (() => void) | undefined;
let onNewSelection: (() => void) | undefined;
let onTargetLangChange: ((targetLang: LangCode) => void) | undefined;
let onSourceLanguageChange:
  | ((sourceLang: LangCode | "auto") => void)
  | undefined;

let keydownHandler: ((event: KeyboardEvent) => void) | undefined;
let resizeHandler: (() => void) | undefined;
let scrollHandler: (() => void) | undefined;
let outsideClickHandlers: Array<(event: MouseEvent) => void> = [];
let anchor:
  | {
      element: Element;
      x: number;
      y: number;
    }
  | undefined;

// Smallest/largest font the auto-fit will use inside a box.
const MIN_FONT_PX = 8;
const MAX_FONT_PX = 40;

/** Provide the shadow-root container the overlay renders into. */
export function setOverlayUiRoot(root: HTMLElement): void {
  uiRoot = root;
}

/** Set which text (translation or original) a new overlay shows first. */
export function setOverlayDefaultMode(nextMode: OverlayMode): void {
  defaultMode = nextMode;
}

/** Register a callback invoked when the overlay is closed. */
export function setOnOverlayClose(handler: () => void): void {
  onClose = handler;
}

/** Register a callback invoked when the user switches back to the panel. */
export function setOnShowPanel(handler: () => void): void {
  onShowPanel = handler;
}

/** Register a callback invoked when the user picks "Select new region". */
export function setOnOverlayNewSelection(handler: () => void): void {
  onNewSelection = handler;
}

/** Register a callback invoked when the user picks a new target language. */
export function setOnOverlayTargetLangChange(
  handler: (targetLang: LangCode) => void,
): void {
  onTargetLangChange = handler;
}

/** Provide the languages the active translation provider supports (codes). */
export function setOverlayTargetLanguages(languages: LangCode[]): void {
  targetLanguages = languages;
  rerenderToolbar();
}

/** Provide the OCR source languages and the currently selected one. */
export function setOverlayOcrSourceLanguages(
  languages: Array<{ id: string; label: string }>,
  currentId: string,
): void {
  ocrSourceLanguages = languages;
  currentSourceLanguageId = currentId;
  rerenderToolbar();
}

/** Register a callback invoked when the user picks a source language. */
export function setOnOverlaySourceLanguageChange(
  handler: (sourceLang: LangCode | "auto") => void,
): void {
  onSourceLanguageChange = handler;
}

/** The text to draw in translation mode, if this result has overlay content. */
export function overlayDisplayText(result: PipelineResult): string | undefined {
  if (result.translation) {
    return result.translation.text;
  }
  if (result.translationStatus.state === "same_language") {
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

/** Draw the translated result as boxes over the selected page region. Assumes
 * isOverlayable(result) is true. */
export function showOverlay(args: {
  result: PipelineResult;
  rect: Rect;
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
  currentSourceLang =
    result.translation?.sourceLang ??
    result.ocr.lang ??
    result.translationStatus.sourceLang ??
    (currentSourceLanguageId !== "auto"
      ? currentSourceLanguageId
      : undefined);
  currentTargetLang = overlayTargetLanguage(result);
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
  activeBoxIndex = undefined;

  render();
}

/** Show a spinner with the current pipeline stage, centered over the region.
 * Repeated calls patch the label in place so the spinner doesn't restart. */
export function showOverlayLoading(
  rect: Rect,
  status: PipelineStatus = { stage: "recognizing" },
): void {
  currentRect = rect;

  if (container && loadingLabel) {
    loadingLabel.textContent = statusMessage(status);
    reposition();
    return;
  }

  captureAnchor();
  renderLoading(status);
}

/** Show an error chip over the region so a failure doesn't bounce the user to
 * the panel. Retry and Settings buttons appear when callbacks are given. */
export function showOverlayError(args: {
  rect: Rect;
  message: string;
  onRetry?: () => void;
  onOpenSettings?: () => void;
}): void {
  currentRect = args.rect;
  captureAnchor();
  // Unlike the loading chip, there's no label to patch in place; drop the stale
  // reference so a later showOverlayLoading rebuilds instead of patching it.
  loadingLabel = undefined;
  mountChip(createErrorChip(args));
}

/** Remove the overlay and detach its listeners. No-op if it isn't open. */
export function closeOverlay(): void {
  if (isSpeaking(OVERLAY_SPEECH_OWNER)) {
    stopSpeaking();
  }
  if (!container) {
    return;
  }
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
  container.remove();
  container = undefined;
  toolbar = undefined;
  toggleButton = undefined;
  copyButton = undefined;
  speechButton = undefined;
  boxes = [];
  boxRects = [];
  activeBoxIndex = undefined;
  regionBackdrop = undefined;
  regionFrame = undefined;
  statusChip = undefined;
  loadingLabel = undefined;
  currentLayout = undefined;
  currentRect = undefined;
  hasTranslationText = false;
  currentOriginalText = "";
  currentDisplayText = "";
  currentSourceLang = undefined;
  currentTargetLang = undefined;
  anchor = undefined;
  onClose?.();
}

function render(): void {
  // Rebuild from scratch so a re-translate clears the busy state cleanly.
  clearOutsideClickHandlers();
  if (container) {
    container.remove();
  }

  container = document.createElement("div");
  container.className = "ocr-translate-overlay";

  // A settled result replaces any loading spinner.
  statusChip = undefined;
  loadingLabel = undefined;
  regionBackdrop = undefined;
  regionFrame = undefined;

  if (currentRect) {
    regionBackdrop = createRegionBackdrop(currentRect);
    regionFrame = createRegionFrame(currentRect);
    container.append(regionBackdrop, regionFrame);
  }
  toolbar = createToolbar();
  container.append(toolbar);

  (uiRoot ?? document.documentElement).append(container);
  renderBoxes();
  positionToolbar();
  ensureGlobalHandlers();
}

// Show the loading spinner over the region. Rebuilds the container so it cleanly
// replaces a stale result view; the region frame marks the captured area.
function renderLoading(status: PipelineStatus): void {
  mountChip(createLoadingChip(status));
}

// Replace whatever is on screen with a fresh container holding the region
// backdrop/frame and the given chip, centered over the region.
function mountChip(chip: HTMLElement): void {
  if (isSpeaking(OVERLAY_SPEECH_OWNER)) {
    stopSpeaking();
  }
  if (container) {
    container.remove();
  }
  boxes = [];
  boxRects = [];
  activeBoxIndex = undefined;
  toolbar = undefined;
  toggleButton = undefined;
  copyButton = undefined;
  speechButton = undefined;
  clearOutsideClickHandlers();
  currentLayout = undefined;
  regionBackdrop = undefined;
  regionFrame = undefined;

  container = document.createElement("div");
  container.className = "ocr-translate-overlay";
  if (currentRect) {
    regionBackdrop = createRegionBackdrop(currentRect);
    regionFrame = createRegionFrame(currentRect);
    container.append(regionBackdrop, regionFrame);
  }

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
}

function clearOutsideClickHandlers(): void {
  for (const handler of outsideClickHandlers) {
    document.removeEventListener("click", handler);
  }
  outsideClickHandlers = [];
}

function rerenderToolbar(): void {
  if (!toolbar) {
    return;
  }
  clearOutsideClickHandlers();
  const nextToolbar = createToolbar();
  toolbar.replaceWith(nextToolbar);
  toolbar = nextToolbar;
  positionToolbar();
}

function createToolbar(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "ocr-translate-overlay-toolbar";

  const toggleWrapper = document.createElement("span");
  toggleWrapper.className = "ocr-translate-overlay-toggle-wrap";
  if (!hasTranslationText) {
    toggleWrapper.title = "The text is already in target language";
  }

  toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "ocr-translate-overlay-switch";
  toggleButton.setAttribute("role", "switch");
  toggleButton.disabled = !hasTranslationText;
  const knob = document.createElement("span");
  knob.className = "ocr-translate-overlay-switch-knob";
  knob.innerHTML = TRANSLATE_ICON;
  toggleButton.append(knob);
  updateToggleLabel();
  toggleButton.addEventListener("click", () => {
    if (isSpeaking(OVERLAY_SPEECH_OWNER)) {
      stopSpeaking();
    }
    mode = mode === "translation" ? "original" : "translation";
    updateToggleLabel();
    updateCopyLabel();
    updateSpeechButton();
    renderBoxes();
  });
  toggleWrapper.append(toggleButton);

  copyButton = createCopyButton();
  updateCopyLabel();
  speechButton = createSpeechButton();

  const sourcePicker = createSourceLanguagePicker();
  const languagePicker = createLanguagePicker();
  const menu = createMenu();
  outsideClickHandlers.push(menu.handleOutsideClick);
  const selectButton = iconButton(SELECT_REGION_ICON, "Select new region", () => {
    closeOverlay();
    onNewSelection?.();
  });
  const closeButton = iconButton(CLOSE_ICON, "Close", () => {
    closeOverlay();
  });

  const divider = document.createElement("span");
  divider.className = "ocr-translate-overlay-divider";
  divider.setAttribute("aria-hidden", "true");

  // The switch sits between the pills: knob left shows the source text, knob
  // right the translation. It replaces the old "→" direction arrow.
  if (sourcePicker) {
    bar.append(sourcePicker);
  }
  bar.append(toggleWrapper);
  if (languagePicker) {
    bar.append(languagePicker);
  }
  bar.append(
    speechButton,
    copyButton,
    selectButton,
    menu.element,
    divider,
    closeButton,
  );
  return bar;
}

function updateToggleLabel(): void {
  if (!toggleButton) {
    return;
  }
  const showingTranslation = mode === "translation";
  toggleButton.setAttribute("aria-checked", String(showingTranslation));
  const label = showingTranslation ? "Show original" : "Show translation";
  toggleButton.setAttribute("aria-label", label);
  if (hasTranslationText) {
    toggleButton.title = label;
  }
}

function createMenu(): {
  element: HTMLElement;
  handleOutsideClick: (event: MouseEvent) => void;
} {
  const wrapper = document.createElement("div");
  wrapper.className = "ocr-translate-popup-menu ocr-translate-overlay-menu";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "ocr-translate-overlay-icon-button";
  button.setAttribute("aria-label", "Menu");
  button.setAttribute("aria-haspopup", "true");
  button.setAttribute("aria-expanded", "false");
  button.title = "Menu";
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

  addItem(PANEL_ICON, "Show in panel", () => onShowPanel?.());
  addItem(SETTINGS_ICON, "Settings", () => {
    void browserApi.runtime.sendMessage({ type: "OPEN_OPTIONS" });
  });

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
  return { element: wrapper, handleOutsideClick };
}

function createCopyButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className =
    "ocr-translate-overlay-icon-button ocr-translate-overlay-copy";
  button.innerHTML = COPY_ICON;

  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener("click", async () => {
    const text = mode === "original" ? currentOriginalText : currentDisplayText;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    button.innerHTML = CHECK_ICON;
    button.classList.add("is-copied");
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      button.innerHTML = COPY_ICON;
      button.classList.remove("is-copied");
    }, 1500);
  });

  return button;
}

function createSpeechButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className =
    "ocr-translate-overlay-icon-button ocr-translate-overlay-speak";
  setOverlaySpeakButtonState(button, isSpeaking(OVERLAY_SPEECH_OWNER));

  button.addEventListener("click", () => {
    if (isSpeaking(OVERLAY_SPEECH_OWNER)) {
      stopSpeaking();
      return;
    }

    requestSpeak({
      text: mode === "original" ? currentOriginalText : currentDisplayText,
      lang: mode === "original" ? currentSourceLang : currentTargetLang,
      owner: OVERLAY_SPEECH_OWNER,
      onStart: () => updateSpeechButton(true),
      onEnd: () => updateSpeechButton(false),
    });
  });

  return button;
}

function updateSpeechButton(
  active = isSpeaking(OVERLAY_SPEECH_OWNER),
): void {
  if (speechButton) {
    setOverlaySpeakButtonState(speechButton, active);
  }
}

function setOverlaySpeakButtonState(
  button: HTMLButtonElement,
  active: boolean,
): void {
  const label = active ? "Stop speaking" : "Read aloud";
  button.innerHTML = active ? STOP_SPEAK_ICON : SPEAK_ICON;
  button.classList.toggle("is-speaking", active);
  button.setAttribute("aria-label", label);
  button.title = label;
}

// Keep the copy button's tooltip in step with the mode toggle. When there's no
// translation both modes show the same text, so the label stays generic.
function updateCopyLabel(): void {
  if (!copyButton) {
    return;
  }
  const label = !hasTranslationText
    ? "Copy text"
    : mode === "translation"
      ? "Copy translation"
      : "Copy original text";
  copyButton.setAttribute("aria-label", label);
  copyButton.title = label;
}

// The source-language pill: picking one re-runs OCR on the same capture with
// the matching recognizer. Mirrors the panel's source pill.
function createSourceLanguagePicker(): HTMLElement | undefined {
  if (ocrSourceLanguages.length < 2) {
    return undefined;
  }
  const pill = createLanguagePill({
    target: currentSourceLanguageId ?? "auto",
    languages: ocrSourceLanguages
      .map(({ id }) => id)
      .filter((id) => id !== "auto"),
    specialEntries: [
      {
        code: "auto",
        name:
          ocrSourceLanguages.find(({ id }) => id === "auto")?.label ?? "Auto",
      },
    ],
    position: "auto",
    title: (name) => `Source language: ${name}`,
    onChange: (sourceLang) => {
      if (sourceLang !== currentSourceLanguageId) {
        currentSourceLanguageId = sourceLang;
        onSourceLanguageChange?.(sourceLang);
      }
    },
  });
  outsideClickHandlers.push(pill.handleOutsideClick);
  return pill.element;
}

function createLanguagePicker(): HTMLElement | undefined {
  if (!currentTargetLang) {
    return undefined;
  }

  const pill = createLanguagePill({
    target: currentTargetLang,
    languages: targetLanguages,
    position: "auto",
    onChange: (targetLang) => {
      if (targetLang !== currentTargetLang) {
        currentTargetLang = targetLang;
        onTargetLangChange?.(targetLang);
      }
    },
  });
  outsideClickHandlers.push(pill.handleOutsideClick);
  return pill.element;
}

function renderBoxes(): void {
  if (!container || !currentLayout) {
    return;
  }
  const overlayContainer = container;
  for (const box of boxes) {
    box.remove();
  }
  boxes = [];
  boxRects = [];

  const showOriginal = mode === "original";

  // Translation view without a per-paragraph split: one combined box so the
  // text is never misattributed to the wrong region.
  if (!showOriginal && !currentLayout.segmented) {
    const box = createBox(
      currentLayout.combinedRect,
      currentLayout.combinedTranslation,
      0,
      currentLayout.combinedBackgroundTone,
    );
    overlayContainer.append(box);
    boxes.push(box);
    boxRects.push(currentLayout.combinedRect);
    if (activeBoxIndex !== undefined) {
      box.classList.add("is-active");
    }
  } else {
    currentLayout.paragraphs.forEach((paragraph, index) => {
      const text = showOriginal
        ? paragraph.original
        : (paragraph.translated ?? "");
      const rect = showOriginal
        ? paragraph.sourceRect
        : paragraph.translationRect;
      const box = createBox(rect, text, index, paragraph.backgroundTone);
      box.classList.toggle("is-vertical", showOriginal && paragraph.vertical);
      overlayContainer.append(box);
      boxes.push(box);
      boxRects.push(rect);
      box.classList.toggle("is-active", index === activeBoxIndex);
    });
  }

  // Fit fonts after all boxes are in the DOM so each measures a settled layout.
  for (const box of boxes) {
    fitFontSize(box);
  }
}

function createBox(
  rect: Rect,
  text: string,
  index: number,
  backgroundTone: "light" | "dark",
): HTMLElement {
  const box = document.createElement("div");
  box.className = "ocr-translate-overlay-box";
  box.classList.add(`is-${backgroundTone}`);
  box.tabIndex = 0;
  positionRectElement(box, rect);
  box.textContent = text;
  box.dir = "auto";
  const lang = mode === "original" ? currentSourceLang : currentTargetLang;
  if (lang) {
    box.lang = lang;
  }
  box.addEventListener("pointerdown", () => activateBox(box, index));
  box.addEventListener("focus", () => activateBox(box, index));
  return box;
}

function activateBox(activeBox: HTMLElement, index: number): void {
  activeBoxIndex = index;
  for (const box of boxes) {
    box.classList.toggle("is-active", box === activeBox);
  }
}

// Shrink the font with a binary search until the text fits the box, flooring at
// MIN_FONT_PX (the box then scrolls internally if it still overflows).
function fitFontSize(box: HTMLElement): void {
  const cap = Math.max(
    MIN_FONT_PX,
    Math.min(MAX_FONT_PX, Math.floor(box.clientHeight)),
  );
  let lo = MIN_FONT_PX;
  let hi = cap;
  let best = MIN_FONT_PX;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    box.style.fontSize = `${mid}px`;
    if (
      box.scrollHeight <= box.clientHeight &&
      box.scrollWidth <= box.clientWidth
    ) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  box.style.fontSize = `${best}px`;
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
  const y =
    belowY + height <= window.innerHeight - 8
      ? belowY
      : aboveY >= 8
        ? aboveY
        : clamp(belowY, 8, Math.max(8, window.innerHeight - height - 8));
  toolbar.style.left = `${x}px`;
  toolbar.style.top = `${y}px`;
}

function createLoadingChip(status: PipelineStatus): HTMLElement {
  const chip = document.createElement("div");
  chip.className = "ocr-translate-overlay-status";

  const spinner = document.createElement("div");
  spinner.className = "ocr-translate-overlay-spinner";

  loadingLabel = document.createElement("p");
  loadingLabel.className = "ocr-translate-overlay-status-label";
  loadingLabel.textContent = statusMessage(status);

  chip.append(spinner, loadingLabel, iconButton(CLOSE_ICON, "Close", closeOverlay));
  return chip;
}

function createErrorChip(args: {
  message: string;
  onRetry?: () => void;
  onOpenSettings?: () => void;
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
    retry.textContent = "Retry";
    retry.addEventListener("click", args.onRetry, { once: true });
    chip.append(retry);
  }
  if (args.onOpenSettings) {
    chip.append(iconButton(SETTINGS_ICON, "Settings", args.onOpenSettings));
  }
  chip.append(iconButton(CLOSE_ICON, "Close", closeOverlay));
  return chip;
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
  const y = clamp(
    rect.y + rect.height / 2 - height / 2,
    8,
    Math.max(8, window.innerHeight - height - 8),
  );
  chip.style.left = `${x}px`;
  chip.style.top = `${y}px`;
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
  if (!currentLayout) {
    return;
  }
  currentLayout = {
    ...currentLayout,
    paragraphs: currentLayout.paragraphs.map((paragraph) => ({
      ...paragraph,
      sourceRect: moveRect(paragraph.sourceRect, dx, dy),
      translationRect: moveRect(paragraph.translationRect, dx, dy),
    })),
    combinedRect: moveRect(currentLayout.combinedRect, dx, dy),
  };
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

function statusMessage(status: PipelineStatus): string {
  switch (status.stage) {
    case "initializing":
      return "Initializing OCR engine…";
    case "recognizing":
      return status.lineCount && status.lineCount > 0
        ? `Recognizing text… ${status.line}/${status.lineCount}`
        : "Analyzing image…";
    case "translating":
      return "Translating…";
  }
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
