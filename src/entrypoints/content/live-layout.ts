import type { Rect } from "@/shared/types";

export interface ViewportSize {
  width: number;
  height: number;
}

export type PanelSide = "below" | "above" | "right" | "left" | "overlap";

/**
 * Where the panel sits, as CSS offsets from the viewport. A panel above or to
 * the left is anchored by its bottom or right edge, so when its text grows it
 * grows away from the region instead of into it.
 */
export interface PanelPlacement {
  side: PanelSide;
  width: number;
  /** The most the panel may grow before its text scrolls. */
  maxHeight: number;
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

// The region's frame is drawn this far outside it; the panel clears that.
export const PANEL_GAP = 12;
export const PANEL_MARGIN = 8;
export const PANEL_MIN_WIDTH = 260;
export const PANEL_MAX_WIDTH = 520;
// Room for the title bar and one line of text.
export const PANEL_MIN_HEIGHT = 96;
export const PANEL_MAX_HEIGHT = 240;

/**
 * Put the panel beside the region without covering it, trying below, above,
 * then right and left. The panel must stay off the region because the screen
 * is what gets read, and it would otherwise read its own text back.
 *
 * With no room anywhere (a region that fills the viewport) the panel goes to
 * the bottom of the viewport and the caller masks the overlap.
 */
export function placeLivePanel(
  region: Rect,
  viewport: ViewportSize,
): PanelPlacement {
  const maxWidth = Math.max(0, viewport.width - PANEL_MARGIN * 2);
  const width = Math.min(
    maxWidth,
    Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, region.width)),
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
      side: "below",
      width,
      maxHeight: Math.min(PANEL_MAX_HEIGHT, roomBelow),
      left: centered,
      top: regionBottom + PANEL_GAP,
    };
  }

  const roomAbove = region.y - PANEL_GAP - PANEL_MARGIN;
  if (roomAbove >= PANEL_MIN_HEIGHT) {
    return {
      side: "above",
      width,
      maxHeight: Math.min(PANEL_MAX_HEIGHT, roomAbove),
      left: centered,
      bottom: viewport.height - (region.y - PANEL_GAP),
    };
  }

  const alongside = (room: number) => ({
    width: Math.min(width, room),
    top: clamp(
      region.y,
      PANEL_MARGIN,
      viewport.height - PANEL_MIN_HEIGHT - PANEL_MARGIN,
    ),
  });

  const roomRight = viewport.width - (regionRight + PANEL_GAP) - PANEL_MARGIN;
  if (roomRight >= PANEL_MIN_WIDTH) {
    const { width: sideWidth, top } = alongside(roomRight);
    return {
      side: "right",
      width: sideWidth,
      maxHeight: Math.min(PANEL_MAX_HEIGHT, viewport.height - top - PANEL_MARGIN),
      left: regionRight + PANEL_GAP,
      top,
    };
  }

  const roomLeft = region.x - PANEL_GAP - PANEL_MARGIN;
  if (roomLeft >= PANEL_MIN_WIDTH) {
    const { width: sideWidth, top } = alongside(roomLeft);
    return {
      side: "left",
      width: sideWidth,
      maxHeight: Math.min(PANEL_MAX_HEIGHT, viewport.height - top - PANEL_MARGIN),
      right: viewport.width - (region.x - PANEL_GAP),
      top,
    };
  }

  return {
    side: "overlap",
    width,
    maxHeight: Math.max(
      0,
      Math.min(PANEL_MAX_HEIGHT, viewport.height - PANEL_MARGIN * 2),
    ),
    left: clamp(
      (viewport.width - width) / 2,
      PANEL_MARGIN,
      viewport.width - width - PANEL_MARGIN,
    ),
    bottom: PANEL_MARGIN,
  };
}

/** Keep a dragged panel's top-left corner where the whole panel stays in the
 * viewport. */
export function clampPanelPosition(
  position: { left: number; top: number },
  panel: { width: number; height: number },
  viewport: ViewportSize,
): { left: number; top: number } {
  return {
    left: clamp(position.left, PANEL_MARGIN, viewport.width - panel.width - PANEL_MARGIN),
    top: clamp(position.top, PANEL_MARGIN, viewport.height - panel.height - PANEL_MARGIN),
  };
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
