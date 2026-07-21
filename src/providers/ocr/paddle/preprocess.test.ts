import { describe, expect, it } from "vitest";
import {
  computeDetSize,
  computeRecWidth,
  imageDataToNchw,
} from "./preprocess";

describe("computeDetSize", () => {
  it("rounds both dimensions to a multiple of 32", () => {
    const size = computeDetSize(100, 50, 960);
    expect(size.targetW % 32).toBe(0);
    expect(size.targetH % 32).toBe(0);
  });

  it("downscales so the longest side is within maxSide", () => {
    const size = computeDetSize(2000, 1000, 960);
    expect(Math.max(size.targetW, size.targetH)).toBeLessThanOrEqual(960);
  });

  it("provides scale factors mapping detector space back to original", () => {
    const size = computeDetSize(640, 320, 960);
    expect(size.scaleX).toBeCloseTo(640 / size.targetW, 6);
    expect(size.scaleY).toBeCloseTo(320 / size.targetH, 6);
  });

  it("never goes below 32", () => {
    const size = computeDetSize(10, 10, 960);
    expect(size.targetW).toBe(32);
    expect(size.targetH).toBe(32);
  });
});

describe("computeRecWidth", () => {
  it("keeps aspect ratio at the target height", () => {
    expect(computeRecWidth(160, 48, 48, 48, 320)).toBe(160);
  });

  it("clamps to the maximum width", () => {
    expect(computeRecWidth(2000, 48, 48, 48, 320)).toBe(320);
  });

  it("clamps to the minimum width", () => {
    expect(computeRecWidth(10, 48, 48, 48, 320)).toBe(48);
  });
});

describe("imageDataToNchw", () => {
  it("produces planar RGB with normalization", () => {
    // 2x1 image: pixel0 = (255,0,0,255), pixel1 = (0,255,0,255).
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
    const out = imageDataToNchw(rgba, 2, 1, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);

    // Layout [1,3,1,2]: R-plane (idx 0,1), G-plane (2,3), B-plane (4,5).
    expect(out[0]).toBeCloseTo((1 - 0.5) / 0.5, 5); // pixel0 R = 1
    expect(out[1]).toBeCloseTo((0 - 0.5) / 0.5, 5); // pixel1 R = 0
    expect(out[2]).toBeCloseTo((0 - 0.5) / 0.5, 5); // pixel0 G = 0
    expect(out[3]).toBeCloseTo((1 - 0.5) / 0.5, 5); // pixel1 G = 1
    expect(out[4]).toBeCloseTo((0 - 0.5) / 0.5, 5); // pixel0 B = 0
    expect(out[5]).toBeCloseTo((0 - 0.5) / 0.5, 5); // pixel1 B = 0
  });
});
