import { describe, expect, it } from "vitest";
import type { Rect } from "@/shared/types";
import {
  clampPanelPosition,
  growRect,
  PANEL_GAP,
  PANEL_MARGIN,
  PANEL_MAX_HEIGHT,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  placeLivePanel,
  rectsOverlap,
  type PanelPlacement,
} from "./live-layout";

const viewport = { width: 1280, height: 720 };

/** The box a placement describes, once it is as tall as it may get. */
function boxOf(placement: PanelPlacement): Rect {
  const height = placement.maxHeight;
  const x =
    placement.left ?? viewport.width - (placement.right ?? 0) - placement.width;
  const y =
    placement.top ?? viewport.height - (placement.bottom ?? 0) - height;
  return { x, y, width: placement.width, height };
}

describe("placeLivePanel", () => {
  it("puts the panel below a region with room under it", () => {
    const region = { x: 200, y: 100, width: 600, height: 80 };
    const placement = placeLivePanel(region, viewport);

    expect(placement.side).toBe("below");
    expect(placement.top).toBe(100 + 80 + PANEL_GAP);
    expect(placement.maxHeight).toBe(PANEL_MAX_HEIGHT);
    expect(rectsOverlap(boxOf(placement), growRect(region, 4))).toBe(false);
  });

  it("puts the panel above a region near the bottom edge", () => {
    const region = { x: 200, y: 600, width: 880, height: 80 };
    const placement = placeLivePanel(region, viewport);

    expect(placement.side).toBe("above");
    expect(placement.bottom).toBe(viewport.height - (600 - PANEL_GAP));
    expect(placement.top).toBeUndefined();
    expect(rectsOverlap(boxOf(placement), growRect(region, 4))).toBe(false);
  });

  it("limits the height to the room that is left", () => {
    const region = { x: 200, y: 100, width: 600, height: 440 };
    const placement = placeLivePanel(region, viewport);

    expect(placement.side).toBe("below");
    expect(placement.maxHeight).toBe(
      viewport.height - (540 + PANEL_GAP) - PANEL_MARGIN,
    );
  });

  it("centers the panel on the region", () => {
    const region = { x: 400, y: 100, width: 400, height: 60 };
    const placement = placeLivePanel(region, viewport);

    expect(placement.width).toBe(400);
    expect(placement.left).toBe(400);
  });

  it("keeps a panel under a wide region within the viewport", () => {
    const region = { x: 0, y: 100, width: 1280, height: 60 };
    const placement = placeLivePanel(region, viewport);

    expect(placement.width).toBe(PANEL_MAX_WIDTH);
    expect(placement.left).toBe((1280 - PANEL_MAX_WIDTH) / 2);
  });

  it("gives a narrow region a readable panel", () => {
    const region = { x: 10, y: 100, width: 80, height: 40 };
    const placement = placeLivePanel(region, viewport);

    expect(placement.width).toBe(PANEL_MIN_WIDTH);
    expect(placement.left).toBe(PANEL_MARGIN);
  });

  it("slides back inside the viewport at the right edge", () => {
    const region = { x: 1200, y: 100, width: 70, height: 40 };
    const placement = placeLivePanel(region, viewport);

    expect(placement.left).toBe(viewport.width - placement.width - PANEL_MARGIN);
  });

  it("goes beside a region that spans the viewport's height", () => {
    const region = { x: 20, y: 20, width: 500, height: 680 };
    const placement = placeLivePanel(region, viewport);

    expect(placement.side).toBe("right");
    expect(placement.left).toBe(520 + PANEL_GAP);
    expect(rectsOverlap(boxOf(placement), growRect(region, 4))).toBe(false);
  });

  it("goes to the left when only the left has room", () => {
    const region = { x: 760, y: 20, width: 500, height: 680 };
    const placement = placeLivePanel(region, viewport);

    expect(placement.side).toBe("left");
    expect(placement.right).toBe(viewport.width - (760 - PANEL_GAP));
    expect(rectsOverlap(boxOf(placement), growRect(region, 4))).toBe(false);
  });

  it("shrinks to the room beside the region", () => {
    const region = { x: 20, y: 20, width: 880, height: 680 };
    const placement = placeLivePanel(region, viewport);

    expect(placement.side).toBe("right");
    expect(placement.width).toBe(
      viewport.width - (900 + PANEL_GAP) - PANEL_MARGIN,
    );
  });

  it("falls back to the bottom edge when nothing fits", () => {
    const region = { x: 0, y: 0, width: 1280, height: 720 };
    const placement = placeLivePanel(region, viewport);

    expect(placement.side).toBe("overlap");
    expect(placement.bottom).toBe(PANEL_MARGIN);
  });

  it("never returns a negative size in a tiny viewport", () => {
    const placement = placeLivePanel(
      { x: 0, y: 0, width: 50, height: 50 },
      { width: 10, height: 10 },
    );

    expect(placement.width).toBeGreaterThanOrEqual(0);
    expect(placement.maxHeight).toBeGreaterThanOrEqual(0);
  });
});

describe("clampPanelPosition", () => {
  const panel = { width: 300, height: 120 };

  it("leaves a position inside the viewport alone", () => {
    expect(clampPanelPosition({ left: 100, top: 200 }, panel, viewport)).toEqual({
      left: 100,
      top: 200,
    });
  });

  it("pulls a panel back from every edge", () => {
    expect(clampPanelPosition({ left: -50, top: -50 }, panel, viewport)).toEqual({
      left: PANEL_MARGIN,
      top: PANEL_MARGIN,
    });
    expect(clampPanelPosition({ left: 5000, top: 5000 }, panel, viewport)).toEqual({
      left: viewport.width - panel.width - PANEL_MARGIN,
      top: viewport.height - panel.height - PANEL_MARGIN,
    });
  });
});

describe("rect helpers", () => {
  it("tells overlapping rects from touching ones", () => {
    const base = { x: 0, y: 0, width: 100, height: 50 };

    expect(rectsOverlap(base, { x: 99, y: 49, width: 10, height: 10 })).toBe(true);
    expect(rectsOverlap(base, { x: 100, y: 0, width: 10, height: 10 })).toBe(false);
    expect(rectsOverlap(base, { x: 0, y: 50, width: 10, height: 10 })).toBe(false);
  });

  it("grows a rect on every side", () => {
    expect(growRect({ x: 10, y: 20, width: 100, height: 50 }, 4)).toEqual({
      x: 6,
      y: 16,
      width: 108,
      height: 58,
    });
  });
});
