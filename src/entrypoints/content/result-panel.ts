import { browserApi } from "@/shared/browser";
import type {
  LangCode,
  PipelineOcrResult,
  PipelineResult,
  PipelineStatus,
  SerializedError,
} from "@/shared/types";
import {
  CHECK_ICON,
  CLOSE_ICON,
  COPY_ICON,
  MENU_ICON,
  SELECT_REGION_ICON,
  SETTINGS_ICON,
  SPEAK_ICON,
  STOP_SPEAK_ICON,
  WARNING_ICON,
} from "./icons";
import {
  CHEVRON_ICON,
  createLanguagePill,
  languageName,
} from "./language-picker";
import { sendRequest } from "@/shared/runtime-messaging";
import { t } from "@/shared/i18n";
import { isSpeaking, requestSpeak, stopSpeaking } from "./tts";

const ORIGINAL_SPEECH_OWNER = "panel-original";
const TRANSLATION_SPEECH_OWNER = "panel-translation";

const OVERLAY_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
  '<rect x="4" y="4" width="16" height="16" rx="2.2" stroke="currentColor" stroke-width="1.9"/>' +
  '<path d="M7 11.8L10.4 7.7L13 11.8L15 9.2L17.4 11.8Z" fill="currentColor"/>' +
  '<path d="M7.5 14H16.5M7.5 16.5H16.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>' +
  "</svg>";

// Extension logo shown in the panel title. Multi-color mark (not a
// currentColor UI glyph), inlined so it needs no web-accessible resource.
const LOGO_ICON =
  '<svg viewBox="0 0 128 128" width="20" height="20" aria-hidden="true" focusable="false">' +
  '<rect x="0" y="0" width="128" height="128" rx="18" fill="#f5f7fa"/>' +
  '<path d="M10,38 L10,20 Q10,10 20,10 L38,10" fill="none" stroke="#3e7bd6" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M90,10 L108,10 Q118,10 118,20 L118,38" fill="none" stroke="#3e7bd6" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M38,118 L20,118 Q10,118 10,108 L10,90" fill="none" stroke="#3e7bd6" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<line x1="30" y1="50" x2="100" y2="50" stroke="#3e7bd6" stroke-width="12" stroke-linecap="round"/>' +
  '<line x1="30" y1="66" x2="70" y2="66" stroke="#3e7bd6" stroke-width="12" stroke-linecap="round"/>' +
  '<line x1="30" y1="82" x2="54" y2="82" stroke="#3e7bd6" stroke-width="12" stroke-linecap="round"/>' +
  '<circle cx="86" cy="92" r="22" fill="#f5f7fa" stroke="#E8590C" stroke-width="12"/>' +
  '<line x1="103" y1="109" x2="118" y2="124" stroke="#E8590C" stroke-width="14" stroke-linecap="round"/>' +
  "</svg>";

const MENU_ITEMS: ReadonlyArray<{
  messageKey: string;
  icon: string;
  onSelect: () => void;
}> = [
  {
    messageKey: "commonSettings",
    icon: SETTINGS_ICON,
    onSelect: () => {
      void sendRequest({ type: "OPEN_OPTIONS" });
    },
  },
];

let popup: HTMLElement | undefined;
// Remember the recognized text so progress/translation re-renders keep showing
// it without re-running OCR.
let currentOcrText = "";
// Notifies the caller when the user closes the popup
let onClose: (() => void) | undefined;
// Invoked when the user picks "Select new region" from the menu
let onNewSelection: (() => void) | undefined;
let onShowOverlay: (() => void) | undefined;
let overlayAvailable = false;
let overlayMenuItemRef: HTMLButtonElement | undefined;
// Invoked when the user picks a new target language from the language pill.
let onTargetLangChange: ((targetLang: LangCode) => void) | undefined;
// Source/target languages of the current result, shown in the language pill.
let currentSourceLang: LangCode | undefined;
let currentTargetLang: LangCode | undefined;
// Languages the active translation provider can translate into (codes).
let targetLanguages: LangCode[] = [];
// Source languages supported by the packaged recognizers, and the current
// selection (updated optimistically when the user picks one from the picker).
let ocrSourceLanguages: Array<{ id: string; label: string }> = [];
let currentSourceLanguageId: string | undefined;
let onSourceLanguageChange:
  | ((sourceLang: LangCode | "auto") => void)
  | undefined;
// Translation providers the user can switch between in the panel, and the current
// selection (updated optimistically when the user picks one from the picker).
let translationProviders: Array<{ id: string; label: string }> = [];
let currentProviderId: string | undefined;
// Invoked when the user picks a different translation provider from the picker.
let onProviderChange: ((providerId: string) => void) | undefined;
// Invoked when the user clicks Translate for the editable recognized text.
let onTranslateRequest:
  | ((text: string, targetLang: LangCode | undefined) => void)
  | undefined;
// Live reference to the editable recognized-text box, so the Translate button
// always sends the current text.
let recognizedBoxRef: HTMLTextAreaElement | undefined;
// While a translation is in flight the recognized box is locked. The translation
// runs against the text as it was when the request started, and the result
// re-renders the box from that text — so an edit made mid-translation would be
// silently discarded. Locking the box prevents that lost edit.
let recognizedReadOnly = false;
// Document-level outside-click handlers for open dropdowns, detached on close.
let outsideClickHandlers: Array<(event: MouseEvent) => void> = [];
// Shadow-root container the popup is mounted into, set once the content script
// creates the UI. Keeps page CSS from leaking into the popup.
let uiRoot: HTMLElement | undefined;
// Patches the loading-state label and progress bar, so status updates apply in
// place instead of rebuilding the spinner (which would restart its animation).
let updateLoadingRef: ((status: PipelineStatus) => void) | undefined;
// Width/height (px) the user picked by dragging the corner resize handle.
// Remembered across re-renders and reopens within the page session; undefined
// means use the CSS default size.
let panelWidth: number | undefined;
let panelHeight: number | undefined;

// Gap (px) the panel keeps from the viewport's right/bottom edges. Matches the
// CSS `right`/`bottom`, so the resize math anchors to the same corner.
const PANEL_MARGIN = 8;

// storage.local key holding the user's last dragged panel size, so it persists
// across page reloads and tabs.
const PANEL_SIZE_KEY = "panelSize";

// True once the user drags the handle. Guards against a late-resolving load of
// the saved size clobbering dimensions the user just chose by hand.
let userResized = false;

// Smallest/largest size the resize handle allows.
const MIN_PANEL_WIDTH = 320;
const MIN_PANEL_HEIGHT = 240;
function maxPanelWidth(): number {
  return Math.round(window.innerWidth - PANEL_MARGIN * 2);
}
function maxPanelHeight(): number {
  return Math.round(window.innerHeight - PANEL_MARGIN * 2);
}

function clampPanelWidth(width: number): number {
  return Math.min(Math.max(Math.round(width), MIN_PANEL_WIDTH), maxPanelWidth());
}
function clampPanelHeight(height: number): number {
  return Math.min(
    Math.max(Math.round(height), MIN_PANEL_HEIGHT),
    maxPanelHeight(),
  );
}

// Read the saved panel size and apply it. Clamps to the current viewport so a
// size saved on a big screen doesn't overflow a smaller one. Skipped if the
// user has already dragged the handle this session.
async function loadPanelSize(): Promise<void> {
  let stored: unknown;
  try {
    const values = await browserApi.storage.local.get(PANEL_SIZE_KEY);
    stored = values[PANEL_SIZE_KEY];
  } catch {
    return;
  }
  if (userResized || !stored || typeof stored !== "object") {
    return;
  }
  const { width, height } = stored as { width?: unknown; height?: unknown };
  if (typeof width === "number") {
    panelWidth = clampPanelWidth(width);
  }
  if (typeof height === "number") {
    panelHeight = clampPanelHeight(height);
  }
  // If the popup is already open at its default size, apply the restored size.
  if (popup) {
    if (panelWidth !== undefined) {
      popup.style.width = `${panelWidth}px`;
    }
    if (panelHeight !== undefined) {
      popup.style.height = `${panelHeight}px`;
    }
    updateLayoutMode();
  }
}

// Persist the current dragged size. Fire-and-forget; a failed write just means
// the size isn't remembered next time.
function savePanelSize(): void {
  if (panelWidth === undefined || panelHeight === undefined) {
    return;
  }
  void browserApi.storage.local.set({
    [PANEL_SIZE_KEY]: { width: panelWidth, height: panelHeight },
  });
}

// Kick off the restore as soon as the content script loads, so the saved size is
// usually ready before the first capture opens the popup.
void loadPanelSize();

// Once the panel is at least this fraction of the viewport wide, the recognized
// text and translation switch from stacked to side by side.
const WIDE_LAYOUT_RATIO = 2 / 5;
// Recomputes the layout mode on viewport resize; detached when the popup closes.
let windowResizeHandler: (() => void) | undefined;

// Toggle the side-by-side layout based on the panel's current width vs. the
// viewport. Uses the dragged width when known, otherwise measures the element.
function updateLayoutMode(): void {
  if (!popup) {
    return;
  }
  const width = panelWidth ?? popup.getBoundingClientRect().width;
  popup.classList.toggle("is-wide", width >= window.innerWidth * WIDE_LAYOUT_RATIO);
}

/** Provide the shadow-root container that the popup renders into. */
export function setUiRoot(root: HTMLElement): void {
  uiRoot = root;
}

/** Register a callback invoked when the user closes the popup. */
export function setOnClose(handler: () => void): void {
  onClose = handler;
}

/** Register a callback invoked when the user picks "Select new region". */
export function setOnNewSelection(handler: () => void): void {
  onNewSelection = handler;
}

export function setOnShowOverlay(handler: () => void): void {
  onShowOverlay = handler;
}

export function setOverlayAvailable(value: boolean): void {
  overlayAvailable = value;
  if (overlayMenuItemRef) {
    overlayMenuItemRef.hidden = !value;
  }
}

/** Register a callback invoked when the user picks a new target language. */
export function setOnTargetLangChange(
  handler: (targetLang: LangCode) => void,
): void {
  onTargetLangChange = handler;
}

/** Provide the languages the active translation provider supports (codes). */
export function setTargetLanguages(languages: LangCode[]): void {
  targetLanguages = languages;
}

/** Provide the OCR source languages and the currently selected one. */
export function setOcrSourceLanguages(
  languages: Array<{ id: string; label: string }>,
  currentId: string,
): void {
  ocrSourceLanguages = languages;
  currentSourceLanguageId = currentId;
}

/** Register a callback invoked when the user picks a source language. */
export function setOnSourceLanguageChange(
  handler: (sourceLang: LangCode | "auto") => void,
): void {
  onSourceLanguageChange = handler;
}

/** Provide the translation providers and the currently active one for the picker. */
export function setTranslationProviders(
  providers: Array<{ id: string; label: string }>,
  currentId: string,
): void {
  translationProviders = providers;
  currentProviderId = currentId;
}

/** Register a callback invoked when the user picks a different provider. */
export function setOnProviderChange(
  handler: (providerId: string) => void,
): void {
  onProviderChange = handler;
}

/** Register a callback invoked when the user clicks Translate for the editable
 * recognized text. Receives the edited text and the panel's current target. */
export function setOnTranslateRequest(
  handler: (text: string, targetLang: LangCode | undefined) => void,
): void {
  onTranslateRequest = handler;
}

// Lock or unlock the recognized box for editing. Applies to the live box (for the
// in-place translation swap, which keeps the same textarea) and to the flag that
// rebuilt boxes read, so the state survives a full re-render too.
function setRecognizedReadOnly(readOnly: boolean): void {
  recognizedReadOnly = readOnly;
  if (recognizedBoxRef) {
    recognizedBoxRef.readOnly = readOnly;
  }
}

/** Forget the previous result's languages/text so a new capture doesn't show a
 * stale language pill (or re-translate the old text) before its result lands. */
export function resetForNewCapture(): void {
  currentSourceLang = undefined;
  currentSourceLanguageId = "auto";
  currentTargetLang = undefined;
  currentOcrText = "";
  recognizedReadOnly = false;
}

export interface ClosePopupOptions {
  notify?: boolean;
}

/** Remove the popup and detach its listeners. No-op if it isn't open. */
export function closePopup(options: ClosePopupOptions = {}): void {
  if (
    isSpeaking(ORIGINAL_SPEECH_OWNER) ||
    isSpeaking(TRANSLATION_SPEECH_OWNER)
  ) {
    stopSpeaking();
  }
  if (!popup) {
    return;
  }
  for (const handler of outsideClickHandlers) {
    document.removeEventListener("click", handler);
  }
  outsideClickHandlers = [];
  if (windowResizeHandler) {
    window.removeEventListener("resize", windowResizeHandler);
    windowResizeHandler = undefined;
  }
  popup.remove();
  popup = undefined;
  updateLoadingRef = undefined;
  recognizedBoxRef = undefined;
  overlayMenuItemRef = undefined;
  if (options.notify !== false) {
    onClose?.();
  }
}

export function showLoading(
  status: PipelineStatus = { stage: "recognizing" },
): void {
  // When re-translating, the recognized text is already known, so keep it on
  // screen and only show a placeholder in the translation slot instead of
  // blanking the whole panel.
  if (status.stage === "translating" && currentOcrText) {
    // Lock the box for the duration of the translation so edits can't be lost
    // when the result re-renders it. Set before building/swapping so both the
    // in-place box and any rebuilt one come up locked.
    setRecognizedReadOnly(true);
    renderPopup([createRecognizedSection(), createTranslatingSection()]);
    return;
  }
  // The spinner is a CSS animation on a DOM node; rebuilding that node on every
  // line-count update would restart it and make it stutter. Once the loading
  // view is up, just patch the label text in place.
  if (updateLoadingRef) {
    updateLoadingRef(status);
    return;
  }
  const loading = createLoading(status);
  renderPopup([loading.element]);
  updateLoadingRef = loading.update;
}

export function showRecognizedTextWhileTranslating(
  ocr: PipelineOcrResult,
): void {
  currentOcrText = ocr.text;
  currentSourceLang =
    ocr.lang ??
    (currentSourceLanguageId !== "auto" ? currentSourceLanguageId : undefined);
  setRecognizedReadOnly(true);
  renderPopup([createRecognizedSection(), createTranslatingSection()]);
}

function statusMessage(status: PipelineStatus): string {
  switch (status.stage) {
    case "loading":
      return "Loading image…";
    case "initializing":
      return t("statusInitializingOcr");
    case "recognizing":
      return status.lineCount && status.lineCount > 0
        ? t("statusRecognizingText")
        : t("statusAnalyzingImage");
    case "translating":
      return t("statusTranslating");
  }
}

// Fraction of recognized lines, or undefined while the stage has no line counts
// to report and the progress bar should stay hidden.
function statusProgress(status: PipelineStatus): number | undefined {
  if (status.stage !== "recognizing") {
    return undefined;
  }
  const { line, lineCount } = status;
  if (line === undefined || !lineCount || lineCount <= 0) {
    return undefined;
  }
  return Math.min(Math.max(line / lineCount, 0), 1);
}

// A centered loading state: a spinner with the current stage below it, plus a
// progress bar while lines are being recognized. Returns a patcher so callers
// can update it without a re-render.
function createLoading(status: PipelineStatus): {
  element: HTMLElement;
  update: (status: PipelineStatus) => void;
} {
  const wrapper = document.createElement("div");
  wrapper.className = "ocr-translate-popup-loading";

  const spinner = document.createElement("div");
  spinner.className = "ocr-translate-popup-spinner";

  const label = document.createElement("p");
  label.className = "ocr-translate-popup-loading-label";

  const progress = document.createElement("div");
  progress.className = "ocr-translate-popup-progress";
  const fill = document.createElement("div");
  fill.className = "ocr-translate-popup-progress-fill";
  progress.append(fill);

  const update = (next: PipelineStatus): void => {
    label.textContent = statusMessage(next);
    const fraction = statusProgress(next);
    progress.hidden = fraction === undefined;
    fill.style.transform = `scaleX(${fraction ?? 0})`;
  };
  update(status);

  wrapper.append(spinner, label, progress);
  return { element: wrapper, update };
}

export function showResult(result: PipelineResult): void {
  currentOcrText = result.ocr.text;
  // The translation finished, so let the user edit the recognized text again.
  setRecognizedReadOnly(false);
  const status = result.translationStatus;
  currentSourceLang =
    result.translation?.sourceLang ?? result.ocr.lang ?? status.sourceLang;
  currentTargetLang = result.translation?.targetLang ?? status.targetLang;

  const content: Node[] = [createRecognizedSection()];

  if (result.translation) {
    content.push(createTranslationTextSection(result.translation.text));
  } else if (status.state === "same_language") {
    const language = status.sourceLang ? languageName(status.sourceLang) : "";
    content.push(
      createTranslationNotice(
        language
          ? t("panelAlreadyInLanguage", language)
          : t("panelAlreadyInTargetLanguage"),
      ),
    );
  } else if (status.state === "failed") {
    content.push(
      createTranslationError(status.reason ?? t("commonTranslationFailed")),
    );
  }

  renderPopup(content);
}

export function showError(
  error: SerializedError,
  onRetry?: () => void,
): void {
  setRecognizedReadOnly(false);
  renderPopup(
    currentOcrText
      ? [
          createRecognizedSection(),
          createTranslationError(error.message, onRetry),
        ]
      : [
          createErrorMessage(error.message),
          ...(onRetry ? [createRetryButton(onRetry)] : []),
        ],
  );
}

// Reuse the popup shell across updates and only swap the body content.
function renderPopup(content: Node[]): void {
  // Any full re-render replaces the loading element, so its in-place patcher
  // is no longer valid.
  updateLoadingRef = undefined;
  const body = ensurePopup();
  body.replaceChildren(...content);
}

function ensurePopup(): HTMLElement {
  if (popup) {
    return popup.querySelector(".ocr-translate-popup-body") as HTMLElement;
  }

  const container = document.createElement("div");
  container.className = "ocr-translate-popup";
  // Restore the dragged size so reopening keeps the user's chosen dimensions.
  if (panelWidth !== undefined) {
    container.style.width = `${panelWidth}px`;
  }
  if (panelHeight !== undefined) {
    container.style.height = `${panelHeight}px`;
  }

  const selectButton = document.createElement("button");
  selectButton.type = "button";
  selectButton.className = "ocr-translate-popup-icon-button";
  selectButton.setAttribute("aria-label", t("panelSelectNewRegion"));
  selectButton.title = t("panelSelectNewRegion");
  selectButton.innerHTML = SELECT_REGION_ICON;
  selectButton.addEventListener("click", () => {
    closePopup();
    onNewSelection?.();
  });

  const menu = createMenu();
  outsideClickHandlers.push(menu.handleOutsideClick);

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "ocr-translate-popup-icon-button";
  closeButton.setAttribute("aria-label", t("commonClose"));
  closeButton.title = t("commonClose");
  closeButton.innerHTML = CLOSE_ICON;
  closeButton.addEventListener("click", () => closePopup());

  const divider = document.createElement("span");
  divider.className = "ocr-translate-popup-divider";
  divider.setAttribute("aria-hidden", "true");

  const actions = document.createElement("div");
  actions.className = "ocr-translate-popup-actions";
  actions.append(selectButton, menu.element, divider, closeButton);

  // Persistent top bar: title on the left, menu/close on the right. Stays put
  // while the body below it scrolls. The language badges live in the section
  // headers instead.
  const title = document.createElement("strong");
  title.className = "ocr-translate-popup-title";
  const titleIcon = document.createElement("span");
  titleIcon.className = "ocr-translate-popup-title-icon";
  titleIcon.innerHTML = LOGO_ICON;
  const titleText = document.createElement("span");
  titleText.textContent = t("extensionName");
  title.append(titleIcon, titleText);

  const topbar = document.createElement("div");
  topbar.className = "ocr-translate-popup-topbar";
  topbar.append(title, actions);

  const body = document.createElement("div");
  body.className = "ocr-translate-popup-body";

  container.append(createResizeHandle(container), topbar, body);
  (uiRoot ?? document.documentElement).append(container);
  popup = container;

  // Pick the initial layout (the saved width may already be past the wide
  // threshold) and keep it in sync as the viewport changes.
  updateLayoutMode();
  windowResizeHandler = updateLayoutMode;
  window.addEventListener("resize", windowResizeHandler);

  return body;
}

// A grab handle on the panel's top-left corner. The panel is pinned to the
// bottom-right corner, so dragging changes both dimensions: width is the
// distance from the cursor to the right anchor, height to the bottom anchor.
function createResizeHandle(container: HTMLElement): HTMLElement {
  const handle = document.createElement("div");
  handle.className = "ocr-translate-popup-resize";
  handle.setAttribute("aria-label", t("panelResize"));

  let dragging = false;
  // Pointer position and panel size captured at the start of a drag. Sizing from
  // the delta against these (rather than the absolute cursor position) keeps the
  // panel from jumping by the grab offset on the first move.
  let startX = 0;
  let startY = 0;
  let startWidth = 0;
  let startHeight = 0;

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) {
      return;
    }
    // Dragging the top-left handle: moving left/up (smaller client coords) grows
    // the panel toward its bottom-right anchor.
    const width = startWidth + (startX - event.clientX);
    const height = startHeight + (startY - event.clientY);
    panelWidth = clampPanelWidth(width);
    panelHeight = clampPanelHeight(height);
    container.style.width = `${panelWidth}px`;
    container.style.height = `${panelHeight}px`;
    updateLayoutMode();
  }

  function stopDragging(event: PointerEvent): void {
    if (!dragging) {
      return;
    }
    dragging = false;
    handle.releasePointerCapture?.(event.pointerId);
    handle.classList.remove("is-dragging");
    savePanelSize();
  }

  handle.addEventListener("pointerdown", (event) => {
    dragging = true;
    userResized = true;
    // Anchor the drag to the current pointer position and rendered size, so the
    // first move measures a zero delta and the panel doesn't jump.
    const rect = container.getBoundingClientRect();
    startX = event.clientX;
    startY = event.clientY;
    startWidth = rect.width;
    startHeight = rect.height;
    handle.setPointerCapture?.(event.pointerId);
    handle.classList.add("is-dragging");
    // Stop the drag from selecting page text or focusing the strip.
    event.preventDefault();
  });
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", stopDragging);
  handle.addEventListener("pointercancel", stopDragging);

  return handle;
}

function createMenu(): {
  element: HTMLElement;
  handleOutsideClick: (event: MouseEvent) => void;
} {
  const wrapper = document.createElement("div");
  wrapper.className = "ocr-translate-popup-menu";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "ocr-translate-popup-icon-button";
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
    button.setAttribute("aria-expanded", "false");
  }

  function addItem(item: (typeof MENU_ITEMS)[number]): HTMLButtonElement {
    const entry = document.createElement("button");
    entry.type = "button";
    entry.className = "ocr-translate-popup-menu-item";
    entry.setAttribute("role", "menuitem");

    const icon = document.createElement("span");
    icon.className = "ocr-translate-popup-menu-icon";
    icon.innerHTML = item.icon;

    const label = document.createElement("span");
    label.textContent = t(item.messageKey);

    entry.append(icon, label);
    entry.addEventListener("click", () => {
      closeMenu();
      item.onSelect();
    });
    list.append(entry);
    return entry;
  }

  overlayMenuItemRef = addItem({
    messageKey: "panelShowInOverlay",
    icon: OVERLAY_ICON,
    onSelect: () => onShowOverlay?.(),
  });
  overlayMenuItemRef.hidden = !overlayAvailable;

  for (const item of MENU_ITEMS) {
    addItem(item);
  }

  button.addEventListener("click", () => {
    const open = list.hidden;
    list.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  });

  // Dismiss the menu on any click outside the wrapper. composedPath() reaches
  // through the shadow boundary, so clicks inside our UI report real targets.
  function handleOutsideClick(event: MouseEvent): void {
    if (!list.hidden && !event.composedPath().includes(wrapper)) {
      closeMenu();
    }
  }
  document.addEventListener("click", handleOutsideClick);

  wrapper.append(button, list);
  return { element: wrapper, handleOutsideClick };
}

// A static badge showing the recognized text's source language, e.g. "Japanese".
// Sits next to the "Source text" heading. Shows "Unknown" when detection
// could not resolve the language.
function createSourceBadge(source: LangCode | undefined): HTMLElement {
  const selected = ocrSourceLanguages.find(
    (language) => language.id === currentSourceLanguageId,
  );
  const label = source
    ? source === selected?.id
      ? selected.label
      : languageName(source)
    : t("commonUnknown");
  const badge = document.createElement("span");
  badge.className = "ocr-translate-popup-langbadge";
  badge.textContent = label;
  badge.title = source
    ? t("panelDetectedLanguage", label)
    : t("panelLanguageNotDetected");
  return badge;
}

// The extras shown next to the "Source text" heading: the source-language
// picker plus the detected-language badge.
function createRecognizedExtras(): HTMLElement {
  const badge = createSourceBadge(currentSourceLang);
  const picker = createSourceLanguagePill();
  const wrapper = document.createElement("div");
  wrapper.className = "ocr-translate-popup-recognized-extras";
  if (picker) {
    wrapper.append(picker);
  }
  wrapper.append(badge);
  return wrapper;
}

// A no-search dropdown pill for switching between a small set of options.
// Picking one fires onSelect with its id. Reuses the language-pill styling.
function createOptionPill(config: {
  options: ReadonlyArray<{ id: string; label: string }>;
  currentId: string | undefined;
  buttonLabel?: (current: { id: string; label: string }) => string;
  title: (current: { id: string; label: string }) => string;
  onSelect: (id: string) => void;
}): HTMLElement | undefined {
  if (config.options.length < 2) {
    return undefined;
  }
  const current =
    config.options.find((option) => option.id === config.currentId) ??
    config.options[0];

  const wrapper = document.createElement("div");
  wrapper.className = "ocr-translate-popup-langpill";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "ocr-translate-popup-langpill-button";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  button.title = config.title(current);

  const label = document.createElement("span");
  label.textContent = config.buttonLabel?.(current) ?? current.label;
  const chevron = document.createElement("span");
  chevron.className = "ocr-translate-popup-langpill-chevron";
  chevron.innerHTML = CHEVRON_ICON;
  button.append(label, chevron);

  const list = document.createElement("div");
  list.className = "ocr-translate-popup-langpill-list";
  list.setAttribute("role", "listbox");
  list.hidden = true;

  function closeList(): void {
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
  }

  const itemsBox = document.createElement("div");
  itemsBox.className = "ocr-translate-popup-langpill-items";
  list.append(itemsBox);

  for (const option of config.options) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "ocr-translate-popup-langpill-item";
    item.setAttribute("role", "option");
    item.textContent = option.label;
    if (option.id === current.id) {
      item.setAttribute("aria-selected", "true");
      item.classList.add("is-selected");
    }
    item.addEventListener("click", () => {
      closeList();
      if (option.id !== current.id) {
        config.onSelect(option.id);
      }
    });
    itemsBox.append(item);
  }

  button.addEventListener("click", () => {
    const open = list.hidden;
    list.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  });

  function handleOutsideClick(event: MouseEvent): void {
    if (!list.hidden && !event.composedPath().includes(wrapper)) {
      closeList();
    }
  }
  document.addEventListener("click", handleOutsideClick);
  outsideClickHandlers.push(handleOutsideClick);

  wrapper.append(button, list);
  return wrapper;
}

// The source-language picker shown next to "Source text". Picking one re-runs
// OCR on the same region with the matching recognizer.
function createSourceLanguagePill(): HTMLElement | undefined {
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
          ocrSourceLanguages.find(({ id }) => id === "auto")?.label ??
          t("commonAuto"),
      },
    ],
    title: (name) => t("panelSourceLanguage", name),
    onChange: (sourceLang) => {
      currentSourceLanguageId = sourceLang;
      onSourceLanguageChange?.(sourceLang);
    },
  });
  outsideClickHandlers.push(pill.handleOutsideClick);
  return pill.element;
}

// The translation-provider picker shown next to "Translation". Picking one
// re-translates the current text via onProviderChange.
function createProviderPill(): HTMLElement | undefined {
  return createOptionPill({
    options: translationProviders,
    currentId: currentProviderId,
    title: (current) => t("panelTranslationProvider", current.label),
    onSelect: (id) => {
      currentProviderId = id;
      onProviderChange?.(id);
    },
  });
}

// The interactive target-language pill shown next to the "Translation" heading.
// Returns undefined until a result sets the target language.
function createTargetPill(): HTMLElement | undefined {
  if (!currentTargetLang) {
    return undefined;
  }
  const pill = createLanguagePill({
    target: currentTargetLang,
    languages: targetLanguages,
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

// The extras shown next to the "Translation" heading: the provider picker plus
// the target-language pill, with the Translate button grouped right after them.
// Mirrors createRecognizedExtras on the source side.
function createTranslationExtras(): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "ocr-translate-popup-translation-extras";
  const provider = createProviderPill();
  if (provider) {
    wrapper.append(provider);
  }
  const target = createTargetPill();
  if (target) {
    wrapper.append(target);
  }
  wrapper.append(createTranslateButton());
  return wrapper;
}

function createMessage(message: string): HTMLElement {
  const element = document.createElement("p");
  element.className = "ocr-translate-popup-message";
  element.textContent = message;

  return element;
}

// An error message with a leading warning icon (matching the overlay's error
// chip). Plain notices keep using createMessage.
function createErrorMessage(message: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "ocr-translate-popup-error";

  const icon = document.createElement("span");
  icon.className = "ocr-translate-popup-error-icon";
  icon.innerHTML = WARNING_ICON;

  wrapper.append(icon, createMessage(message));
  return wrapper;
}

// The "Source text" section: an editable text box plus its language controls.
// Reads currentOcrText so re-renders keep edits.
function createRecognizedSection(): HTMLElement {
  return createTextSection(
    t("panelSourceText"),
    currentOcrText,
    createRecognizedExtras(),
    true,
    {
      owner: ORIGINAL_SPEECH_OWNER,
      getLang: () => currentSourceLang,
    },
  );
}

// Build a labeled text box. `badge`, when given, sits next to the heading (the
// source-language badge for recognized text, the target-language pill for the
// translation). When `editable` is set the box is a textarea the user can edit;
// otherwise it's a read-only <pre>.
function createTextSection(
  label: string,
  text: string,
  badge?: HTMLElement,
  editable = false,
  speech?: {
    owner: string;
    getLang: () => string | undefined;
  },
): HTMLElement {
  const section = document.createElement("section");
  const heading = document.createElement("h2");

  // The -text marker flags the recognized/translation boxes so the wide layout
  // can place them side by side; other sections (consent, progress) stay full
  // width.
  section.className = "ocr-translate-popup-section ocr-translate-popup-text";

  // The editable box is a textarea (its `value` preserves newlines, unlike a
  // contentEditable <pre> whose textContent drops them). Reading the live value
  // also keeps the copy button accurate after an edit.
  let content: HTMLElement;
  let getText: () => string;
  if (editable) {
    const textarea = document.createElement("textarea");
    textarea.className = "ocr-translate-popup-editable";
    textarea.value = text;
    textarea.spellcheck = false;
    // Stay locked across a re-render that happens while a translation is running.
    textarea.readOnly = recognizedReadOnly;
    textarea.setAttribute("aria-label", label);
    textarea.addEventListener("input", () => {
      currentOcrText = textarea.value;
    });
    recognizedBoxRef = textarea;
    content = textarea;
    getText = () => textarea.value;
  } else {
    const pre = document.createElement("pre");
    pre.textContent = text;
    content = pre;
    getText = () => pre.textContent ?? "";
  }
  content.dir = "auto";

  const header = document.createElement("div");
  header.className = "ocr-translate-popup-section-header";
  heading.textContent = label;

  // Heading + optional badge grouped on the left, copy/actions on the right.
  const headingGroup = document.createElement("div");
  headingGroup.className = "ocr-translate-popup-section-heading";
  headingGroup.append(heading);
  if (badge) {
    headingGroup.append(badge);
  }

  const actionGroup = document.createElement("div");
  actionGroup.className = "ocr-translate-popup-section-actions";
  if (speech) {
    actionGroup.append(
      createSpeakButton(getText, speech.getLang, speech.owner),
    );
  }
  actionGroup.append(createCopyButton(getText));

  header.append(headingGroup, actionGroup);

  section.append(header, content);

  return section;
}

function createTranslateButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ocr-translate-popup-translate";
  button.textContent = t("commonTranslate");
  button.disabled = recognizedReadOnly || !currentTargetLang;
  button.addEventListener("click", () => {
    const text = recognizedBoxRef?.value ?? currentOcrText;
    currentOcrText = text;
    onTranslateRequest?.(text, currentTargetLang);
  });
  return button;
}

function createTranslationTextSection(text: string): HTMLElement {
  return createTextSection(
    t("panelTranslationHeading"),
    text,
    createTranslationExtras(),
    false,
    {
      owner: TRANSLATION_SPEECH_OWNER,
      getLang: () => currentTargetLang,
    },
  );
}

// The "Translation" section header: the heading, provider picker, target-language
// pill, and Translate button. Every translation state keeps these controls.
function createTranslationHeader(): HTMLElement {
  const header = document.createElement("div");
  header.className = "ocr-translate-popup-section-header";

  const headingGroup = document.createElement("div");
  headingGroup.className = "ocr-translate-popup-section-heading";
  const heading = document.createElement("h2");
  heading.textContent = t("panelTranslationHeading");
  headingGroup.append(heading, createTranslationExtras());

  const actionGroup = document.createElement("div");
  actionGroup.className = "ocr-translate-popup-section-actions";
  actionGroup.append(createCopyButton(() => ""));

  header.append(headingGroup, actionGroup);

  return header;
}

// The "Translation" slot while a re-translation is in flight: keeps the target
// pill (so the user can switch again) and shows a placeholder instead of the
// previous text.
function createTranslatingSection(): HTMLElement {
  const section = document.createElement("section");
  section.className = "ocr-translate-popup-section ocr-translate-popup-text";

  const placeholder = document.createElement("pre");
  placeholder.className = "ocr-translate-popup-placeholder";
  placeholder.textContent = t("statusTranslating");

  section.append(createTranslationHeader(), placeholder);

  return section;
}

// The "Translation" slot for a non-result outcome (same language, or an
// unsupported pair). Keeps the pill so the user can pick another language.
function createTranslationNotice(message: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "ocr-translate-popup-section ocr-translate-popup-text";
  section.append(createTranslationHeader(), createMessage(message));
  return section;
}

// The "Translation" slot when a remote translation request failed. The
// recognized text is rendered separately, so it stays on screen; here we keep
// the language pill and add a Retry that re-translates the current text into the
// current target (reusing the same path as the pill's language switch).
function createTranslationError(
  message: string,
  onRetry?: () => void,
): HTMLElement {
  const section = document.createElement("section");
  section.className = "ocr-translate-popup-section ocr-translate-popup-text";

  const target = currentTargetLang;
  const retryAction =
    onRetry ?? (target ? () => onTargetLangChange?.(target) : undefined);
  const retry = createRetryButton(retryAction);

  section.append(createTranslationHeader(), createErrorMessage(message), retry);
  return section;
}

function createRetryButton(onRetry?: () => void): HTMLButtonElement {
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "ocr-translate-popup-retry";
  retry.textContent = t("commonRetry");
  retry.disabled = !onRetry;
  if (onRetry) {
    retry.addEventListener("click", onRetry, { once: true });
  }
  return retry;
}

// A small button next to a text box that copies its text to the clipboard and
// briefly shows a checkmark on success. Reads the text lazily via `getText` so
// it stays accurate when the box is editable.
function createCopyButton(getText: () => string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ocr-translate-popup-copy";
  button.setAttribute("aria-label", t("commonCopy"));
  button.title = t("commonCopy");
  button.innerHTML = COPY_ICON;

  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
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

function createSpeakButton(
  getText: () => string,
  getLang: () => string | undefined,
  owner: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ocr-translate-popup-copy ocr-translate-popup-speak";
  button.dataset.speechOwner = owner;

  const update = (active: boolean): void => {
    setSpeakButtonState(button, active);
    const current = popup?.querySelector<HTMLButtonElement>(
      `[data-speech-owner="${owner}"]`,
    );
    if (current && current !== button) {
      setSpeakButtonState(current, active);
    }
  };

  update(isSpeaking(owner));
  button.addEventListener("click", () => {
    if (isSpeaking(owner)) {
      stopSpeaking();
      return;
    }
    requestSpeak({
      text: getText(),
      lang: getLang(),
      owner,
      onStart: () => update(true),
      onEnd: () => update(false),
    });
  });

  return button;
}

function setSpeakButtonState(
  button: HTMLButtonElement,
  active: boolean,
): void {
  const accessibleLabel = active
    ? t("commonStopSpeaking")
    : t("commonReadAloud");
  button.innerHTML = active ? STOP_SPEAK_ICON : SPEAK_ICON;
  button.classList.toggle("is-speaking", active);
  button.setAttribute("aria-label", accessibleLabel);
  button.title = accessibleLabel;
}
