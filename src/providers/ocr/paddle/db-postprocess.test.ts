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

describe("extractBoxes with splitThreshold", () => {
  const split: DbConfig = { ...cfg, threshold: 0.15, boxThreshold: 0.25, splitThreshold: 0.5 };

  /** Two filled columns joined by a weak bridge, so they merge at 0.15. */
  function twoColumns(): Float32Array {
    const map = mapWithRect(64, 64, { x: 20, y: 10, width: 8, height: 40 }, 1);
    const right = mapWithRect(64, 64, { x: 30, y: 10, width: 8, height: 20 }, 1);
    right.forEach((v, i) => {
      if (v > map[i]) map[i] = v;
    });
    for (let y = 10; y < 50; y++) {
      map[y * 64 + 28] = 0.3;
      map[y * 64 + 29] = 0.3;
    }
    return map;
  }

  it("keeps a bridged pair of columns as one box without the option", () => {
    const boxes = extractBoxes(twoColumns(), 64, 64, { ...split, splitThreshold: undefined }, 1, 1, 64, 64);
    expect(boxes).toHaveLength(1);
  });

  it("splits the pair into one box per column", () => {
    const boxes = extractBoxes(twoColumns(), 64, 64, split, 1, 1, 64, 64);
    expect(boxes).toHaveLength(2);
    for (const { bbox } of boxes) {
      expect(bbox.width).toBeLessThan(18);
    }
  });

  it("splits stacked rows of horizontal text", () => {
    const map = new Float32Array(64 * 64);
    for (let x = 10; x < 50; x++) {
      for (let y = 20; y < 28; y++) map[y * 64 + x] = 1;
      for (let y = 32; y < 40; y++) map[y * 64 + x] = 1;
      for (let y = 28; y < 32; y++) map[y * 64 + x] = 0.3;
    }
    expect(extractBoxes(map, 64, 64, split, 1, 1, 64, 64)).toHaveLength(2);
  });

  it("does not split a line that breaks between glyphs", () => {
    const map = new Float32Array(64 * 64);
    for (let x = 10; x < 54; x++) {
      const strong = x < 28 || x >= 32;
      for (let y = 28; y < 36; y++) map[y * 64 + x] = strong ? 1 : 0.3;
    }
    expect(extractBoxes(map, 64, 64, split, 1, 1, 64, 64)).toHaveLength(1);
  });

  it("keeps the blob whole when the split parts would be filtered out", () => {
    const map = mapWithRect(64, 64, { x: 20, y: 10, width: 18, height: 40 }, 0.3);
    for (let y = 10; y < 50; y++) {
      for (const x of [22, 23, 34, 35]) map[y * 64 + x] = 0.9;
    }
    const boxes = extractBoxes(map, 64, 64, split, 1, 1, 64, 64);
    expect(boxes).toHaveLength(1);
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
