import type { Rect } from "@/shared/types";
import { t } from "@/shared/i18n";

interface Point {
  x: number;
  y: number;
}

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type DragState =
  | { kind: "draw"; start: Point }
  | { kind: "move"; start: Point; rect: Rect }
  | { kind: "resize"; start: Point; rect: Rect; handle: Handle }
  | null;

const MIN_SIZE = 30;
const RESIZE_HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

// A confirmed selection leaves its dim on screen (bare, click-through) so the
// page doesn't flash bright while the background takes the screenshot. The
// capture is cropped to the selection, so the dim outside it never shows up
// in the image.
let lingeringOverlay: HTMLElement | undefined;

// Dismisses a selection still being drawn, as Escape does. Set while one is on
// screen so callers outside the flow (a route change) can drop it.
let cancelActiveSelection: (() => void) | undefined;

// Remove the dim left behind by a confirmed selection. Called once the next
// view's own dim (or an error) is on screen, and before a new selection starts.
export function releaseSelectionDim(): void {
  lingeringOverlay?.remove();
  lingeringOverlay = undefined;
}

// Abandon an in-progress selection; its promise resolves to null, so the caller
// stops before capturing. No-op when nothing is being selected.
export function cancelSelectionOverlay(): void {
  cancelActiveSelection?.();
}

// Draw a rectangle, then refine it before confirming. Coordinates are viewport
// CSS pixels; the caller pairs them with the current viewport size.
export function startSelectionOverlay(
  container: HTMLElement,
  startImmediately = false,
): Promise<Rect | null> {
  return new Promise((resolve) => {
    releaseSelectionDim();

    let dragState: DragState = null;
    let currentRect: Rect | null = null;

    const overlay = document.createElement("div");
    overlay.className = "ocr-translate-selection-overlay";

    const dim = document.createElement("div");
    dim.className = "ocr-translate-selection-dim";
    overlay.append(dim);

    const hint = document.createElement("div");
    hint.className = "ocr-translate-selection-hint";
    hint.append(t("selectionDragArea"), document.createElement("br"));
    const hintSub = document.createElement("span");
    hintSub.className = "ocr-translate-selection-hint-sub";
    const keyMarker = "__KEY__";
    const [beforeKey, afterKey] = t(
      "selectionPressKeyToCancel",
      keyMarker,
    ).split(keyMarker);
    const key = document.createElement("kbd");
    key.className = "ocr-translate-selection-hint-kbd";
    key.textContent = "Esc";
    hintSub.append(beforeKey ?? "", key, afterKey ?? "");
    hint.append(hintSub);
    overlay.append(hint);

    const selection = document.createElement("div");
    selection.className = "ocr-translate-selection-rect";
    for (const handle of RESIZE_HANDLES) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `ocr-translate-selection-handle is-${handle}`;
      button.dataset.handle = handle;
      button.setAttribute("aria-label", t("selectionResize"));
      selection.append(button);
    }
    overlay.append(selection);

    const controls = document.createElement("div");
    controls.className = "ocr-translate-selection-controls";
    controls.hidden = true;

    const sizeLabel = document.createElement("span");
    sizeLabel.className = "ocr-translate-selection-size";
    sizeLabel.setAttribute("aria-live", "polite");

    const runButton = document.createElement("button");
    runButton.type = "button";
    runButton.className = "ocr-translate-selection-run";
    runButton.textContent = t("selectionRunOcr");

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "ocr-translate-selection-cancel";
    cancelButton.textContent = t("commonCancel");

    controls.append(sizeLabel, runButton, cancelButton);
    overlay.append(controls);
    container.append(overlay);

    function cleanup(result: Rect | null): void {
      document.removeEventListener("keydown", onKeyDown, true);
      cancelActiveSelection = undefined;
      if (result) {
        // Keep the dim; hide the selection chrome so none of it (the border is
        // drawn inside the rect) lands in the screenshot.
        overlay.classList.add("is-capturing");
        selection.style.display = "none";
        hideControls();
        lingeringOverlay = overlay;
      } else {
        overlay.remove();
      }
      resolve(result);
    }

    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Element;
      if (currentRect && target.closest(".ocr-translate-selection-controls")) {
        event.stopPropagation();
        return;
      }
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      hint.classList.add("is-dismissed");

      if (!currentRect) {
        startDrawing(pointFromEvent(event));
        return;
      }

      const handle = target.closest<HTMLElement>(
        ".ocr-translate-selection-handle",
      )?.dataset.handle as Handle | undefined;
      if (handle) {
        dragState = {
          kind: "resize",
          start: pointFromEvent(event),
          rect: { ...currentRect },
          handle,
        };
        hideControls();
        return;
      }

      if (target.closest(".ocr-translate-selection-rect")) {
        dragState = {
          kind: "move",
          start: pointFromEvent(event),
          rect: { ...currentRect },
        };
        hideControls();
        return;
      }

      clearSelection();
      startDrawing(pointFromEvent(event));
    }

    function onPointerMove(event: PointerEvent): void {
      if (!dragState) {
        return;
      }

      event.preventDefault();
      const point = pointFromEvent(event);
      const dx = point.x - dragState.start.x;
      const dy = point.y - dragState.start.y;

      if (dragState.kind === "draw") {
        setCurrentRect(rectFromPoints(dragState.start, point), false);
      } else if (dragState.kind === "move") {
        setCurrentRect(
          { ...dragState.rect, x: dragState.rect.x + dx, y: dragState.rect.y + dy },
          true,
        );
      } else {
        setCurrentRect(resizeRect(dragState.rect, dragState.handle, dx, dy), true);
      }
    }

    function onPointerUp(event: PointerEvent): void {
      if (!dragState) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (dragState.kind !== "draw") {
        dragState = null;
        showControls();
        return;
      }

      const rect = rectFromPoints(dragState.start, pointFromEvent(event));
      dragState = null;

      if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) {
        clearSelection();
        return;
      }

      if (startImmediately) {
        hint.style.display = "none";
        cleanup(rect);
      } else {
        enterAdjustMode(rect);
      }
    }

    function startDrawing(start: Point): void {
      dragState = { kind: "draw", start };
      hideControls();
      selection.classList.remove("is-adjusting");
      selection.classList.add("is-drawing");
      setCurrentRect({ x: start.x, y: start.y, width: 0, height: 0 }, false);
    }

    function enterAdjustMode(rect: Rect): void {
      selection.classList.remove("is-drawing");
      selection.classList.add("is-adjusting");
      setCurrentRect(rect, true);
      showControls();
    }

    function setCurrentRect(rect: Rect, enforceMin: boolean): void {
      currentRect = clampRectToViewport(rect, enforceMin);
      selection.style.display = "block";
      selection.style.left = `${currentRect.x}px`;
      selection.style.top = `${currentRect.y}px`;
      selection.style.width = `${currentRect.width}px`;
      selection.style.height = `${currentRect.height}px`;
      updateDim(currentRect);
      positionControls();
    }

    function clearSelection(): void {
      currentRect = null;
      selection.style.display = "none";
      selection.classList.remove("is-adjusting", "is-drawing");
      dim.classList.remove("is-cutout");
      dim.removeAttribute("style");
      hideControls();
    }

    function updateDim(rect: Rect): void {
      dim.classList.add("is-cutout");
      dim.style.left = `${rect.x}px`;
      dim.style.top = `${rect.y}px`;
      dim.style.width = `${rect.width}px`;
      dim.style.height = `${rect.height}px`;
    }

    function resizeRect(rect: Rect, handle: Handle, dx: number, dy: number): Rect {
      let { x, y, width, height } = rect;

      if (handle.includes("w")) {
        x += dx;
        width -= dx;
      } else if (handle.includes("e")) {
        width += dx;
      }

      if (handle.includes("n")) {
        y += dy;
        height -= dy;
      } else if (handle.includes("s")) {
        height += dy;
      }

      if (width < MIN_SIZE) {
        if (handle.includes("w")) {
          x -= MIN_SIZE - width;
        }
        width = MIN_SIZE;
      }
      if (height < MIN_SIZE) {
        if (handle.includes("n")) {
          y -= MIN_SIZE - height;
        }
        height = MIN_SIZE;
      }

      return { x, y, width, height };
    }

    function clampRectToViewport(rect: Rect, enforceMin: boolean): Rect {
      const minSize = enforceMin ? MIN_SIZE : 0;
      const width = Math.min(
        Math.max(minSize, rect.width),
        Math.max(minSize, window.innerWidth),
      );
      const height = Math.min(
        Math.max(minSize, rect.height),
        Math.max(minSize, window.innerHeight),
      );
      const x = clamp(rect.x, 0, window.innerWidth - width);
      const y = clamp(rect.y, 0, window.innerHeight - height);

      return { x, y, width, height };
    }

    function showControls(): void {
      if (!currentRect) {
        return;
      }
      controls.hidden = false;
      positionControls();
      runButton.focus();
    }

    function hideControls(): void {
      controls.hidden = true;
    }

    function positionControls(): void {
      if (!currentRect || controls.hidden) {
        return;
      }

      sizeLabel.textContent = `${Math.round(currentRect.width)} × ${Math.round(
        currentRect.height,
      )}`;

      const controlsWidth = controls.offsetWidth || 230;
      const controlsHeight = controls.offsetHeight || 36;
      const x = clamp(
        currentRect.x + currentRect.width / 2 - controlsWidth / 2,
        8,
        window.innerWidth - controlsWidth - 8,
      );
      const belowY = currentRect.y + currentRect.height + 10;
      const aboveY = currentRect.y - controlsHeight - 10;
      const y =
        belowY + controlsHeight <= window.innerHeight - 8
          ? belowY
          : aboveY >= 8
            ? aboveY
            : clamp(
                belowY,
                8,
                Math.max(8, window.innerHeight - controlsHeight - 8),
              );

      controls.style.left = `${x}px`;
      controls.style.top = `${y}px`;
    }

    function keepFocusInControls(event: KeyboardEvent): void {
      const buttons = Array.from(
        controls.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
      );
      if (buttons.length === 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const activeIndex = buttons.indexOf(
        (container.getRootNode() as ShadowRoot)
          .activeElement as HTMLButtonElement,
      );
      if (activeIndex === -1) {
        (event.shiftKey ? buttons[buttons.length - 1] : buttons[0]).focus();
        return;
      }

      const step = event.shiftKey ? -1 : 1;
      buttons[(activeIndex + step + buttons.length) % buttons.length].focus();
    }

    function confirmSelection(): void {
      if (currentRect) {
        cleanup(currentRect);
      }
    }

    function onContextMenu(event: MouseEvent): void {
      event.preventDefault();
      event.stopPropagation();
      cleanup(null);
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cleanup(null);
      } else if (event.key === "Tab" && currentRect && dragState?.kind !== "draw") {
        keepFocusInControls(event);
      } else if (event.key === "Enter" && currentRect && !controls.hidden) {
        const active = (container.getRootNode() as ShadowRoot).activeElement;
        if (active && controls.contains(active)) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        confirmSelection();
      }
    }

    cancelActiveSelection = () => cleanup(null);

    runButton.addEventListener("click", confirmSelection);
    cancelButton.addEventListener("click", () => cleanup(null));
    overlay.addEventListener("pointerdown", onPointerDown);
    overlay.addEventListener("pointermove", onPointerMove);
    overlay.addEventListener("pointerup", onPointerUp);
    overlay.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("keydown", onKeyDown, true);
  });
}

function pointFromEvent(event: PointerEvent): Point {
  return { x: event.clientX, y: event.clientY };
}

function rectFromPoints(start: Point, end: Point): Rect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, value), Math.max(min, max));
}
