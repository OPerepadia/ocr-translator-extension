import { describe, expect, it } from "vitest";
import {
  isOverlayBoxActivationKey,
  popoverMaxWidth,
  popoverVerticalPlacement,
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

describe("popoverVerticalPlacement", () => {
  const viewportHeight = 800;

  it("sits flush below the box when the text fits there", () => {
    const placement = popoverVerticalPlacement({
      boxY: 100,
      boxHeight: 60,
      height: 200,
      viewportHeight,
    });

    expect(placement.top).toBe(160);
    expect(placement.maxHeight).toBeGreaterThanOrEqual(200);
  });

  it("flips flush above when only that side fits", () => {
    const placement = popoverVerticalPlacement({
      boxY: 400,
      boxHeight: 300,
      height: 300,
      viewportHeight,
    });

    expect(placement.top).toBe(100);
    expect(placement.top + 300).toBe(400);
    expect(placement.maxHeight).toBeGreaterThanOrEqual(300);
  });

  it("caps the height and scrolls when neither side fits", () => {
    const placement = popoverVerticalPlacement({
      boxY: 200,
      boxHeight: 100,
      height: 900,
      viewportHeight,
    });

    expect(placement.maxHeight).toBe(480);
    expect(placement.top).toBe(300);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(
      viewportHeight,
    );
  });

  it("caps a tall text even where there is room for all of it", () => {
    const placement = popoverVerticalPlacement({
      boxY: 20,
      boxHeight: 20,
      height: 700,
      viewportHeight,
    });

    expect(placement.maxHeight).toBe(480);
  });

  it("keeps a usable popover on screen when the box leaves no room", () => {
    const placement = popoverVerticalPlacement({
      boxY: 0,
      boxHeight: viewportHeight,
      height: 400,
      viewportHeight,
    });

    expect(placement.maxHeight).toBe(120);
    expect(placement.top).toBe(viewportHeight - 120 - 8);
  });
});
