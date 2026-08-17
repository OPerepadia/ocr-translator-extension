import { describe, expect, it } from "vitest";
import type { RecognizedLine } from "./assemble";
import {
  decodeTextRegions,
  groupLinesByRegions,
  imageToNchw,
  suppressOverlaps,
} from "./region-grouper";

function line(x: number, y: number): RecognizedLine {
  return {
    text: "sample",
    bbox: { x, y, width: 10, height: 20 },
    confidence: 1,
  };
}

function region(
  x: number,
  y: number,
  width: number,
  height: number,
  confidence = 1,
) {
  return { bbox: { x, y, width, height }, confidence };
}

describe("text-region grouping", () => {
  it("resizes an RGBA image into normalized planar RGB", () => {
    const input = imageToNchw(
      {
        width: 2,
        height: 1,
        data: new Uint8ClampedArray([
          255, 0, 0, 255,
          0, 0, 255, 255,
        ]),
      },
      2,
      1,
    );

    expect([...input]).toEqual([1, 0, 0, 0, 0, 1]);
  });

  it("keeps text classes, clips boxes, and removes cross-class duplicates", () => {
    const regions = decodeTextRegions(
      BigInt64Array.from([0n, 1n, 2n, 2n]),
      new Float32Array([
        0, 0, 100, 100,
        10, 10, 90, 90,
        10, 10, 90, 90,
        -10, -10, 30, 40,
      ]),
      new Float32Array([0.99, 0.8, 0.7, 0.3]),
      100,
      100,
      [1, 2],
      0.4,
      0.85,
    );

    expect(regions).toEqual([
      region(10, 10, 80, 80, expect.closeTo(0.8)),
    ]);
  });

  it("suppresses only strongly overlapping regions", () => {
    const first = region(0, 0, 100, 100, 0.9);
    const duplicate = region(2, 2, 98, 98, 0.8);
    const neighbor = region(80, 0, 100, 100, 0.7);

    expect(suppressOverlaps([duplicate, neighbor, first], 0.85)).toEqual([
      first,
      neighbor,
    ]);
  });

  it("assigns lines to regions and leaves uncovered lines as singletons", () => {
    const first = line(10, 10);
    const second = line(30, 10);
    const third = line(210, 10);
    const uncovered = line(400, 10);
    const result = groupLinesByRegions(
      [first, second, third, uncovered],
      [region(0, 0, 100, 100), region(200, 0, 100, 100)],
    );

    expect(result).toEqual({
      groups: [[first, second], [third], [uncovered]],
      matchedLineCount: 3,
    });
  });

  it("prefers the smallest containing region when containment ties", () => {
    const recognized = line(25, 25);
    const result = groupLinesByRegions(
      [recognized],
      [region(0, 0, 100, 100), region(20, 20, 30, 40)],
    );

    expect(result.groups).toEqual([[recognized]]);
    expect(result.matchedLineCount).toBe(1);
  });

  it("does not group residual lines through a region enclosing multiple smaller regions", () => {
    const first = line(10, 10);
    const second = line(110, 10);
    const residualFirst = line(10, 150);
    const residualSecond = line(110, 150);
    const result = groupLinesByRegions(
      [first, second, residualFirst, residualSecond],
      [
        region(0, 0, 200, 200),
        region(0, 0, 80, 80),
        region(100, 0, 80, 80),
      ],
    );

    expect(result.groups).toEqual([
      [first],
      [second],
      [residualFirst],
      [residualSecond],
    ]);
    expect(result.matchedLineCount).toBe(2);
  });

  it("keeps a region that encloses only one smaller region", () => {
    const nested = line(10, 10);
    const residualFirst = line(10, 150);
    const residualSecond = line(110, 150);
    const result = groupLinesByRegions(
      [nested, residualFirst, residualSecond],
      [region(0, 0, 200, 200), region(0, 0, 80, 80)],
    );

    expect(result.groups).toEqual([
      [residualFirst, residualSecond],
      [nested],
    ]);
    expect(result.matchedLineCount).toBe(3);
  });
});
