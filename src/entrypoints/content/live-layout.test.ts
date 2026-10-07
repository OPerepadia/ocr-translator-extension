import { describe, expect, it } from "vitest";
import type { Rect } from "@/shared/types";
import {
  clampPanelBox,
  growRect,
  PANEL_GAP,
  PANEL_HEIGHT,
  PANEL_MARGIN,
  PANEL_MIN_HEIGHT,
  PANEL_MIN_WIDTH,
  PANEL_WIDTH,
  placeLivePanel,
  rectsOverlap,
  resizePanelBox,
  type PanelBox,
} from "./live-layout";

const viewport = { width: 1280, height: 720 };

const rectOf = (box: PanelBox): Rect => ({
  x: box.left,
  y: box.top,
  width: box.width,
  height: box.height,
});

describe("placeLivePanel", () => {
  it("puts a panel of the default size below a region with room under it", () => {
    const region = { x: 200, y: 100, width: 600, height: 80 };
    const placement = placeLivePanel(region, viewport);

    expect(placement.side).toBe("below");
    expect(placement.top).toBe(100 + 80 + PANEL_GAP);
    expect(placement.width).toBe(PANEL_WIDTH);
    expect(placement.height).toBe(PANEL_HEIGHT);
    expect(rectsOverlap(rectOf(placement), growRect(region, 4))).toBe(false);
  });

  it("puts the panel above a region near the bottom edge", () => {
    const region = { x: 200, y: 600, width: 880, height: 80 };
    const placement = placeLivePanel(region, viewport);

    expect(placement.side).toBe("above");
    expect(placement.top + placement.height).toBe(600 - PANEL_GAP);
    expect(rectsOverlap(rectOf(placement), growRect(region, 4))).toBe(false);
  });

  it("limits the height to the room that is left", () => {
    const region = { x: 200, y: 100, width: 600, height: 440 };
    const placement = placeLivePanel(region, viewport);

    expect(placement.side).toBe("below");
    expect(placement.height).toBe(
      viewport.height - (540 + PANEL_GAP) - PANEL_MARGIN,
    );
  });

  it("centers the panel on the region", () => {
    const region = { x: 400, y: 100, width: 400, height: 60 };
    const placement = placeLivePanel(region, viewport);

    expect(placement.left).toBe(600 - PANEL_WIDTH / 2);
  });

  it("keeps the default width under a wide region", () => {
    const region = { x: 0, y: 100, width: 1280, height: 60 };
    const placement = placeLivePanel(region, viewport);

    expect(placement.width).toBe(PANEL_WIDTH);
    expect(placement.left).toBe((1280 - PANEL_WIDTH) / 2);
  });

  it("keeps the panel inside the viewport at the left edge", () => {
    const region = { x: 10, y: 100, width: 80, height: 40 };
    const placement = placeLivePanel(region, viewport);

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
    expect(placement.top).toBe(20);
    expect(rectsOverlap(rectOf(placement), growRect(region, 4))).toBe(false);
  });

  it("goes to the left when only the left has room", () => {
    const region = { x: 760, y: 20, width: 500, height: 680 };
    const placement = placeLivePanel(region, viewport);

    expect(placement.side).toBe("left");
    expect(placement.left + placement.width).toBe(760 - PANEL_GAP);
    expect(rectsOverlap(rectOf(placement), growRect(region, 4))).toBe(false);
  });

  it("shrinks to the room beside the region", () => {
    const region = { x: 20, y: 20, width: 980, height: 680 };
    const placement = placeLivePanel(region, viewport);

    expect(placement.side).toBe("right");
    expect(placement.width).toBe(
      viewport.width - (1000 + PANEL_GAP) - PANEL_MARGIN,
    );
    expect(placement.width).toBeLessThan(PANEL_WIDTH);
  });

  it("falls back to the top edge, away from subtitles, when nothing fits", () => {
    const region = { x: 0, y: 0, width: 1280, height: 720 };
    const placement = placeLivePanel(region, viewport);

    expect(placement.side).toBe("overlap");
    expect(placement.top).toBe(PANEL_MARGIN);
  });

  it("never returns a negative size in a tiny viewport", () => {
    const placement = placeLivePanel(
      { x: 0, y: 0, width: 50, height: 50 },
      { width: 10, height: 10 },
    );

    expect(placement.width).toBeGreaterThanOrEqual(0);
    expect(placement.height).toBeGreaterThanOrEqual(0);
  });
});

describe("clampPanelBox", () => {
  const box = { left: 100, top: 200, width: 300, height: 120 };

  it("leaves a box inside the viewport alone", () => {
    expect(clampPanelBox(box, viewport)).toEqual(box);
  });

  it("pulls a box back from every edge", () => {
    expect(clampPanelBox({ ...box, left: -50, top: -50 }, viewport)).toEqual({
      ...box,
      left: PANEL_MARGIN,
      top: PANEL_MARGIN,
    });
    expect(clampPanelBox({ ...box, left: 5000, top: 5000 }, viewport)).toEqual({
      ...box,
      left: viewport.width - box.width - PANEL_MARGIN,
      top: viewport.height - box.height - PANEL_MARGIN,
    });
  });

  it("shrinks a box larger than the viewport", () => {
    expect(
      clampPanelBox({ left: 0, top: 0, width: 5000, height: 5000 }, viewport),
    ).toEqual({
      left: PANEL_MARGIN,
      top: PANEL_MARGIN,
      width: viewport.width - PANEL_MARGIN * 2,
      height: viewport.height - PANEL_MARGIN * 2,
    });
  });
});

describe("resizePanelBox", () => {
  const box = { left: 100, top: 200, width: 300, height: 120 };

  it("moves the bottom right corner and keeps the top left one", () => {
    expect(resizePanelBox(box, 700, 400, viewport)).toEqual({
      ...box,
      width: 700,
      height: 400,
    });
  });

  it("does not shrink below the minimum", () => {
    expect(resizePanelBox(box, 10, 10, viewport)).toEqual({
      ...box,
      width: PANEL_MIN_WIDTH,
      height: PANEL_MIN_HEIGHT,
    });
  });

  it("stops at the viewport's edges", () => {
    expect(resizePanelBox(box, 5000, 5000, viewport)).toEqual({
      ...box,
      width: viewport.width - 100 - PANEL_MARGIN,
      height: viewport.height - 200 - PANEL_MARGIN,
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
