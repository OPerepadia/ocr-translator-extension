import { describe, expect, it } from "vitest";
import { charBoxes } from "./char-boxes";
import type { Quad } from "./geometry";

// A 100x20 line, upright, at the origin.
const line: Quad = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 20 },
  { x: 0, y: 20 },
];

describe("charBoxes", () => {
  it("splits the line at the midpoints between CTC peaks", () => {
    // Four peaks spread evenly across 40 timesteps -> centres at 13.75%,
    // 38.75%, 63.75% and 88.75% of the line.
    const boxes = charBoxes({
      chars: [
        { char: "a", start: 5, end: 6 },
        { char: "b", start: 15, end: 16 },
        { char: "c", start: 25, end: 26 },
        { char: "d", start: 35, end: 36 },
      ],
      timeSteps: 40,
      quad: line,
      padding: 0,
      rotated: false,
    });

    expect(boxes.map((box) => box.text)).toEqual(["a", "b", "c", "d"]);
    // Outer edges run to the ends of the line; inner ones split the peaks.
    expect(boxes.map((box) => Math.round(box.bbox.x))).toEqual([0, 26, 51, 76]);
    expect(boxes.map((box) => Math.round(box.bbox.width))).toEqual([
      26, 25, 25, 24,
    ]);
    // Every box spans the line's full height.
    expect(boxes.every((box) => box.bbox.y === 0 && box.bbox.height === 20)).toBe(
      true,
    );
  });

  it("widens a character that won a run of timesteps", () => {
    const boxes = charBoxes({
      chars: [
        { char: "w", start: 0, end: 10 },
        { char: "i", start: 18, end: 19 },
      ],
      timeSteps: 20,
      quad: line,
      padding: 0,
      rotated: false,
    });

    // Centres at 25% and 92.5%; the split lands between them.
    expect(Math.round(boxes[0].bbox.width)).toBe(59);
    expect(Math.round(boxes[1].bbox.x)).toBe(59);
  });

  it("maps fractions back off the padded crop the recognizer saw", () => {
    // The crop was padded by 10px on each side, so the recognizer's midpoint is
    // the line's midpoint, but its edges sit outside the text.
    const boxes = charBoxes({
      chars: [
        { char: "a", start: 10, end: 11 },
        { char: "b", start: 29, end: 30 },
      ],
      timeSteps: 40,
      quad: line,
      padding: 10,
      rotated: false,
    });

    // The peaks sit at 31.5px and 88.5px of the 120px padded crop, i.e. 21.5%
    // and 78.5% along the 100px line, so they split it down the middle.
    expect(Math.round(boxes[0].bbox.width)).toBe(50);
    expect(Math.round(boxes[1].bbox.x)).toBe(50);
  });

  it("reads down the quad for a rotated (vertical) line", () => {
    const column: Quad = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 100 },
      { x: 0, y: 100 },
    ];
    const boxes = charBoxes({
      chars: [
        { char: "上", start: 5, end: 6 },
        { char: "下", start: 15, end: 16 },
      ],
      timeSteps: 20,
      quad: column,
      padding: 0,
      rotated: true,
    });

    expect(boxes.map((box) => Math.round(box.bbox.y))).toEqual([0, 53]);
    expect(boxes.every((box) => box.bbox.x === 0 && box.bbox.width === 20)).toBe(
      true,
    );
  });

  it("gives each character a box that follows a tilted line", () => {
    // The same 100x20 line, turned 20 degrees about its centre.
    const angle = (20 * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const tilted = ([
      [-50, -10],
      [50, -10],
      [50, 10],
      [-50, 10],
    ] as const).map(([dx, dy]) => ({
      x: 50 + dx * cos - dy * sin,
      y: 10 + dx * sin + dy * cos,
    })) as Quad;

    const boxes = charBoxes({
      chars: [
        { char: "a", start: 5, end: 6 },
        { char: "b", start: 15, end: 16 },
        { char: "c", start: 25, end: 26 },
        { char: "d", start: 35, end: 36 },
      ],
      timeSteps: 40,
      quad: tilted,
      padding: 0,
      rotated: false,
    });

    for (const box of boxes) {
      // Every slice carries the line's tilt and its full thickness, where the
      // axis-aligned box had to grow well past the glyph to hold the same slice.
      expect((box.oriented!.angle * 180) / Math.PI).toBeCloseTo(20, 3);
      expect(box.oriented!.rect.height).toBeCloseTo(20, 3);
      expect(box.oriented!.rect.width).toBeLessThan(box.bbox.width);
    }
    // The slices still run the length of the line, in order.
    const widths = boxes.map((box) => box.oriented!.rect.width);
    expect(widths.reduce((sum, w) => sum + w, 0)).toBeCloseTo(100, 3);
  });

  it("keeps the tilted slices of a vertical column running down it", () => {
    const angle = (-10 * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const column = ([
      [-10, -50],
      [10, -50],
      [10, 50],
      [-10, 50],
    ] as const).map(([dx, dy]) => ({
      x: 10 + dx * cos - dy * sin,
      y: 50 + dx * sin + dy * cos,
    })) as Quad;

    const boxes = charBoxes({
      chars: [
        { char: "x", start: 5, end: 6 },
        { char: "y", start: 15, end: 16 },
      ],
      timeSteps: 20,
      quad: column,
      padding: 0,
      rotated: true,
    });

    for (const box of boxes) {
      expect((box.oriented!.angle * 180) / Math.PI).toBeCloseTo(-10, 3);
      // Across the column is its thickness; along it, the slice.
      expect(box.oriented!.rect.width).toBeCloseTo(20, 3);
    }
    // Slices go down the column, so the second starts below the first.
    expect(boxes[1].oriented!.rect.y).toBeGreaterThan(boxes[0].oriented!.rect.y);
  });

  it("returns nothing without characters or timesteps", () => {
    expect(
      charBoxes({ chars: [], timeSteps: 40, quad: line, padding: 0, rotated: false }),
    ).toEqual([]);
    expect(
      charBoxes({
        chars: [{ char: "a", start: 0, end: 1 }],
        timeSteps: 0,
        quad: line,
        padding: 0,
        rotated: false,
      }),
    ).toEqual([]);
  });
});
