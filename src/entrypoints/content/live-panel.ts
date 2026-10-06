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
  clampPanelBox,
  growRect,
  placeLivePanel,
  rectsOverlap,
  resizePanelBox,
  type PanelBox,
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
// Lines scrolled this close to the end still count as being at the end.
const SCROLL_END_SLACK = 8;
// How long the lines take to slide up for a new line, and the line to fade in.
const LINE_ANIMATION_MS = 180;
// The same curve as --ocr-ease-out in the stylesheet.
const LINE_EASING = "cubic-bezier(0.16, 0.84, 0.44, 1)";

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
  let state: LiveState = { status: "starting", lines: [] };
  let showOriginal = false;
  // One view per line in `state.lines`, in the same order.
  const views: LineView[] = [];
  // Where the user moved or resized the panel to. Until then it follows the
  // region.
  let placed: PanelBox | undefined;

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
    keepingScroll(draw);
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

  // Screen readers announce each line as it is added.
  const lineList = document.createElement("div");
  lineList.className = "ocr-translate-live-lines";
  lineList.setAttribute("role", "log");
  // The lines sit in a track so that they can slide as one.
  const track = document.createElement("div");
  track.className = "ocr-translate-live-track";
  lineList.append(track);
  // The slide that is still running, and the new lines to fade in.
  let slide: Animation | undefined;
  const added: HTMLElement[] = [];

  const note = textElement("ocr-translate-live-note");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "ocr-translate-popup-retry ocr-translate-live-retry";
  retry.textContent = t("commonRetry");
  retry.addEventListener("click", () => callbacks.onRetry());

  // The status stays in view while the lines scroll.
  const footer = document.createElement("div");
  footer.className = "ocr-translate-live-footer";
  footer.setAttribute("aria-live", "polite");
  footer.append(note, retry);

  const resizeGrip = document.createElement("div");
  resizeGrip.className = "ocr-translate-live-resize";
  resizeGrip.setAttribute("aria-hidden", "true");

  panel.append(topbar, lineList, footer, resizeGrip);
  root.append(frame, panel);

  function viewport(): ViewportSize {
    return {
      width: document.documentElement.clientWidth || window.innerWidth,
      height: document.documentElement.clientHeight || window.innerHeight,
    };
  }


  // From the track's height, not `scrollHeight`, which grows while it slides.
  function maxScroll(): number {
    return Math.max(0, track.offsetHeight - lineList.clientHeight);
  }

  /** How far the track is from its place while it slides. */
  function slideOffset(): number {
    if (slide?.playState !== "running") {
      return 0;
    }
    return new DOMMatrixReadOnly(getComputedStyle(track).transform).m42;
  }

  /** Runs `change`, and keeps showing the newest line if it was in view. Once
   * the user scrolls up to read, the lines they read stay where they are as
   * new lines come in below them.
   *
   * With `animate`, the lines slide up to their new place, and new lines fade
   * in. */
  function keepingScroll(change: () => void, animate = false): void {
    const atEnd = lineList.scrollTop >= maxScroll() - SCROLL_END_SLACK;
    const scrolledFrom = lineList.scrollTop;
    const offset = slideOffset();
    slide?.cancel();
    slide = undefined;
    change();
    const fadeIn = added.splice(0);
    if (!atEnd) {
      return;
    }
    lineList.scrollTop = maxScroll();
    if (!animate || prefersReducedMotion()) {
      return;
    }

    // The scroll moved the lines up at once. Start them where they were.
    const shift = lineList.scrollTop - scrolledFrom + offset;
    if (shift >= 1) {
      slide = track.animate(
        [{ transform: `translateY(${shift}px)` }, { transform: "none" }],
        { duration: LINE_ANIMATION_MS, easing: LINE_EASING },
      );
    }
    for (const element of fadeIn) {
      // It ends at the opacity the stylesheet gives it, which for the newest
      // line is full.
      element.animate([{ opacity: 0 }], {
        duration: LINE_ANIMATION_MS,
        easing: LINE_EASING,
      });
    }
  }

  function position(): void {
    // A window that shrinks squeezes the panel only for as long as it is small.
    const box = placed
      ? clampPanelBox(placed, viewport())
      : placeLivePanel(region, viewport());
    panel.style.left = `${box.left}px`;
    panel.style.top = `${box.top}px`;
    panel.style.width = `${box.width}px`;
    panel.style.height = `${box.height}px`;
  }

  /** Lets the pointer that goes down on `handle` change the panel's box, as
   * `change` works it out from the box it started with and how far it moved. */
  function followPointer(
    handle: HTMLElement,
    change: (start: PanelBox, dx: number, dy: number) => PanelBox,
  ): void {
    let gesture:
      | { pointerId: number; x: number; y: number; start: PanelBox }
      | undefined;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || (event.target as Element).closest("button")) {
        return;
      }
      const box = panel.getBoundingClientRect();
      gesture = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        start: {
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
        },
      };
      handle.setPointerCapture?.(event.pointerId);
      handle.classList.add("is-dragging");
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      placed = clampPanelBox(
        change(gesture.start, event.clientX - gesture.x, event.clientY - gesture.y),
        viewport(),
      );
      keepingScroll(position);
    });
    const end = (event: PointerEvent): void => {
      if (gesture && event.pointerId === gesture.pointerId) {
        gesture = undefined;
        handle.classList.remove("is-dragging");
      }
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  followPointer(topbar, (start, dx, dy) => ({
    ...start,
    left: start.left + dx,
    top: start.top + dy,
  }));
  followPointer(resizeGrip, (start, dx, dy) =>
    resizePanelBox(start, start.width + dx, start.height + dy, viewport()),
  );

  for (const type of CONTAINED_EVENTS) {
    panel.addEventListener(type, (event) => event.stopPropagation());
  }

  const onResize = (): void => keepingScroll(position);
  window.addEventListener("resize", onResize);
  position();
  draw();

  function draw(): void {
    const { status } = state;
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

    lineList.classList.toggle("is-showing-original", showOriginal);
    lineList.classList.toggle("is-empty", state.lines.length === 0);
    drawLines();

    const message = statusNote(state);
    note.textContent = message.text;
    note.classList.toggle("is-error", message.isError);
    retry.hidden = status !== "error";
    footer.classList.toggle("is-empty", !message.text && retry.hidden);
  }

  function drawLines(): void {
    const { lines } = state;
    // Lines are only ever added at the end, so a line keeps its place.
    lines.forEach((line, index) => {
      const existing = views[index];
      const view = existing ?? createLineView();
      if (!existing) {
        views.push(view);
        track.append(view.element);
        added.push(view.element);
      }
      if (view.line !== line) {
        fillLineView(view, line);
      }
      view.element.classList.toggle(
        "is-current",
        state.line !== undefined && index === lines.length - 1,
      );
    });
    for (const view of views.splice(lines.length)) {
      view.element.remove();
    }
  }

  return {
    render(next) {
      state = next;
      keepingScroll(draw, true);
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
      window.removeEventListener("resize", onResize);
      frame.remove();
      panel.remove();
    },
  };
}

interface LineView {
  line?: LiveLine;
  element: HTMLDivElement;
  translation: HTMLParagraphElement;
  original: HTMLParagraphElement;
  note: HTMLParagraphElement;
}

function createLineView(): LineView {
  const element = document.createElement("div");
  element.className = "ocr-translate-live-line";
  const translation = textElement("ocr-translate-live-translation");
  translation.dir = "auto";
  const original = textElement("ocr-translate-live-original");
  original.dir = "auto";
  const note = textElement("ocr-translate-live-line-note");
  element.append(translation, original, note);
  return { element, translation, original, note };
}

function fillLineView(view: LineView, line: LiveLine): void {
  view.line = line;
  view.element.dataset.state = line.state;
  // Screen readers wait for the translation instead of reading the line twice.
  view.element.setAttribute("aria-busy", String(line.state === "pending"));

  const ready = line.state === "ready";
  // Without a translation the text that was read is all there is to show.
  view.translation.textContent = ready ? line.translation ?? "" : line.original;
  view.original.textContent = ready ? line.original : "";

  const message = lineNote(line);
  view.note.textContent = message.text;
  view.note.classList.toggle("is-error", message.isError);
}

function lineNote(line: LiveLine): { text: string; isError: boolean } {
  switch (line.state) {
    case "same-language":
      return { text: t("panelAlreadyInTargetLanguage"), isError: false };
    case "failed":
      return { text: line.error || t("commonTranslationFailed"), isError: true };
    default:
      return { text: "", isError: false };
  }
}

function statusNote(state: LiveState): { text: string; isError: boolean } {
  if (state.status === "error") {
    return { text: state.error ?? "", isError: true };
  }
  if (state.status === "paused") {
    return { text: t("livePaused"), isError: false };
  }
  // Once there are lines, the gaps between them need no note.
  if (state.lines.length === 0) {
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

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
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
