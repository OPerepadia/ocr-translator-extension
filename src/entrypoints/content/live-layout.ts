import type { Rect } from "@/shared/types";

export interface ViewportSize {
  width: number;
  height: number;
}

/** The panel's box, in viewport coordinates. */
export interface PanelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

// The region's frame is drawn this far outside it; the panel clears that.
export const PANEL_GAP = 12;
export const PANEL_MARGIN = 8;
export const PANEL_WIDTH = 480;
export const PANEL_HEIGHT = 180;
// The smallest the panel gets beside a region or when resized: room for the
// title bar's buttons and languages, and one line of text.
export const PANEL_MIN_WIDTH = 250;
export const PANEL_MIN_HEIGHT = 96;

/**
 * Put the panel beside the region without covering it, trying below, above,
 * then right and left. The panel must stay off the region because the screen
 * is what gets read, and it would otherwise read its own text back.
 *
 * With no room anywhere (a region that fills the viewport) the panel goes to
 * the top of the viewport, away from where subtitles usually are, and the
 * caller masks the overlap.
 */
export function placeLivePanel(
  region: Rect,
  viewport: ViewportSize,
): PanelBox {
  const width = Math.max(
    0,
    Math.min(PANEL_WIDTH, viewport.width - PANEL_MARGIN * 2),
  );
  const height = Math.max(
    0,
    Math.min(PANEL_HEIGHT, viewport.height - PANEL_MARGIN * 2),
  );
  const centered = clamp(
    region.x + region.width / 2 - width / 2,
    PANEL_MARGIN,
    viewport.width - width - PANEL_MARGIN,
  );

  const regionRight = region.x + region.width;
  const regionBottom = region.y + region.height;

  const roomBelow = viewport.height - (regionBottom + PANEL_GAP) - PANEL_MARGIN;
  if (roomBelow >= PANEL_MIN_HEIGHT) {
    return {
      left: centered,
      top: regionBottom + PANEL_GAP,
      width,
      height: Math.min(height, roomBelow),
    };
  }

  const roomAbove = region.y - PANEL_GAP - PANEL_MARGIN;
  if (roomAbove >= PANEL_MIN_HEIGHT) {
    const aboveHeight = Math.min(height, roomAbove);
    return {
      left: centered,
      top: region.y - PANEL_GAP - aboveHeight,
      width,
      height: aboveHeight,
    };
  }

  // Beside the region, level with its top as far as the viewport allows.
  const top = clamp(
    region.y,
    PANEL_MARGIN,
    viewport.height - height - PANEL_MARGIN,
  );

  const roomRight = viewport.width - (regionRight + PANEL_GAP) - PANEL_MARGIN;
  if (roomRight >= PANEL_MIN_WIDTH) {
    return {
      left: regionRight + PANEL_GAP,
      top,
      width: Math.min(width, roomRight),
      height,
    };
  }

  const roomLeft = region.x - PANEL_GAP - PANEL_MARGIN;
  if (roomLeft >= PANEL_MIN_WIDTH) {
    const leftWidth = Math.min(width, roomLeft);
    return {
      left: region.x - PANEL_GAP - leftWidth,
      top,
      width: leftWidth,
      height,
    };
  }

  return {
    left: clamp(
      (viewport.width - width) / 2,
      PANEL_MARGIN,
      viewport.width - width - PANEL_MARGIN,
    ),
    top: PANEL_MARGIN,
    width,
    height,
  };
}

/** `box` moved, and shrunk if it must be, to fit inside the viewport. */
export function clampPanelBox(box: PanelBox, viewport: ViewportSize): PanelBox {
  const width = Math.min(
    box.width,
    Math.max(0, viewport.width - PANEL_MARGIN * 2),
  );
  const height = Math.min(
    box.height,
    Math.max(0, viewport.height - PANEL_MARGIN * 2),
  );
  return {
    left: clamp(box.left, PANEL_MARGIN, viewport.width - width - PANEL_MARGIN),
    top: clamp(box.top, PANEL_MARGIN, viewport.height - height - PANEL_MARGIN),
    width,
    height,
  };
}

export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** `box` with the `edge` dragged by `dx` and `dy`. The opposite edges stay
 * put. The box is no smaller than the minimum and stays inside the viewport. */
export function resizePanelBox(
  box: PanelBox,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  viewport: ViewportSize,
): PanelBox {
  let { left, top, width, height } = box;
  if (edge.includes("e")) {
    width = clamp(
      box.width + dx,
      PANEL_MIN_WIDTH,
      viewport.width - box.left - PANEL_MARGIN,
    );
  }
  if (edge.includes("s")) {
    height = clamp(
      box.height + dy,
      PANEL_MIN_HEIGHT,
      viewport.height - box.top - PANEL_MARGIN,
    );
  }
  if (edge.includes("w")) {
    const right = box.left + box.width;
    width = clamp(box.width - dx, PANEL_MIN_WIDTH, right - PANEL_MARGIN);
    left = right - width;
  }
  if (edge.includes("n")) {
    const bottom = box.top + box.height;
    height = clamp(box.height - dy, PANEL_MIN_HEIGHT, bottom - PANEL_MARGIN);
    top = bottom - height;
  }
  return { left, top, width, height };
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** `rect` grown by `amount` on every side. */
export function growRect(rect: Rect, amount: number): Rect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, value), Math.max(min, max));
}
