import { t } from "@/shared/i18n";
import type { Rect } from "@/shared/types";
import {
  CLOSE_ICON,
  ORIGINAL_TEXT_ICON,
  PAUSE_ICON,
  PLAY_ICON,
  SELECT_REGION_ICON,
} from "./icons";
import {
  clampPanelPosition,
  growRect,
  PANEL_MARGIN,
  PANEL_MAX_HEIGHT,
  placeLivePanel,
  rectsOverlap,
  type PanelPlacement,
  type ViewportSize,
} from "./live-layout";
import type { LiveLine, LiveState } from "./live-session";

export interface LivePanelCallbacks {
  onPause(): void;
  onResume(): void;
  onSelectNewRegion(): void;
  onRetry(): void;
  onClose(): void;
}

export interface LivePanel {
  render(state: LiveState): void;
  /** Where the panel covers the region, in viewport coordinates. The live loop
   * blanks these before reading so the panel's own text is not read back. */
  getMask(): Rect[];
  dispose(): void;
}

// The frame around the region sits this far outside it, which leaves a clear
// strip between the frame and the pixels that get read.
const FRAME_OUTSET = 4;
// The panel's edge blurs a little past its box.
const MASK_PADDING = 3;

// Mouse and touch events that would otherwise reach the page's own handlers.
// The panel can sit inside a video player, where a click pauses the video and
// a double click goes full screen.
const CONTAINED_EVENTS = [
  "click",
  "dblclick",
  "mousedown",
  "mouseup",
  "pointerdown",
  "pointerup",
  "touchstart",
  "touchend",
  "contextmenu",
] as const;

export function showLivePanel(
  root: HTMLElement,
  region: Rect,
  callbacks: LivePanelCallbacks,
): LivePanel {
  let state: LiveState = { status: "starting" };
  let showOriginal = false;
  // Where the user dragged the panel to. Until then it follows the region.
  let dragged: { left: number; top: number } | undefined;
  let drag:
    | { pointerId: number; x: number; y: number; left: number; top: number }
    | undefined;

  const frame = document.createElement("div");
  frame.className = "ocr-translate-live-region";
  frame.style.left = `${region.x - FRAME_OUTSET}px`;
  frame.style.top = `${region.y - FRAME_OUTSET}px`;
  frame.style.width = `${region.width + FRAME_OUTSET * 2}px`;
  frame.style.height = `${region.height + FRAME_OUTSET * 2}px`;

  const panel = document.createElement("div");
  panel.className = "ocr-translate-live";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", t("popupLiveTranslation"));

  const dot = document.createElement("span");
  dot.className = "ocr-translate-live-status";
  dot.setAttribute("aria-hidden", "true");

  const title = document.createElement("strong");
  title.className = "ocr-translate-live-title";
  title.textContent = t("popupLiveTranslation");

  const originalButton = iconButton(ORIGINAL_TEXT_ICON, () => {
    showOriginal = !showOriginal;
    draw();
  });
  const pauseButton = iconButton(PAUSE_ICON, () => {
    if (state.status === "paused") {
      callbacks.onResume();
    } else {
      callbacks.onPause();
    }
  });
  const selectButton = iconButton(
    SELECT_REGION_ICON,
    () => callbacks.onSelectNewRegion(),
    t("panelSelectNewRegion"),
  );
  const closeButton = iconButton(
    CLOSE_ICON,
    () => callbacks.onClose(),
    t("commonClose"),
  );

  const actions = document.createElement("div");
  actions.className = "ocr-translate-live-actions";
  actions.append(originalButton, pauseButton, selectButton, closeButton);

  const topbar = document.createElement("div");
  topbar.className = "ocr-translate-live-topbar";
  topbar.append(dot, title, actions);

  const translationText = textElement("ocr-translate-live-translation");
  const originalText = textElement("ocr-translate-live-original");
  const note = textElement("ocr-translate-live-note");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "ocr-translate-popup-retry ocr-translate-live-retry";
  retry.textContent = t("commonRetry");
  retry.addEventListener("click", () => callbacks.onRetry());

  // Screen readers announce each new subtitle as it replaces the last.
  const body = document.createElement("div");
  body.className = "ocr-translate-live-body";
  body.setAttribute("aria-live", "polite");
  body.append(translationText, originalText, note, retry);

  panel.append(topbar, body);
  root.append(frame, panel);

  function viewport(): ViewportSize {
    return {
      width: document.documentElement.clientWidth || window.innerWidth,
      height: document.documentElement.clientHeight || window.innerHeight,
    };
  }

  function applyPlacement(placement: PanelPlacement): void {
    panel.style.width = `${placement.width}px`;
    panel.style.maxHeight = `${placement.maxHeight}px`;
    for (const side of ["left", "right", "top", "bottom"] as const) {
      const value = placement[side];
      panel.style[side] = value === undefined ? "" : `${value}px`;
    }
  }

  function position(): void {
    if (!dragged) {
      applyPlacement(placeLivePanel(region, viewport()));
      return;
    }
    const box = panel.getBoundingClientRect();
    dragged = clampPanelPosition(
      dragged,
      { width: box.width, height: box.height },
      viewport(),
    );
    panel.style.left = `${dragged.left}px`;
    panel.style.top = `${dragged.top}px`;
    panel.style.right = "";
    panel.style.bottom = "";
    panel.style.maxHeight = `${Math.min(
      PANEL_MAX_HEIGHT,
      viewport().height - dragged.top - PANEL_MARGIN,
    )}px`;
  }

  topbar.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) {
      return;
    }
    const box = panel.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: box.left,
      top: box.top,
    };
    topbar.setPointerCapture?.(event.pointerId);
    topbar.classList.add("is-dragging");
    event.preventDefault();
  });
  topbar.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    dragged = {
      left: drag.left + event.clientX - drag.x,
      top: drag.top + event.clientY - drag.y,
    };
    position();
  });
  const endDrag = (event: PointerEvent): void => {
    if (drag && event.pointerId === drag.pointerId) {
      drag = undefined;
      topbar.classList.remove("is-dragging");
    }
  };
  topbar.addEventListener("pointerup", endDrag);
  topbar.addEventListener("pointercancel", endDrag);

  for (const type of CONTAINED_EVENTS) {
    panel.addEventListener(type, (event) => event.stopPropagation());
  }

  window.addEventListener("resize", position);
  position();
  draw();

  function draw(): void {
    const { status, line } = state;
    panel.dataset.status = status;
    frame.dataset.status = status;

    const paused = status === "paused";
    setButton(
      pauseButton,
      paused ? PLAY_ICON : PAUSE_ICON,
      paused ? t("liveResume") : t("livePause"),
    );
    pauseButton.disabled = status === "error";
    setButton(
      originalButton,
      ORIGINAL_TEXT_ICON,
      showOriginal ? t("liveHideOriginal") : t("liveShowOriginal"),
    );
    originalButton.setAttribute("aria-pressed", String(showOriginal));

    const text = describeLine(line, showOriginal);
    translationText.textContent = text.main;
    translationText.classList.toggle("is-pending", text.pending);
    translationText.dir = "auto";
    originalText.textContent = text.original;
    originalText.dir = "auto";

    const message = noteFor(state, line);
    note.textContent = message.text;
    note.classList.toggle("is-error", message.isError);
    retry.hidden = status !== "error";
  }

  return {
    render(next) {
      state = next;
      draw();
    },

    getMask() {
      const box = panel.getBoundingClientRect();
      const covered = growRect(
        { x: box.left, y: box.top, width: box.width, height: box.height },
        MASK_PADDING,
      );
      return rectsOverlap(covered, region) ? [covered] : [];
    },

    dispose() {
      window.removeEventListener("resize", position);
      frame.remove();
      panel.remove();
    },
  };
}

function describeLine(
  line: LiveLine | undefined,
  showOriginal: boolean,
): { main: string; original: string; pending: boolean } {
  if (!line) {
    return { main: "", original: "", pending: false };
  }
  if (line.state === "ready") {
    return {
      main: line.translation ?? "",
      original: showOriginal ? line.original : "",
      pending: false,
    };
  }
  // Without a translation the text that was read is all there is to show.
  return { main: line.original, original: "", pending: line.state === "pending" };
}

function noteFor(
  state: LiveState,
  line: LiveLine | undefined,
): { text: string; isError: boolean } {
  if (state.status === "error") {
    return { text: state.error ?? "", isError: true };
  }
  if (state.status === "paused") {
    return { text: t("livePaused"), isError: false };
  }
  if (line?.state === "pending") {
    return { text: t("statusTranslating"), isError: false };
  }
  if (line?.state === "same-language") {
    return { text: t("panelAlreadyInTargetLanguage"), isError: false };
  }
  if (line?.state === "failed") {
    return { text: line.error || t("commonTranslationFailed"), isError: true };
  }
  if (!line) {
    return {
      text:
        state.status === "starting"
          ? t("statusInitializingOcr")
          : t("liveWaitingForText"),
      isError: false,
    };
  }
  return { text: "", isError: false };
}

function iconButton(
  icon: string,
  onClick: () => void,
  label?: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ocr-translate-popup-icon-button";
  button.addEventListener("click", onClick);
  if (label) {
    setButton(button, icon, label);
  }
  return button;
}

function setButton(button: HTMLButtonElement, icon: string, label: string): void {
  button.innerHTML = icon;
  button.setAttribute("aria-label", label);
  button.title = label;
}

function textElement(className: string): HTMLParagraphElement {
  const element = document.createElement("p");
  element.className = className;
  return element;
}
