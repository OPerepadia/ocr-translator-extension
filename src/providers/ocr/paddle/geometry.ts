// Pure 2D geometry helpers for detector post-processing. No browser or ORT
// dependencies so this module is unit-testable under vitest's node env.

import type { OrientedRect } from "../../../shared/types";

export interface Point {
  x: number;
  y: number;
}

export type Quad = [Point, Point, Point, Point];

export interface MinAreaRect {
  center: Point;
  width: number;
  height: number;
  /** Rotation in radians of the rectangle's first edge. */
  angle: number;
  corners: Quad;
}

/** Signed shoelace area; sign depends on winding (use polygonArea for size). */
export function signedArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

export function polygonArea(points: Point[]): number {
  return Math.abs(signedArea(points));
}

export function polygonPerimeter(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return sum;
}

/** Convex hull via Andrew's monotone chain. Returns hull vertices in
 * counter-clockwise order (in a standard math frame). O(n log n). */
export function convexHull(points: Point[]): Point[] {
  if (points.length < 3) {
    return points.slice();
  }

  const sorted = points
    .slice()
    .sort((p, q) => (p.x === q.x ? p.y - q.y : p.x - q.x));

  const cross = (o: Point, a: Point, b: Point): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Point[] = [];
  for (const p of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Minimum-area enclosing rectangle of a point set, via rotating calipers over
 * the convex hull edges (equivalent to cv::minAreaRect). */
export function minAreaRect(points: Point[]): MinAreaRect {
  const hull = convexHull(points);

  if (hull.length < 2) {
    const p = points[0] ?? { x: 0, y: 0 };
    return {
      center: { x: p.x, y: p.y },
      width: 0,
      height: 0,
      angle: 0,
      corners: [
        { x: p.x, y: p.y },
        { x: p.x, y: p.y },
        { x: p.x, y: p.y },
        { x: p.x, y: p.y },
      ],
    };
  }

  let best: MinAreaRect | null = null;

  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const edgeX = b.x - a.x;
    const edgeY = b.y - a.y;
    const len = Math.hypot(edgeX, edgeY);
    if (len === 0) {
      continue;
    }

    // Unit vectors of the rotated frame: u along the edge, v perpendicular.
    const ux = edgeX / len;
    const uy = edgeY / len;
    const vx = -uy;
    const vy = ux;

    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const pu = p.x * ux + p.y * uy;
      const pv = p.x * vx + p.y * vy;
      if (pu < minU) minU = pu;
      if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv;
      if (pv > maxV) maxV = pv;
    }

    const width = maxU - minU;
    const height = maxV - minV;
    const area = width * height;

    if (best === null || area < best.width * best.height) {
      // Reconstruct corners in world space from the rotated-frame extents.
      const corner = (u: number, v: number): Point => ({
        x: u * ux + v * vx,
        y: u * uy + v * vy,
      });
      const corners: Quad = [
        corner(minU, minV),
        corner(maxU, minV),
        corner(maxU, maxV),
        corner(minU, maxV),
      ];
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = {
        center: corner(cu, cv),
        width,
        height,
        angle: Math.atan2(uy, ux),
        corners,
      };
    }
  }

  // best is always set because at least one edge has non-zero length for a
  // hull of >= 2 distinct points; fall back defensively.
  return best ?? minAreaRect([points[0] ?? { x: 0, y: 0 }]);
}

/** The snug rotated box around a quad, in whichever of its two frames sits
 * nearest upright: the angle folds into (-45°, 45°], so the returned rect's
 * width still runs across the box and its height down it, the way an unrotated
 * rect's do. Text at an angle needs one of these — an axis-aligned box has to
 * grow well past the glyphs to hold the same line. */
export function orientedRectOfQuad(quad: Quad): OrientedRect {
  const { center, width, height, angle } = minAreaRect(quad);
  const folded = foldAxisAngle(angle);
  // The two axes are a quarter turn apart, so exactly one of them folds inside
  // the quarter turn around upright.
  const upright = Math.abs(folded) <= Math.PI / 4;
  const w = upright ? width : height;
  const h = upright ? height : width;
  return {
    rect: { x: center.x - w / 2, y: center.y - h / 2, width: w, height: h },
    angle: upright ? folded : foldAxisAngle(angle + Math.PI / 2),
  };
}

/** Fold a direction into (-90°, 90°]. A box axis and its reverse are the same
 * axis, so directions half a turn apart are equivalent. */
function foldAxisAngle(angle: number): number {
  const folded = angle - Math.PI * Math.round(angle / Math.PI);
  return folded <= -Math.PI / 2 ? folded + Math.PI : folded;
}

/** Intersection of the infinite lines through (p1,p2) and (p3,p4). Returns null
 * when the lines are (near) parallel. */
export function lineIntersection(
  p1: Point,
  p2: Point,
  p3: Point,
  p4: Point,
): Point | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) {
    return null;
  }
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}

/** Axis-aligned bounding box of a set of points. */
export function aabbOfPoints(points: Point[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Point-in-convex-polygon test. Assumes `polygon` is convex; works for either
 * winding order because it accepts a point that is on the same side of every
 * edge (all cross products share a sign, with zero treated as inside). */
export function pointInConvexPolygon(point: Point, polygon: Point[]): boolean {
  let hasPos = false;
  let hasNeg = false;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (cross > 0) hasPos = true;
    else if (cross < 0) hasNeg = true;
    if (hasPos && hasNeg) {
      return false;
    }
  }
  return true;
}
