import { describe, expect, it } from "vitest";
import {
  aabbOfPoints,
  convexHull,
  lineIntersection,
  minAreaRect,
  pointInConvexPolygon,
  polygonArea,
  polygonPerimeter,
  type Point,
} from "./geometry";

describe("convexHull", () => {
  it("drops interior points", () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
      { x: 2, y: 2 }, // interior
    ];
    const hull = convexHull(points);
    expect(hull).toHaveLength(4);
    expect(hull).not.toContainEqual({ x: 2, y: 2 });
  });
});

describe("minAreaRect", () => {
  it("fits an axis-aligned rectangle tightly", () => {
    const rect = minAreaRect([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 0, y: 4 },
    ]);
    const dims = [rect.width, rect.height].sort((a, b) => a - b);
    expect(dims[0]).toBeCloseTo(4, 5);
    expect(dims[1]).toBeCloseTo(10, 5);
    expect(rect.center.x).toBeCloseTo(5, 5);
    expect(rect.center.y).toBeCloseTo(2, 5);
  });

  it("fits a 45-degree rotated square", () => {
    // Diamond with diagonal 2*sqrt(2): corners give a side of length 2.
    const rect = minAreaRect([
      { x: 0, y: -2 },
      { x: 2, y: 0 },
      { x: 0, y: 2 },
      { x: -2, y: 0 },
    ]);
    expect(rect.width).toBeCloseTo(Math.hypot(2, 2), 4);
    expect(rect.height).toBeCloseTo(Math.hypot(2, 2), 4);
    expect(rect.center.x).toBeCloseTo(0, 4);
    expect(rect.center.y).toBeCloseTo(0, 4);
  });
});

describe("polygon measures", () => {
  const square: Point[] = [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 2 },
    { x: 0, y: 2 },
  ];

  it("computes area", () => {
    expect(polygonArea(square)).toBeCloseTo(4, 5);
  });

  it("computes perimeter", () => {
    expect(polygonPerimeter(square)).toBeCloseTo(8, 5);
  });
});

describe("lineIntersection", () => {
  it("intersects two crossing lines", () => {
    const p = lineIntersection(
      { x: 0, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
      { x: 2, y: 0 },
    );
    expect(p).not.toBeNull();
    expect(p?.x).toBeCloseTo(1, 5);
    expect(p?.y).toBeCloseTo(1, 5);
  });

  it("returns null for parallel lines", () => {
    const p = lineIntersection(
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 1 },
      { x: 2, y: 1 },
    );
    expect(p).toBeNull();
  });
});

describe("pointInConvexPolygon", () => {
  const quad: Point[] = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
    { x: 0, y: 4 },
  ];

  it("accepts an interior point", () => {
    expect(pointInConvexPolygon({ x: 2, y: 2 }, quad)).toBe(true);
  });

  it("rejects an exterior point", () => {
    expect(pointInConvexPolygon({ x: 5, y: 2 }, quad)).toBe(false);
  });
});

describe("aabbOfPoints", () => {
  it("bounds a point set", () => {
    expect(
      aabbOfPoints([
        { x: 1, y: 2 },
        { x: -3, y: 5 },
        { x: 4, y: -1 },
      ]),
    ).toEqual({ minX: -3, minY: -1, maxX: 4, maxY: 5 });
  });
});
