import type { LangCode, Rect } from "@/shared/types";
import type { OverlayMode } from "@/shared/storage";
import { t } from "@/shared/i18n";
import {
  CHECK_ICON,
  COPY_ICON,
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
const POPOVER_MAX_HEIGHT_RATIO = 0.6;
const POPOVER_MIN_HEIGHT = 120;

export interface OverlayPopoverBox {
  element: HTMLElement;
  rect: Rect;
  angle: number;
  content: {
    original: string;
    translated: string;
  };
}

interface OverlayPopoverState {
  boxes: readonly OverlayPopoverBox[];
  mode: OverlayMode;
  hasTranslation: boolean;
  sourceLang?: LangCode;
  targetLang?: LangCode;
  selectingFromPopover: boolean;
}

interface OverlayPopoverOptions {
  container: HTMLElement;
  speechOwner: string;
  getState(): OverlayPopoverState;
  beginSelection(): void;
  endSelection(): void;
}

interface PopoverView {
  el: HTMLElement;
  body?: HTMLElement;
  boxIndex: number;
  speechButtons: Partial<Record<OverlayMode, HTMLButtonElement>>;
}

export interface OverlayPopover {
  attach(box: HTMLElement, index: number): void;
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
    if (activeView?.boxIndex === index) {
      return;
    }
    settleOrigin = { x: event.clientX, y: event.clientY };
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      settleOrigin = undefined;
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
      state().selectingFromPopover ||
      hasSelectionInside(activeView.el) ||
      (speakingBoxIndex === activeView.boxIndex &&
        isSpeaking(options.speechOwner))
    );
  }

  function toggle(index: number): void {
    if (activeView?.boxIndex === index) {
      hide();
      return;
    }
    show(index);
  }

  function show(index: number): void {
    clearCloseTimer();
    if (activeView?.boxIndex === index) {
      return;
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
    document.addEventListener("click", handleOutsideClick);
    popoverEl = el;
    return el;
  }

  function handleOutsideClick(event: MouseEvent): void {
    if (!activeView) {
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
    controls.append(
      createSpeakButton(view, textMode, content),
      createCopyButton(textMode, content),
    );

    row.append(createText(textMode, content), controls);
    return row;
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

  function hide(): void {
    clearSettleTimer();
    clearCloseTimer();
    if (!activeView) {
      return;
    }
    if (
      speakingBoxIndex === activeView.boxIndex &&
      isSpeaking(options.speechOwner)
    ) {
      stopSpeaking();
    }
    activeView.el.hidden = true;
    activeView = undefined;
    syncBoxStates();
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

  function position(view: PopoverView): void {
    if (view.el.hidden) {
      return;
    }
    const currentState = state();
    const box = currentState.boxes[view.boxIndex];
    if (!box) {
      return;
    }
    const translationPanel =
      currentState.mode === "translation"
        ? box.element.firstElementChild
        : undefined;
    const rect =
      translationPanel instanceof HTMLElement
        ? translationPanel.getBoundingClientRect()
        : pageToViewportRect(rotatedBounds(box.rect, box.angle));
    view.el.style.maxWidth = `${popoverMaxWidth(rect.width, window.innerWidth)}px`;
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
    document.removeEventListener("click", handleOutsideClick);
    activeView = undefined;
    popoverEl = undefined;
  }

  return {
    attach,
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
