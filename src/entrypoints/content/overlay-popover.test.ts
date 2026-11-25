import { describe, expect, it } from "vitest";
import {
  isOverlayBoxActivationKey,
  popoverMaxWidth,
  popoverPlacement,
} from "./overlay-popover";

describe("isOverlayBoxActivationKey", () => {
  it.each(["Enter", " "])("accepts %j", (key) => {
    expect(isOverlayBoxActivationKey(key)).toBe(true);
  });

  it.each(["Escape", "Space", "ArrowDown"])("rejects %j", (key) => {
    expect(isOverlayBoxActivationKey(key)).toBe(false);
  });
});

describe("popoverMaxWidth", () => {
  it("widens to the box so long text wraps at the box's width", () => {
    expect(popoverMaxWidth(580, 1280)).toBe(580);
  });

  it("keeps a readable minimum for narrow boxes", () => {
    expect(popoverMaxWidth(120, 1280)).toBe(384);
  });

  it("stops widening past the comfortable line length", () => {
    expect(popoverMaxWidth(1100, 1600)).toBe(640);
  });

  it("never exceeds the viewport", () => {
    expect(popoverMaxWidth(600, 320)).toBe(304);
  });
});

describe("popoverPlacement", () => {
  const viewport = { width: 1200, height: 800 };

  // Text that takes the same area at any width.
  function place(
    box: { x: number; y: number; width: number; height: number },
    area: number,
    size = viewport,
  ) {
    return popoverPlacement({
      box,
      viewport: size,
      measure: (maxWidth) => ({ width: maxWidth, height: area / maxWidth }),
    });
  }

  it("sits flush below the box when the text fits there", () => {
    const placement = place({ x: 400, y: 100, width: 400, height: 60 }, 400 * 200);

    expect(placement).toMatchObject({ left: 400, top: 160, maxWidth: 400 });
    expect(placement.maxHeight).toBeGreaterThanOrEqual(200);
  });

  it("flips flush above when only that side fits", () => {
    const placement = place({ x: 400, y: 400, width: 400, height: 300 }, 400 * 300);

    expect(placement).toMatchObject({ left: 400, top: 100 });
    expect(placement.maxHeight).toBeGreaterThanOrEqual(300);
  });

  it("sits flush to the right when the text fits neither below nor above", () => {
    const placement = place({ x: 100, y: 200, width: 400, height: 400 }, 384 * 600);

    expect(placement).toEqual({ left: 500, top: 192, maxWidth: 384, maxHeight: 784 });
  });

  it("sits flush to the left when there is no room on the right", () => {
    const placement = place({ x: 700, y: 100, width: 400, height: 500 }, 384 * 600);

    expect(placement).toMatchObject({ left: 700 - 384, top: 100, maxWidth: 384 });
  });

  it("stays below or above when the room beside the box is too narrow", () => {
    // 380 px on both sides.
    const placement = place({ x: 388, y: 60, width: 424, height: 400 }, 640 * 700);

    expect(placement).toMatchObject({ top: 460, maxWidth: 424, maxHeight: 332 });
  });

  it("takes the place that shows the most when none shows everything", () => {
    const placement = place({ x: 100, y: 200, width: 400, height: 400 }, 384 * 2000);

    expect(placement).toEqual({ left: 500, top: 8, maxWidth: 384, maxHeight: 784 });
  });

  it("caps a tall text below the box", () => {
    const placement = place({ x: 150, y: 20, width: 900, height: 20 }, 640 * 700);

    expect(placement).toMatchObject({ top: 40, maxHeight: 480 });
  });

  it("covers part of the box when no place has enough room", () => {
    const placement = place({ x: 100, y: 40, width: 1000, height: 700 }, 640 * 700);

    expect(placement.maxHeight).toBe(320);
    expect(placement.top).toBe(800 - 320 - 8);
  });

  it("does not cover the box more than the text needs", () => {
    const placement = place({ x: 100, y: 40, width: 1000, height: 700 }, 640 * 200);

    expect(placement.top).toBe(800 - 200 - 8);
  });

  it("stays on a small screen", () => {
    const size = { width: 360, height: 300 };
    const placement = place({ x: 0, y: 0, width: 360, height: 300 }, 344 * 700, size);

    expect(placement).toEqual({ left: 8, top: 112, maxWidth: 344, maxHeight: 180 });
  });
});
