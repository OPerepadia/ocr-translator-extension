import { describe, expect, it } from "vitest";
import { extractBoxes, unclip, type DbConfig } from "./db-postprocess";
import { polygonArea, type Quad } from "./geometry";

const cfg: DbConfig = {
  threshold: 0.2,
  boxThreshold: 0.45,
  unclipRatio: 1.4,
  minBoxSize: 3,
  padding: 0,
};

/** Build a w*h probability map with a filled rectangle of `value`. */
function mapWithRect(
  w: number,
  h: number,
  rect: { x: number; y: number; width: number; height: number },
  value: number,
): Float32Array {
  const map = new Float32Array(w * h);
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      map[y * w + x] = value;
    }
  }
  return map;
}

describe("extractBoxes", () => {
  it("finds a single high-probability rectangle", () => {
    const map = mapWithRect(64, 64, { x: 16, y: 24, width: 24, height: 12 }, 1);
    const boxes = extractBoxes(map, 64, 64, cfg, 1, 1, 64, 64);

    expect(boxes).toHaveLength(1);
    const box = boxes[0];
    expect(box.score).toBeCloseTo(1, 2);
    // After unclip the box is slightly larger than the source rectangle.
    expect(box.bbox.x).toBeLessThanOrEqual(16);
    expect(box.bbox.y).toBeLessThanOrEqual(24);
    expect(box.bbox.x + box.bbox.width).toBeGreaterThanOrEqual(40);
    expect(box.bbox.y + box.bbox.height).toBeGreaterThanOrEqual(36);
  });

  it("filters regions below the box threshold", () => {
    const map = mapWithRect(64, 64, { x: 16, y: 24, width: 24, height: 12 }, 0.3);
    // 0.3 passes binarization (>0.2) but mean score 0.3 < boxThreshold 0.45.
    const boxes = extractBoxes(map, 64, 64, cfg, 1, 1, 64, 64);
    expect(boxes).toHaveLength(0);
  });

  it("filters regions below the binarization threshold entirely", () => {
    const map = mapWithRect(64, 64, { x: 16, y: 24, width: 24, height: 12 }, 0.1);
    const boxes = extractBoxes(map, 64, 64, cfg, 1, 1, 64, 64);
    expect(boxes).toHaveLength(0);
  });

  it("filters tiny blobs by minBoxSize", () => {
    const map = mapWithRect(64, 64, { x: 30, y: 30, width: 2, height: 2 }, 1);
    const boxes = extractBoxes(map, 64, 64, cfg, 1, 1, 64, 64);
    expect(boxes).toHaveLength(0);
  });

  it("maps boxes back to original coordinates via scale factors", () => {
    const map = mapWithRect(64, 64, { x: 16, y: 24, width: 24, height: 12 }, 1);
    const boxes = extractBoxes(map, 64, 64, cfg, 2, 3, 128, 192);
    expect(boxes).toHaveLength(1);
    // x scaled by 2, y by 3.
    expect(boxes[0].bbox.x).toBeLessThanOrEqual(32);
    expect(boxes[0].bbox.y).toBeLessThanOrEqual(72);
  });
});

describe("unclip", () => {
  it("expands a quad outward", () => {
    const quad: Quad = [
      { x: 10, y: 10 },
      { x: 30, y: 10 },
      { x: 30, y: 20 },
      { x: 10, y: 20 },
    ];
    const expanded = unclip(quad, 1.4);
    expect(polygonArea(expanded)).toBeGreaterThan(polygonArea(quad));
  });
});
