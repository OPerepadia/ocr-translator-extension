import { describe, expect, it } from "vitest";
import { rotate90CounterClockwise } from "./crop";
import type { DetectedBox } from "./db-postprocess";
import {
  readingScore,
  regionCrop,
  regionOf,
  toPageBox,
} from "./rotated-regions";

describe("regionCrop", () => {
  it("adds a tenth of the longer side around the region", () => {
    expect(
      regionCrop({ x: 100, y: 100, width: 60, height: 200 }, { width: 1000, height: 1000 }),
    ).toEqual({ x: 80, y: 80, width: 100, height: 240 });
  });

  it("keeps at least a few pixels around a small region", () => {
    expect(
      regionCrop({ x: 50, y: 50, width: 20, height: 30 }, { width: 1000, height: 1000 }),
    ).toEqual({ x: 42, y: 42, width: 36, height: 46 });
  });

  it("stays inside the image", () => {
    expect(
      regionCrop({ x: 5, y: 950, width: 60, height: 90 }, { width: 100, height: 1000 }),
    ).toEqual({ x: 0, y: 941, width: 74, height: 59 });
  });
});

describe("toPageBox", () => {
  const crop = { x: 100, y: 50, width: 40, height: 80 };

  function box(x: number, y: number, width: number, height: number): DetectedBox {
    return {
      quad: [
        { x, y },
        { x: x + width, y },
        { x: x + width, y: y + height },
        { x, y: y + height },
      ],
      bbox: { x, y, width, height },
      score: 0.9,
    };
  }

  it("turns a line across the turned crop into a column on the page", () => {
    const page = toPageBox(box(10, 5, 60, 12), crop);
    expect(page.bbox).toEqual({ x: 123, y: 60, width: 12, height: 60 });
    expect(page.quad).toEqual([
      { x: 135, y: 60 },
      { x: 135, y: 120 },
      { x: 123, y: 120 },
      { x: 123, y: 60 },
    ]);
    expect(page.readsDown).toBe(true);
  });

  it("leaves a line that runs down the turned crop reading across", () => {
    expect(toPageBox(box(10, 2, 12, 36), crop).readsDown).toBe(false);
  });

  it("undoes rotate90CounterClockwise", () => {
    const width = 5;
    const height = 3;
    const data = new Uint8ClampedArray(width * height * 4);
    data[(2 * width + 1) * 4] = 255; // the pixel at (1, 2)
    const turned = rotate90CounterClockwise({ data, width, height });
    const at = turned.data.findIndex((value) => value === 255) / 4;
    const u = at % turned.width;
    const v = (at - u) / turned.width;

    const page = toPageBox(box(u, v, 1, 1), { x: 0, y: 0, width, height });
    expect(page.bbox).toEqual({ x: 1, y: 2, width: 1, height: 1 });
  });
});

describe("regionOf", () => {
  const regions = [
    { bbox: { x: 0, y: 0, width: 100, height: 100 } },
    { bbox: { x: 40, y: 40, width: 30, height: 30 } },
  ];

  it("picks the smallest region holding the line's center", () => {
    expect(regionOf({ x: 45, y: 45, width: 10, height: 10 }, regions)).toBe(1);
    expect(regionOf({ x: 5, y: 5, width: 10, height: 10 }, regions)).toBe(0);
  });

  it("returns -1 for a line outside every region", () => {
    expect(regionOf({ x: 150, y: 5, width: 10, height: 10 }, regions)).toBe(-1);
  });
});

describe("readingScore", () => {
  const line = (text: string, confidence: number) => ({
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    text,
    confidence,
  });

  it("weighs each character by the line's confidence", () => {
    expect(readingScore([line("abcd", 0.9), line("ef", 0.8)])).toBeCloseTo(5.2);
  });

  it("leaves out lines too uncertain to be shown", () => {
    expect(readingScore([line("abcdefgh", 0.3)])).toBe(0);
  });
});
