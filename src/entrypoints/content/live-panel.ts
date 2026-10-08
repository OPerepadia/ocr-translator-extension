import { t } from "@/shared/i18n";
import { LIVE_TEXT_SCALES, type LiveTextScale } from "@/shared/storage";
import type { Rect } from "@/shared/types";
import {
  ARROW_DOWN_ICON,
  CLOSE_ICON,
  ORIGINAL_TEXT_ICON,
  PAUSE_ICON,
  PLAY_ICON,
  SELECT_REGION_ICON,
  TEXT_SIZE_ICON,
} from "./icons";
import {
  clampPanelBox,
  growRect,
  placeLivePanel,
  rectsOverlap,
  resizePanelBox,
  type ResizeEdge,
  type PanelBox,
  type ViewportSize,
} from "./live-layout";
import { languageName } from "./language-picker";
import type { LiveLine, LiveState } from "./live-session";

const RESIZE_EDGES: ResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

export interface LivePanelCallbacks {
  onPause(): void;
  onResume(): void;
  onSelectNewRegion(): void;
  onRetry(): void;
  onClose(): void;
  onTextScaleChange(scale: LiveTextScale): void;
}

export interface LivePanel {
  render(state: LiveState): void;
  /** Draws the frame where the region is now. The panel goes along unless the
   * user has placed it. */
  moveRegion(region: Rect): void;
  /** Where the panel covers the region, in viewport coordinates, or nothing
   * when it does not. The live loop blanks this before reading so the panel's
   * own text is not read back. */
  getMask(): Rect | undefined;
  dispose(): void;
}

// The frame around the region sits this far outside it, which leaves a clear
// strip between the frame and the pixels that get read.
const FRAME_OUTSET = 4;
// After this long in one place the frame fades back, so it stops distracting
// from the page.
const FRAME_SETTLE_MS = 1500;
// The panel's edge blurs a little past its box.
const MASK_PADDING = 3;
// Lines scrolled this close to the end still count as being at the end.
const SCROLL_END_SLACK = 8;
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
  initialRegion: Rect,
  callbacks: LivePanelCallbacks,
  initialTextScale: LiveTextScale,
): LivePanel {
  let state: LiveState = { status: "starting", lines: [] };
  let region = initialRegion;
  let showOriginal = false;
  let textScale = initialTextScale;
  // One view per line in `state.lines`, in the same order.
  const views: LineView[] = [];
  // Where the user moved or resized the panel to. Until then it follows the
  // region.
  let placed: PanelBox | undefined;

  const frame = document.createElement("div");
  frame.className = "ocr-translate-live-region";
  let settleTimer: number | undefined;
  drawFrame();

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

  // Always left to right, so the arrow points from the source to the target.
  const languages = document.createElement("span");
  languages.className = "ocr-translate-live-languages";
  languages.dir = "ltr";

  const originalButton = iconButton(ORIGINAL_TEXT_ICON, () => {
    showOriginal = !showOriginal;
    keepingScroll(draw);
  });
  const smallerButton = stepButton("−", () => changeTextScale(-1));
  const largerButton = stepButton("+", () => changeTextScale(1));
  const sizeValue = document.createElement("span");
  sizeValue.className = "ocr-translate-live-size-value";
  sizeValue.setAttribute("aria-live", "polite");
  const sizePopover = document.createElement("div");
  sizePopover.className = "ocr-translate-live-size-popover";
  sizePopover.setAttribute("role", "group");
  sizePopover.setAttribute("aria-label", t("liveTextSize"));
  sizePopover.hidden = true;
  sizePopover.append(smallerButton, sizeValue, largerButton);
  const sizeButton = iconButton(
    TEXT_SIZE_ICON,
    () => setSizeOpen(Boolean(sizePopover.hidden)),
    t("liveTextSize"),
  );
  sizeButton.setAttribute("aria-haspopup", "true");
  sizeButton.setAttribute("aria-expanded", "false");
  const sizeControl = document.createElement("div");
  sizeControl.className = "ocr-translate-live-size";
  sizeControl.append(sizeButton, sizePopover);
  sizeControl.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !sizePopover.hidden) {
      event.preventDefault();
      event.stopPropagation();
      setSizeOpen(false);
      sizeButton.focus();
    }
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
  actions.append(
    originalButton,
    sizeControl,
    pauseButton,
    selectButton,
    closeButton,
  );

  const topbar = document.createElement("div");
  topbar.className = "ocr-translate-live-topbar";
  // The title and the languages after it, as wide as their text.
  const heading = document.createElement("div");
  heading.className = "ocr-translate-live-heading";
  heading.append(title, languages);

  topbar.append(dot, heading, actions);

  // Screen readers announce each line as it is added.
  const lineList = document.createElement("div");
  lineList.className = "ocr-translate-live-lines";
  lineList.setAttribute("role", "log");

  const note = textElement("ocr-translate-live-note");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "ocr-translate-popup-retry ocr-translate-live-retry";
  retry.textContent = t("commonRetry");
  retry.addEventListener("click", () => callbacks.onRetry());

  // Brings the newest line back into view after scrolling up to read. It has
  // no text, so it has no name for assistive technology either. The list can
  // be scrolled by keyboard.
  const latestButton = document.createElement("button");
  latestButton.type = "button";
  latestButton.className = "ocr-translate-live-latest";
  latestButton.tabIndex = -1;
  latestButton.setAttribute("aria-hidden", "true");
  latestButton.innerHTML = ARROW_DOWN_ICON;
  latestButton.addEventListener("click", () => {
    lineList.scrollTop = maxScroll();
    updateLatestButton();
  });

  // The status stays in view while the lines scroll.
  const footer = document.createElement("div");
  footer.className = "ocr-translate-live-footer";
  footer.setAttribute("aria-live", "polite");
  footer.append(note, retry, latestButton);

  const resizeHandles = RESIZE_EDGES.map((edge) => {
    const handle = document.createElement("div");
    handle.className = `ocr-translate-live-resize is-${edge}`;
    handle.setAttribute("aria-hidden", "true");
    return { edge, handle };
  });

  panel.append(
    topbar,
    lineList,
    footer,
    ...resizeHandles.map(({ handle }) => handle),
  );
  root.append(frame, panel);

  function setSizeOpen(open: boolean): void {
    sizePopover.hidden = !open;
    sizeButton.setAttribute("aria-expanded", String(open));
  }

  function drawTextScale(): void {
    panel.style.setProperty("--ocr-live-scale", String(textScale));
    sizeValue.textContent = `${Math.round(textScale * 100)}%`;
    smallerButton.disabled = textScale === LIVE_TEXT_SCALES[0];
    largerButton.disabled =
      textScale === LIVE_TEXT_SCALES[LIVE_TEXT_SCALES.length - 1];
  }

  function changeTextScale(direction: -1 | 1): void {
    const next =
      LIVE_TEXT_SCALES[LIVE_TEXT_SCALES.indexOf(textScale) + direction];
    if (next === undefined) {
      return;
    }
    textScale = next;
    keepingScroll(drawTextScale);
    callbacks.onTextScaleChange(textScale);
    // A button that reaches the end of its range is disabled, and a disabled
    // button cannot be used from the keyboard. Move to the other one.
    const [reached, other] =
      direction === 1
        ? [largerButton, smallerButton]
        : [smallerButton, largerButton];
    if (reached.disabled) {
      other.focus();
    }
  }

  // Captured because the panel stops pointer events from going on to the
  // document, so a click inside the panel would not get there.
  const onPointerDown = (event: PointerEvent): void => {
    if (!sizePopover.hidden && !event.composedPath().includes(sizeControl)) {
      setSizeOpen(false);
    }
  };
  document.addEventListener("pointerdown", onPointerDown, true);

  function viewport(): ViewportSize {
    return {
      width: document.documentElement.clientWidth || window.innerWidth,
      height: document.documentElement.clientHeight || window.innerHeight,
    };
  }

  function maxScroll(): number {
    return Math.max(0, lineList.scrollHeight - lineList.clientHeight);
  }

  function updateLatestButton(): void {
    latestButton.classList.toggle(
      "is-visible",
      lineList.scrollTop < maxScroll() - SCROLL_END_SLACK,
    );
  }
  lineList.addEventListener("scroll", updateLatestButton);

  /** Runs `change`, and keeps showing the newest line if it was in view. Once
   * the user scrolls up to read, the lines they read stay where they are as
   * new lines come in below them. */
  function keepingScroll(change: () => void): void {
    const atEnd = lineList.scrollTop >= maxScroll() - SCROLL_END_SLACK;
    change();
    if (atEnd) {
      lineList.scrollTop = maxScroll();
    }
    updateLatestButton();
  }

  /** Draws the frame around the region in full. It fades back later. */
  function drawFrame(): void {
    frame.style.left = `${region.x - FRAME_OUTSET}px`;
    frame.style.top = `${region.y - FRAME_OUTSET}px`;
    frame.style.width = `${region.width + FRAME_OUTSET * 2}px`;
    frame.style.height = `${region.height + FRAME_OUTSET * 2}px`;
    frame.classList.remove("is-settled");
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(
      () => frame.classList.add("is-settled"),
      FRAME_SETTLE_MS,
    );
  }

  function position(): void {
    // A window that shrinks squeezes the panel only for as long as it is
    // small. A region that scrolls out of view leaves the panel at the edge.
    const box = clampPanelBox(
      placed ?? placeLivePanel(region, viewport()),
      viewport(),
    );
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
      if (
        event.button !== 0 ||
        (event.target as Element).closest(
          "button, .ocr-translate-live-size-popover",
        )
      ) {
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
  for (const { edge, handle } of resizeHandles) {
    followPointer(handle, (start, dx, dy) =>
      resizePanelBox(start, edge, dx, dy, viewport()),
    );
  }

  for (const type of CONTAINED_EVENTS) {
    panel.addEventListener(type, (event) => event.stopPropagation());
  }

  const onResize = (): void => keepingScroll(position);
  window.addEventListener("resize", onResize);
  position();
  drawTextScale();
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

    drawLanguages();
    lineList.classList.toggle("is-showing-original", showOriginal);
    lineList.classList.toggle("is-empty", state.lines.length === 0);
    drawLines();

    const message = statusNote(state);
    note.textContent = message.text;
    note.classList.toggle("is-error", message.isError);
    retry.hidden = status !== "error";
    footer.classList.toggle("is-empty", !message.text && retry.hidden);
  }

  // "EN → UK", with the names in the tooltip. Before the first translation
  // nothing is known, and a source that was not found leaves just the target.
  function drawLanguages(): void {
    const { sourceLang, targetLang } = state;
    if (!targetLang && !sourceLang) {
      languages.textContent = "";
      languages.removeAttribute("title");
      return;
    }
    const code = (lang?: string): string => lang?.toUpperCase() ?? "?";
    languages.textContent = sourceLang
      ? `${code(sourceLang)} → ${code(targetLang)}`
      : `→ ${code(targetLang)}`;
    languages.title = [sourceLang, targetLang]
      .map((lang) => (lang ? languageName(lang) : "?"))
      .join(" → ");
  }

  function drawLines(): void {
    const { lines } = state;
    // Lines are only ever added at the end, so a line keeps its place.
    lines.forEach((line, index) => {
      const existing = views[index];
      const view = existing ?? createLineView();
      if (!existing) {
        view.element.classList.add("is-new");
        view.element.addEventListener(
          "animationend",
          () => view.element.classList.remove("is-new"),
          { once: true },
        );
        views.push(view);
        lineList.append(view.element);
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
      keepingScroll(draw);
    },

    moveRegion(next) {
      region = next;
      drawFrame();
      keepingScroll(position);
    },

    getMask() {
      const box = panel.getBoundingClientRect();
      const covered = growRect(
        { x: box.left, y: box.top, width: box.width, height: box.height },
        MASK_PADDING,
      );
      return rectsOverlap(covered, region) ? covered : undefined;
    },

    dispose() {
      window.clearTimeout(settleTimer);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("pointerdown", onPointerDown, true);
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
  waiting: HTMLParagraphElement;
  note: HTMLParagraphElement;
}

function createLineView(): LineView {
  const element = document.createElement("div");
  element.className = "ocr-translate-live-line";
  const original = textElement("ocr-translate-live-original");
  original.dir = "auto";
  const waiting = textElement("ocr-translate-live-waiting");
  const translation = textElement("ocr-translate-live-translation");
  translation.dir = "auto";
  const note = textElement("ocr-translate-live-line-note");
  element.append(original, waiting, translation, note);
  return { element, translation, original, waiting, note };
}

function fillLineView(view: LineView, line: LiveLine): void {
  view.line = line;
  view.element.dataset.state = line.state;
  // Screen readers wait for the translation instead of reading the line twice.
  view.element.setAttribute("aria-busy", String(line.state === "pending"));

  const ready = line.state === "ready";
  // Without a translation the text that was read is all there is to show.
  view.translation.textContent = ready ? line.translation ?? "" : line.original;
  // A pending line has both, so the original can stay put above while the
  // translation comes in below it.
  const pending = line.state === "pending";
  view.original.textContent = ready || pending ? line.original : "";
  view.waiting.textContent = pending ? t("statusTranslating") : "";

  const message = lineNote(line);
  view.note.textContent = message.text;
  view.note.classList.toggle("is-error", message.isError);
}

function lineNote(line: LiveLine): { text: string; isError: boolean } {
  switch (line.state) {
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

function stepButton(symbol: string, onClick: () => void): HTMLButtonElement {
  const button = iconButton("", onClick);
  button.textContent = symbol;
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
