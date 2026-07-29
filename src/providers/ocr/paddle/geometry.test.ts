import { describe, expect, it } from "vitest";
import {
  aabbOfPoints,
  convexHull,
  lineIntersection,
  minAreaRect,
  orientedRectOfQuad,
  pointInConvexPolygon,
  polygonArea,
  polygonPerimeter,
  type Point,
  type Quad,
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

describe("orientedRectOfQuad", () => {
  /** A `width` x `height` box centred on (cx, cy), turned by `angle` radians. */
  function tilted(
    cx: number,
    cy: number,
    width: number,
    height: number,
    angle: number,
  ): Quad {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [
      [-width / 2, -height / 2],
      [width / 2, -height / 2],
      [width / 2, height / 2],
      [-width / 2, height / 2],
    ].map(([dx, dy]) => ({
      x: cx + dx * cos - dy * sin,
      y: cy + dx * sin + dy * cos,
    })) as Quad;
  }

  it("leaves an upright quad untilted", () => {
    const oriented = orientedRectOfQuad([
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      { x: 110, y: 50 },
      { x: 10, y: 50 },
    ]);
    expect(oriented.angle).toBeCloseTo(0, 6);
    expect(oriented.rect.x).toBeCloseTo(10, 6);
    expect(oriented.rect.y).toBeCloseTo(20, 6);
    expect(oriented.rect.width).toBeCloseTo(100, 6);
    expect(oriented.rect.height).toBeCloseTo(30, 6);
  });

  it("recovers the tilt and the snug size of a turned line", () => {
    const angle = (15 * Math.PI) / 180;
    const oriented = orientedRectOfQuad(tilted(200, 100, 250, 30, angle));
    expect(oriented.angle).toBeCloseTo(angle, 4);
    expect(oriented.rect.width).toBeCloseTo(250, 3);
    expect(oriented.rect.height).toBeCloseTo(30, 3);
    // Positioned by its centre, which the rotation leaves where it is.
    expect(oriented.rect.x + oriented.rect.width / 2).toBeCloseTo(200, 4);
    expect(oriented.rect.y + oriented.rect.height / 2).toBeCloseTo(100, 4);
  });

  it("keeps the tilt signed, so the two directions stay apart", () => {
    const angle = (-12 * Math.PI) / 180;
    const oriented = orientedRectOfQuad(tilted(0, 0, 120, 20, angle));
    expect(oriented.angle).toBeCloseTo(angle, 4);
  });

  it("folds a past-quarter-turn frame back onto upright", () => {
    // A line turned 70 degrees: measured the other way round it is a tall box
    // turned -20, which is the frame the rect's width and height belong to.
    const oriented = orientedRectOfQuad(
      tilted(50, 50, 200, 40, (70 * Math.PI) / 180),
    );
    expect((oriented.angle * 180) / Math.PI).toBeCloseTo(-20, 3);
    expect(oriented.rect.width).toBeCloseTo(40, 3);
    expect(oriented.rect.height).toBeCloseTo(200, 3);
  });

  it("bounds a tall column the same way a vertical line reads", () => {
    const angle = (8 * Math.PI) / 180;
    const oriented = orientedRectOfQuad(tilted(0, 0, 24, 300, angle));
    expect(oriented.angle).toBeCloseTo(angle, 4);
    expect(oriented.rect.width).toBeCloseTo(24, 3);
    expect(oriented.rect.height).toBeCloseTo(300, 3);
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
