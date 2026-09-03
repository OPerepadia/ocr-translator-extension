import { browser } from "wxt/browser";
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
  OVERLAY_ICON,
  SELECT_REGION_ICON,
  SETTINGS_ICON,
  SPEAK_ICON,
  STOP_SPEAK_ICON,
  WARNING_ICON,
} from "./icons";
import { createActionMenu, type ActionMenu } from "./action-menu";
import { languageName } from "./language-picker";
import {
  createOcrSourceLanguagePicker,
  createTargetLanguagePicker,
  createTranslationProviderPicker,
  type ContentControlPicker,
} from "./content-control-pickers";
import {
  pipelineStatusMessage,
  pipelineStatusProgress,
} from "./pipeline-status";
import { sendRequest } from "@/shared/runtime-messaging";
import { t } from "@/shared/i18n";
import { isSpeaking, requestSpeak, stopSpeaking } from "./tts";
import type { ContentControls } from "./content-controls";

export interface ClosePopupOptions {
  notify?: boolean;
}

export interface ResultPanelConfig {
  controls: ContentControls;
  onClose(): void;
  onNewSelection(): void;
  onShowOverlay(): void;
  onTranslateRequest(text: string, targetLang: LangCode | undefined): void;
}
const ORIGINAL_SPEECH_OWNER = "panel-original";
const TRANSLATION_SPEECH_OWNER = "panel-translation";

let popup: HTMLElement | undefined;
// Remember the recognized text so progress/translation re-renders keep showing
// it without re-running OCR.
let currentOcrText = "";
let config: ResultPanelConfig | undefined;
let overlayAvailable = false;
let overlayMenuItemRef: HTMLButtonElement | undefined;
// Source/target languages of the current result, shown in the language pill.
let currentSourceLang: LangCode | undefined;
let currentTargetLang: LangCode | undefined;
// Live reference to the editable recognized-text box, so the Translate button
// always sends the current text.
let recognizedBoxRef: HTMLTextAreaElement | undefined;
// While a translation is in flight the recognized box is locked. The translation
// runs against the text as it was when the request started, and the result
// re-renders the box from that text — so an edit made mid-translation would be
// silently discarded. Locking the box prevents that lost edit.
let recognizedReadOnly = false;
let popupDisposers: Array<() => void> = [];
let mountedControlDisposers: Array<() => void> = [];
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
    const values = await browser.storage.local.get(PANEL_SIZE_KEY);
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
  void browser.storage.local.set({
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

export function configureResultPanel(nextConfig: ResultPanelConfig): void {
  config = nextConfig;
}

export function setOverlayAvailable(value: boolean): void {
  overlayAvailable = value;
  if (overlayMenuItemRef) {
    overlayMenuItemRef.hidden = !value;
  }
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
  currentTargetLang = undefined;
  currentOcrText = "";
  recognizedReadOnly = false;
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
  disposeAll(popupDisposers);
  disposeAll(mountedControlDisposers);
  popupDisposers = [];
  mountedControlDisposers = [];
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
    config?.onClose();
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
    renderPopup(() => [createRecognizedSection(), createTranslatingSection()]);
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
  renderPopup(() => [loading.element]);
  updateLoadingRef = loading.update;
}

export function showRecognizedTextWhileTranslating(
  ocr: PipelineOcrResult,
): void {
  currentOcrText = ocr.text;
  const sourceLanguageId = config?.controls.currentOcrSourceLanguageId;
  currentSourceLang =
    ocr.lang ??
    (sourceLanguageId !== "auto" ? sourceLanguageId : undefined);
  setRecognizedReadOnly(true);
  renderPopup(() => [createRecognizedSection(), createTranslatingSection()]);
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
    label.textContent = pipelineStatusMessage(next);
    const fraction = pipelineStatusProgress(next);
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

  renderPopup(() => {
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

    return content;
  });
}

export function showError(
  error: SerializedError,
  onRetry?: () => void,
): void {
  setRecognizedReadOnly(false);
  renderPopup(() =>
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
function renderPopup(createContent: () => Node[]): void {
  // Any full re-render replaces the loading element, so its in-place patcher
  // is no longer valid.
  updateLoadingRef = undefined;
  const body = ensurePopup();
  disposeAll(mountedControlDisposers);
  mountedControlDisposers = [];
  body.replaceChildren(...createContent());
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
    config?.onNewSelection();
  });

  const menu = createMenu();
  popupDisposers.push(menu.dispose);

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
  const logo = document.createElement("img");
  const getExtensionUrl = browser.runtime.getURL as (path: string) => string;
  logo.src = getExtensionUrl("icon/ocr_icon_big.svg");
  logo.alt = "";
  logo.setAttribute("aria-hidden", "true");
  titleIcon.append(logo);
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

function createMenu(): ActionMenu {
  const menu = createActionMenu({
    items: [
      {
        icon: OVERLAY_ICON,
        label: t("panelShowInOverlay"),
        onSelect: () => config?.onShowOverlay(),
      },
      {
        icon: SETTINGS_ICON,
        label: t("commonSettings"),
        onSelect: () => {
          void sendRequest({ type: "OPEN_OPTIONS" });
        },
      },
    ],
  });
  overlayMenuItemRef = menu.itemElements[0];
  overlayMenuItemRef.hidden = !overlayAvailable;
  return menu;
}

// A static badge showing the recognized text's source language, e.g. "Japanese".
// Sits next to the "Source text" heading. Shows "Unknown" when detection
// could not resolve the language.
function createSourceBadge(source: LangCode | undefined): HTMLElement {
  const controls = config?.controls;
  const selected = controls?.ocrSourceLanguages.find(
    (language) => language.id === controls.currentOcrSourceLanguageId,
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
  const picker = mountControlPicker(
    config
      ? createOcrSourceLanguagePicker(config.controls)
      : undefined,
  );
  const wrapper = document.createElement("div");
  wrapper.className = "ocr-translate-popup-recognized-extras";
  if (picker) {
    wrapper.append(picker);
  }
  wrapper.append(badge);
  return wrapper;
}

// The extras shown next to the "Translation" heading: the target-language pill
// plus the provider picker, with the Translate button grouped right after them.
// Mirrors createRecognizedExtras on the source side.
function createTranslationExtras(): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "ocr-translate-popup-translation-extras";
  const controls = config?.controls;
  const target = mountControlPicker(
    controls
      ? createTargetLanguagePicker({
          controls,
          target: currentTargetLang,
          onSelect: (targetLang) => {
            currentTargetLang = targetLang;
          },
        })
      : undefined,
  );
  if (target) {
    wrapper.append(target);
  }
  const provider = mountControlPicker(
    controls ? createTranslationProviderPicker(controls) : undefined,
  );
  if (provider) {
    wrapper.append(provider);
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
    config?.onTranslateRequest(text, currentTargetLang);
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
    onRetry ??
    (target ? () => config?.controls.selectTargetLanguage(target) : undefined);
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

function disposeAll(disposers: Array<() => void>): void {
  for (const disposeControl of disposers) {
    disposeControl();
  }
}

function mountControlPicker(
  picker: ContentControlPicker | undefined,
): HTMLElement | undefined {
  if (!picker) {
    return undefined;
  }
  mountedControlDisposers.push(picker.dispose);
  return picker.element;
}

export function dispose(): void {
  closePopup({ notify: false });
  uiRoot = undefined;
  config = undefined;
}
