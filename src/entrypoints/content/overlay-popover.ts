import type { LangCode, Rect } from "@/shared/types";
import type { OverlayMode } from "@/shared/types";
import { t } from "@/shared/i18n";
import {
  CHECK_ICON,
  COPY_ICON,
  EDIT_ICON,
  SPEAK_ICON,
  STOP_SPEAK_ICON,
} from "./icons";
import { rotatedBounds } from "./overlay-layout";
import { isSpeaking, requestSpeak, stopSpeaking } from "./tts";

export const OVERLAY_POPOVER_ID = "ocr-translate-overlay-popover";

const POPOVER_SETTLE_MS = 100;
const POPOVER_SETTLE_MOVE_PX = 4;
const POPOVER_CLOSE_DELAY_MS = 200;
const POPOVER_MARGIN = 8;
const POPOVER_MIN_WIDTH = 384;
const POPOVER_MAX_WIDTH = 640;
const POPOVER_MIN_EDITOR_WIDTH = 320;
const POPOVER_MAX_HEIGHT_RATIO = 0.6;
const POPOVER_MIN_HEIGHT = 320;

export interface OverlayPopoverBox {
  element: HTMLElement;
  rect: Rect;
  angle: number;
  content: {
    original: string;
    translated: string;
  };
  /** The line of the recognized text in this box. Unset for the combined box,
   * which has the whole text. */
  line?: number;
}

interface OverlayPopoverState {
  boxes: readonly OverlayPopoverBox[];
  mode: OverlayMode;
  hasTranslation: boolean;
  canEdit: boolean;
  sourceLang?: LangCode;
  targetLang?: LangCode;
  selectingFromPopover: boolean;
  selectingFromLayer?: boolean;
}

interface OverlayPopoverOptions {
  container: HTMLElement;
  speechOwner: string;
  getState(): OverlayPopoverState;
  beginSelection(): void;
  endSelection(): void;
  /** The recognized text is being edited, or no longer is. Changes the boxes in
   * the state to the ones shown meanwhile, in the same order. */
  onEditingChange(editing: boolean): void;
  onCorrect(box: OverlayPopoverBox, text: string): void;
}

interface PopoverView {
  el: HTMLElement;
  body?: HTMLElement;
  boxIndex: number;
  speechButtons: Partial<Record<OverlayMode, HTMLButtonElement>>;
  editButton?: HTMLButtonElement;
  /** Set while the recognized text is being edited. */
  editor?: HTMLTextAreaElement;
  /** Where the popover was last placed. */
  side?: PopoverSide;
}

type PopoverSide = "below" | "above" | "right" | "left";

export interface OverlayPopover {
  attach(box: HTMLElement, index: number): void;
  /** Leave the text editor, or else close the popover. False if neither was
   * open. */
  dismiss(): boolean;
  clearBoxes(): void;
  reposition(): void;
  setWholeSpeechState(active: boolean, target?: OverlayMode): void;
  dispose(): void;
}

export function createOverlayPopover(
  options: OverlayPopoverOptions,
): OverlayPopover {
  let activeView: PopoverView | undefined;
  let popoverEl: HTMLElement | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let settleOrigin: { x: number; y: number } | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let pressedInside = false;
  let speakingTarget: OverlayMode | undefined;
  let speakingBoxIndex: number | undefined;
  const copyResetTimers = new Map<
    HTMLButtonElement,
    ReturnType<typeof setTimeout>
  >();

  const state = (): OverlayPopoverState => options.getState();

  function attach(box: HTMLElement, index: number): void {
    setBoxState(box, false);
    box.addEventListener("pointerenter", (event) => {
      clearCloseTimer();
      if (event.pointerType === "touch") {
        show(index);
        return;
      }
      waitForPointerToSettle(index, event);
    });
    box.addEventListener("pointermove", (event) => {
      keepWaitingForPointerToSettle(index, event);
    });
    box.addEventListener("pointerleave", handlePointerLeave);
    box.addEventListener("keydown", (event) => {
      if (event.repeat || !isOverlayBoxActivationKey(event.key)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggle(index);
    });
  }

  function waitForPointerToSettle(
    index: number,
    event: PointerEvent,
  ): void {
    clearSettleTimer();
    if (state().selectingFromLayer || activeView?.editor) return;
    if (activeView?.boxIndex === index) {
      return;
    }
    settleOrigin = { x: event.clientX, y: event.clientY };
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      settleOrigin = undefined;
      if (state().selectingFromLayer || activeView?.editor) return;
      show(index);
    }, POPOVER_SETTLE_MS);
  }

  function keepWaitingForPointerToSettle(
    index: number,
    event: PointerEvent,
  ): void {
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

  function clearCloseTimer(): void {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }

  function handlePointerLeave(event: PointerEvent): void {
    clearSettleTimer();
    if (state().selectingFromLayer) return;
    if (!activeView || event.pointerType === "touch") {
      return;
    }
    const into = event.relatedTarget;
    const box = state().boxes[activeView.boxIndex]?.element;
    if (
      into instanceof Node &&
      (activeView.el.contains(into) || box?.contains(into))
    ) {
      return;
    }
    if (isBusy()) {
      return;
    }
    clearCloseTimer();
    closeTimer = setTimeout(() => {
      closeTimer = undefined;
      if (!isBusy()) {
        hide();
      }
    }, POPOVER_CLOSE_DELAY_MS);
  }

  function isBusy(): boolean {
    if (!activeView) {
      return false;
    }
    return (
      Boolean(activeView.editor) ||
      state().selectingFromPopover ||
      state().selectingFromLayer ||
      hasSelectionInside(activeView.el) ||
      (speakingBoxIndex === activeView.boxIndex &&
        isSpeaking(options.speechOwner))
    );
  }

  function toggle(index: number): void {
    if (hasUnsavedEdit()) {
      return;
    }
    if (activeView?.boxIndex === index) {
      hide();
      return;
    }
    show(index);
  }

  function show(index: number): void {
    clearCloseTimer();
    if (activeView?.boxIndex === index || hasUnsavedEdit()) {
      return;
    }
    if (activeView?.editor) {
      leaveEditor(activeView);
    }
    if (speakingBoxIndex !== undefined && isSpeaking(options.speechOwner)) {
      stopSpeaking();
    }
    activeView = open(index) ?? activeView;
    syncBoxStates();
  }

  function open(index: number): PopoverView | undefined {
    const content = state().boxes[index]?.content;
    const el = content ? ensureElement() : undefined;
    if (!content || !el) {
      return undefined;
    }
    const view: PopoverView = {
      el,
      boxIndex: index,
      speechButtons: {},
    };
    render(view, content);
    el.hidden = false;
    position(view);
    return view;
  }

  function ensureElement(): HTMLElement {
    if (popoverEl) {
      return popoverEl;
    }
    const el = document.createElement("div");
    el.className = "ocr-translate-overlay-popover";
    el.id = OVERLAY_POPOVER_ID;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", t("overlayRecognizedAndTranslatedText"));
    el.addEventListener("pointerdown", options.beginSelection);
    el.addEventListener("pointerenter", clearCloseTimer);
    el.addEventListener("pointerleave", handlePointerLeave);
    options.container.append(el);
    document.addEventListener("pointerdown", handlePress, true);
    document.addEventListener("click", handleOutsideClick);
    popoverEl = el;
    return el;
  }

  function handlePress(event: PointerEvent): void {
    pressedInside = Boolean(
      activeView && event.composedPath().includes(activeView.el),
    );
  }

  function handleOutsideClick(event: MouseEvent): void {
    // Selecting text can end outside the popover, which is not a click there.
    const startedInside = pressedInside;
    pressedInside = false;
    if (!activeView || startedInside || hasUnsavedEdit()) {
      return;
    }
    const path = event.composedPath();
    const box = state().boxes[activeView.boxIndex]?.element;
    if (!path.includes(activeView.el) && (!box || !path.includes(box))) {
      hide();
    }
  }

  function render(
    view: PopoverView,
    content: OverlayPopoverBox["content"],
  ): void {
    view.el.replaceChildren();
    view.speechButtons = {};
    view.editButton = undefined;

    const body = document.createElement("div");
    body.className = "ocr-translate-overlay-popover-body";

    const both = state().hasTranslation && hasBothTexts(content);
    const lead = both ? "translation" : availableMode(content);
    body.append(createRow(view, lead, content, false));
    if (both) {
      body.append(createRow(view, "original", content, true));
    }

    view.body = body;
    view.el.append(body);
  }

  function createRow(
    view: PopoverView,
    textMode: OverlayMode,
    content: OverlayPopoverBox["content"],
    isSource: boolean,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "ocr-translate-overlay-popover-row";
    if (isSource) {
      row.classList.add("is-source");
    }

    const controls = document.createElement("div");
    controls.className = "ocr-translate-overlay-popover-row-controls";
    if (textMode === "original" && state().canEdit) {
      view.editButton = popoverButton(
        EDIT_ICON,
        t("overlayEditText"),
        () => openEditor(view),
      );
      controls.append(view.editButton);
    }
    controls.append(
      createSpeakButton(view, textMode, content),
      createCopyButton(textMode, content),
    );

    const header = document.createElement("div");
    header.className = "ocr-translate-overlay-popover-row-header";
    header.append(createRowTitle(textMode), controls);
    row.append(header, createText(textMode, content));
    return row;
  }

  function createTitle(text: string): HTMLElement {
    const title = document.createElement("h3");
    title.className = "ocr-translate-overlay-popover-row-title";
    title.textContent = text;
    return title;
  }

  function createRowTitle(textMode: OverlayMode): HTMLElement {
    const lang = modeLang(textMode);
    const roleLabel = t(
      textMode === "original"
        ? "optionsOverlayModeOriginal"
        : "optionsOverlayModeTranslation",
    );
    const title = createTitle(
      lang && lang !== "auto" ? lang.toUpperCase() : roleLabel,
    );
    if (lang && lang !== "auto") {
      title.title = roleLabel;
      title.setAttribute("aria-label", roleLabel);
    }
    return title;
  }

  function openEditor(view: PopoverView): void {
    const box = state().boxes[view.boxIndex];
    if (!box || view.editor) {
      return;
    }
    stopBoxSpeech(view);

    const editor = document.createElement("textarea");
    editor.className = "ocr-translate-overlay-popover-editor";
    editor.value = box.content.original;
    editor.rows = 1;
    editor.spellcheck = false;
    editor.dir = "auto";
    const lang = modeLang("original");
    if (lang) {
      editor.lang = lang;
    }
    editor.setAttribute("aria-label", t("panelSourceText"));

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ocr-translate-overlay-popover-cancel";
    cancel.textContent = t("commonCancel");
    cancel.addEventListener("click", () => closeEditor(view));

    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "ocr-translate-popup-translate";
    submit.textContent = t("commonSave");
    submit.disabled = true;
    submit.addEventListener("click", () => submitEdit(view));

    const actions = document.createElement("div");
    actions.className = "ocr-translate-overlay-popover-actions";
    actions.append(cancel, submit);

    editor.addEventListener("input", () => {
      submit.disabled = !editedText(editor, box);
      // Stay on the same side, so the editor does not jump while typing.
      position(view, view.side);
    });
    editor.addEventListener("keydown", (event) => {
      // A block's text is one line. Input methods use Enter to confirm text.
      if (
        event.key === "Enter" &&
        box.line !== undefined &&
        !event.isComposing
      ) {
        event.preventDefault();
      }
    });

    // Keep the width, so the editor does not resize while typing.
    const width = Math.max(view.el.offsetWidth, POPOVER_MIN_EDITOR_WIDTH);
    view.el.style.width = `${width}px`;
    view.editor = editor;
    view.body = editor;
    view.editButton = undefined;
    view.speechButtons = {};
    view.el.classList.add("is-editing");
    view.el.replaceChildren(createTitle(t("overlayEditText")), editor, actions);
    switchBoxes(true);
    position(view);
    editor.focus({ preventScroll: true });
  }

  /** The editor's text, or undefined if there is nothing new to translate. */
  function editedText(
    editor: HTMLTextAreaElement,
    box: OverlayPopoverBox,
  ): string | undefined {
    const text = (
      box.line === undefined
        ? editor.value
        : // Line breaks would shift the lines of the other boxes.
          editor.value.replace(/\s*\n\s*/g, " ")
    ).trim();
    return text && text !== box.content.original.trim() ? text : undefined;
  }

  function hasUnsavedEdit(): boolean {
    const box = activeView && state().boxes[activeView.boxIndex];
    return Boolean(
      activeView?.editor &&
        box &&
        activeView.editor.value.trim() !== box.content.original.trim(),
    );
  }

  function submitEdit(view: PopoverView): void {
    const box = state().boxes[view.boxIndex];
    if (!view.editor || !box) {
      return;
    }
    const text = editedText(view.editor, box);
    if (text) {
      hide();
      options.onCorrect(box, text);
    }
  }

  /** Drop the edit and go back to reading the text. */
  function closeEditor(view: PopoverView): void {
    leaveEditor(view);
    const content = state().boxes[view.boxIndex]?.content;
    if (!content) {
      hide();
      return;
    }
    render(view, content);
    position(view);
    view.editButton?.focus({ preventScroll: true });
  }

  function leaveEditor(view: PopoverView): void {
    view.editor = undefined;
    view.el.style.width = "";
    view.el.classList.remove("is-editing");
    switchBoxes(false);
  }

  function switchBoxes(editing: boolean): void {
    for (const box of state().boxes) {
      setBoxState(box.element, false);
    }
    options.onEditingChange(editing);
    syncBoxStates();
  }

  // Grow the editor with its text. The popover's height limits it.
  function fitEditor(editor: HTMLTextAreaElement): void {
    editor.style.height = "auto";
    const borders = editor.offsetHeight - editor.clientHeight;
    editor.style.height = `${editor.scrollHeight + borders}px`;
  }

  function createText(
    textMode: OverlayMode,
    content: OverlayPopoverBox["content"],
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

  function modeLang(textMode: OverlayMode): LangCode | undefined {
    const currentState = state();
    return textMode === "original"
      ? currentState.sourceLang
      : currentState.targetLang;
  }

  function createSpeakButton(
    view: PopoverView,
    target: OverlayMode,
    content: OverlayPopoverBox["content"],
  ): HTMLButtonElement {
    const button = popoverButton(SPEAK_ICON, t("commonReadAloud"), () => {
      if (isSpeaking(options.speechOwner)) {
        const wasTarget =
          speakingTarget === target && speakingBoxIndex === view.boxIndex;
        stopSpeaking();
        if (wasTarget) {
          return;
        }
      }
      requestSpeak({
        text: modeText(target, content),
        lang: modeLang(target),
        owner: options.speechOwner,
        onStart: () => {
          setSpeechState(true, target, view.boxIndex);
        },
        onEnd: () => {
          setSpeechState(false);
        },
      });
    });
    view.speechButtons[target] = button;
    setSpeakButtonState(
      button,
      isSpeaking(options.speechOwner) &&
        speakingTarget === target &&
        speakingBoxIndex === view.boxIndex,
    );
    return button;
  }

  function createCopyButton(
    target: OverlayMode,
    content: OverlayPopoverBox["content"],
  ): HTMLButtonElement {
    const button = popoverButton(COPY_ICON, t("commonCopy"), () => {
      void copyText(button, modeText(target, content));
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

  function setSpeechState(
    active: boolean,
    target?: OverlayMode,
    boxIndex?: number,
  ): void {
    speakingTarget = active ? target : undefined;
    speakingBoxIndex = active ? boxIndex : undefined;
    for (const textMode of ["original", "translation"] as const) {
      setSpeakButtonState(
        activeView?.speechButtons[textMode],
        active &&
          speakingTarget === textMode &&
          speakingBoxIndex === activeView?.boxIndex,
      );
    }
  }

  async function copyText(
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
    clearTimeout(copyResetTimers.get(button));
    const resetTimer = setTimeout(() => {
      button.innerHTML = COPY_ICON;
      button.classList.remove("is-active");
      copyResetTimers.delete(button);
    }, 1500);
    copyResetTimers.set(button, resetTimer);
  }

  function hide(): boolean {
    clearSettleTimer();
    clearCloseTimer();
    if (!activeView) {
      return false;
    }
    stopBoxSpeech(activeView);
    if (activeView.editor) {
      leaveEditor(activeView);
    }
    activeView.el.hidden = true;
    activeView = undefined;
    syncBoxStates();
    return true;
  }

  function dismiss(): boolean {
    if (activeView?.editor) {
      closeEditor(activeView);
      return true;
    }
    return hide();
  }

  function stopBoxSpeech(view: PopoverView): void {
    if (
      speakingBoxIndex === view.boxIndex &&
      isSpeaking(options.speechOwner)
    ) {
      stopSpeaking();
    }
  }

  function clearBoxes(): void {
    hide();
    clearSettleTimer();
    clearCloseTimer();
  }

  function syncBoxStates(): void {
    state().boxes.forEach((box, index) => {
      setBoxState(box.element, activeView?.boxIndex === index);
    });
  }

  function reposition(): void {
    if (activeView) {
      position(activeView);
    }
  }

  function position(view: PopoverView, side?: PopoverSide): void {
    if (view.el.hidden) {
      return;
    }
    const currentState = state();
    const box = currentState.boxes[view.boxIndex];
    if (!box) {
      return;
    }
    const rect = pageToViewportRect(rotatedBounds(box.rect, box.angle));
    const { style } = view.el;
    const scrollTop = view.body?.scrollTop ?? 0;
    style.left = "0";
    style.maxHeight = "none";
    const placement = popoverPlacement({
      box: rect,
      side,
      viewport: {
        width: options.container.clientWidth,
        height: window.innerHeight,
      },
      measure: (maxWidth) => {
        style.maxWidth = `${maxWidth}px`;
        if (view.editor) {
          fitEditor(view.editor);
        }
        return { width: view.el.offsetWidth, height: view.el.offsetHeight };
      },
    });
    view.side = placement.side;
    style.maxWidth = `${placement.maxWidth}px`;
    style.maxHeight = `${placement.maxHeight}px`;
    style.left = `${placement.left}px`;
    style.top = `${placement.top}px`;
    if (view.body) {
      view.body.scrollTop = scrollTop;
    }
  }

  function setWholeSpeechState(
    active: boolean,
    target?: OverlayMode,
  ): void {
    setSpeechState(active, target);
  }

  function dispose(): void {
    clearSettleTimer();
    clearCloseTimer();
    for (const timer of copyResetTimers.values()) {
      clearTimeout(timer);
    }
    copyResetTimers.clear();
    options.endSelection();
    document.removeEventListener("pointerdown", handlePress, true);
    document.removeEventListener("click", handleOutsideClick);
    activeView = undefined;
    popoverEl = undefined;
  }

  return {
    attach,
    dismiss,
    clearBoxes,
    reposition,
    setWholeSpeechState,
    dispose,
  };
}

export function isOverlayBoxActivationKey(key: string): boolean {
  return key === "Enter" || key === " ";
}

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

interface PopoverSize {
  width: number;
  height: number;
}

/** Place the popover below its block, above it, or beside it, wherever it shows
 * the most. Where that is too little, it covers part of the block. */
export function popoverPlacement(args: {
  /** The block, in the viewport. */
  box: Rect;
  viewport: PopoverSize;
  /** The side to use, instead of the one that shows the most. */
  side?: PopoverSide;
  /** The popover's full size when it is at most this wide. */
  measure(maxWidth: number): PopoverSize;
}): {
  side: PopoverSide;
  left: number;
  top: number;
  maxWidth: number;
  maxHeight: number;
} {
  const { box, viewport, measure } = args;
  const boxRight = box.x + box.width;
  const boxBottom = box.y + box.height;
  const roomRight = viewport.width - boxRight - POPOVER_MARGIN;
  const roomLeft = box.x - POPOVER_MARGIN;
  const maxWidth = popoverMaxWidth(box.width, viewport.width);
  const cap = viewport.height * POPOVER_MAX_HEIGHT_RATIO;
  const roomBelow = viewport.height - boxBottom - POPOVER_MARGIN;
  const roomAbove = box.y - POPOVER_MARGIN;

  const spots: Array<{ side: PopoverSide; width: number; room: number }> = [
    { side: "below", width: maxWidth, room: Math.min(cap, roomBelow) },
    { side: "above", width: maxWidth, room: Math.min(cap, roomAbove) },
  ];
  const roomBeside = Math.max(roomRight, roomLeft);
  if (roomBeside >= POPOVER_MIN_WIDTH) {
    const sideWidth = Math.min(roomBeside, POPOVER_MAX_WIDTH);
    spots.push({
      side: roomRight >= sideWidth ? "right" : "left",
      width: sideWidth,
      room: viewport.height - POPOVER_MARGIN * 2,
    });
  }
  // The first of those that show the same share, so below comes before beside.
  const shown = spots.map((spot) =>
    Math.min(1, spot.room / measure(spot.width).height),
  );
  const { side, width, room } =
    spots.find((spot) => spot.side === args.side) ??
    spots[shown.indexOf(Math.max(...shown))];

  const size = measure(width);
  const maxHeight = Math.max(room, Math.min(POPOVER_MIN_HEIGHT, cap));
  const height = Math.min(size.height, maxHeight);
  let x = box.x + box.width / 2 - size.width / 2;
  let y = box.y;
  if (side === "below") {
    y = boxBottom;
  } else if (side === "above") {
    y = box.y - height;
  } else {
    x = side === "right" ? boxRight : box.x - size.width;
  }
  return {
    side,
    left: insideViewport(x, size.width, viewport.width),
    top: insideViewport(y, height, viewport.height),
    maxWidth: width,
    maxHeight,
  };
}

function insideViewport(start: number, size: number, viewportSize: number): number {
  return clamp(
    start,
    POPOVER_MARGIN,
    Math.max(POPOVER_MARGIN, viewportSize - size - POPOVER_MARGIN),
  );
}

function availableMode(
  content: OverlayPopoverBox["content"],
): OverlayMode {
  return content.original.trim() ? "original" : "translation";
}

function hasBothTexts(content: OverlayPopoverBox["content"]): boolean {
  return Boolean(content.original.trim()) && Boolean(content.translated.trim());
}

function modeText(
  textMode: OverlayMode,
  content: OverlayPopoverBox["content"],
): string {
  return textMode === "original" ? content.original : content.translated;
}

function setBoxState(box: HTMLElement, open: boolean): void {
  box.classList.toggle("is-active", open);
  box.setAttribute("aria-expanded", String(open));
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

function pageToViewportRect(rect: Rect): Rect {
  return {
    x: rect.x - window.scrollX,
    y: rect.y - window.scrollY,
    width: rect.width,
    height: rect.height,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, value), Math.max(min, max));
}
