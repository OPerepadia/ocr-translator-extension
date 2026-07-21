// Differentiable Binarization (DB) post-processing for the PP-OCRv6 detector.
// Turns the detector's probability map into text-line boxes. Pure TypeScript
// (no OpenCV, no browser APIs) so it is unit-testable.

import {
  aabbOfPoints,
  minAreaRect,
  pointInConvexPolygon,
  polygonArea,
  polygonPerimeter,
  lineIntersection,
  type Point,
  type Quad,
} from "./geometry";
import type { Rect } from "../../../shared/types";

export interface DbConfig {
  /** Probability above which a pixel is considered text. */
  threshold: number;
  /** Minimum mean probability inside a box to keep it. */
  boxThreshold: number;
  /** How much to expand each box outward (DB "unclip"). */
  unclipRatio: number;
  /** Drop boxes whose shorter side is below this (in detector pixels). */
  minBoxSize: number;
  /** Extra pixels added around each box after scaling to original coords. */
  padding: number;
}

export interface DetectedBox {
  /** Four corners in original-image coordinates. */
  quad: Quad;
  /** Axis-aligned bounding box in original-image coordinates. */
  bbox: Rect;
  /** Mean detector probability inside the box. */
  score: number;
}

/**
 * Extract text boxes from a detector probability map.
 *
 * @param probMap Row-major probabilities, length `mapW * mapH`.
 * @param scaleX  Multiply detector-x by this to reach original-image x.
 * @param scaleY  Multiply detector-y by this to reach original-image y.
 */
export function extractBoxes(
  probMap: Float32Array,
  mapW: number,
  mapH: number,
  cfg: DbConfig,
  scaleX: number,
  scaleY: number,
  originalWidth: number,
  originalHeight: number,
): DetectedBox[] {
  const bitmap = binarize(probMap, cfg.threshold);
  const components = connectedComponents(bitmap, mapW, mapH);
  const boxes: DetectedBox[] = [];

  for (const component of components) {
    const boundary = boundaryPoints(component, bitmap, mapW, mapH);
    if (boundary.length < 4) {
      continue;
    }

    const rect = minAreaRect(boundary);
    if (Math.min(rect.width, rect.height) < cfg.minBoxSize) {
      continue;
    }

    const score = boxScore(probMap, mapW, mapH, rect.corners);
    if (score < cfg.boxThreshold) {
      continue;
    }

    const expanded = unclip(rect.corners, cfg.unclipRatio);
    const expandedRect = minAreaRect(expanded);
    if (Math.min(expandedRect.width, expandedRect.height) < cfg.minBoxSize + 2) {
      continue;
    }

    const quad = expandedRect.corners.map((p) =>
      scaleAndPad(p, scaleX, scaleY),
    ) as Quad;
    const bbox = clampRect(boundingRect(quad, cfg.padding), {
      width: originalWidth,
      height: originalHeight,
    });
    if (bbox.width < 1 || bbox.height < 1) {
      continue;
    }

    boxes.push({ quad, bbox, score });
  }

  return boxes;
}

function binarize(probMap: Float32Array, threshold: number): Uint8Array {
  const bitmap = new Uint8Array(probMap.length);
  for (let i = 0; i < probMap.length; i++) {
    bitmap[i] = probMap[i] > threshold ? 1 : 0;
  }
  return bitmap;
}

/** 8-connectivity flood fill. Returns each component as a flat list of pixel
 * indices (y * width + x). */
function connectedComponents(
  bitmap: Uint8Array,
  width: number,
  height: number,
): number[][] {
  const visited = new Uint8Array(bitmap.length);
  const components: number[][] = [];
  const stack: number[] = [];

  for (let start = 0; start < bitmap.length; start++) {
    if (bitmap[start] === 0 || visited[start] === 1) {
      continue;
    }

    const component: number[] = [];
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;

    while (stack.length > 0) {
      const index = stack.pop() as number;
      component.push(index);
      const x = index % width;
      const y = (index - x) / width;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) {
            continue;
          }
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
            continue;
          }
          const nIndex = ny * width + nx;
          if (bitmap[nIndex] === 1 && visited[nIndex] === 0) {
            visited[nIndex] = 1;
            stack.push(nIndex);
          }
        }
      }
    }

    components.push(component);
  }

  return components;
}

/** Boundary pixels of a component (a pixel touching the background on any
 * 4-neighbour or the image edge). Cuts the convex-hull input down a lot. */
function boundaryPoints(
  component: number[],
  bitmap: Uint8Array,
  width: number,
  height: number,
): Point[] {
  const points: Point[] = [];
  for (const index of component) {
    const x = index % width;
    const y = (index - x) / width;
    const isBoundary =
      x === 0 ||
      y === 0 ||
      x === width - 1 ||
      y === height - 1 ||
      bitmap[index - 1] === 0 ||
      bitmap[index + 1] === 0 ||
      bitmap[index - width] === 0 ||
      bitmap[index + width] === 0;
    if (isBoundary) {
      points.push({ x, y });
    }
  }
  return points;
}

/** Mean probability inside the quad, sampled over its axis-aligned bounds.
 * Mirrors PaddleOCR's `box_score_fast`. */
function boxScore(
  probMap: Float32Array,
  width: number,
  height: number,
  quad: Quad,
): number {
  const { minX, minY, maxX, maxY } = aabbOfPoints(quad);
  const x0 = Math.max(0, Math.floor(minX));
  const y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(width - 1, Math.ceil(maxX));
  const y1 = Math.min(height - 1, Math.ceil(maxY));

  let sum = 0;
  let count = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (pointInConvexPolygon({ x: x + 0.5, y: y + 0.5 }, quad)) {
        sum += probMap[y * width + x];
        count++;
      }
    }
  }

  return count === 0 ? 0 : sum / count;
}

/** Expand a quad outward by distance d = area * ratio / perimeter. Offsets each
 * edge along its outward normal and re-intersects neighbours; falls back to a
 * centroid scale when an intersection is degenerate. */
export function unclip(corners: Quad, ratio: number): Point[] {
  const area = polygonArea(corners);
  const perimeter = polygonPerimeter(corners);
  if (perimeter === 0) {
    return corners.slice();
  }
  const distance = (area * ratio) / perimeter;

  const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
  const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;

  // Offset each edge along the normal pointing away from the centroid (so it
  // works regardless of winding order).
  const offsetEdges = corners.map((a, i) => {
    const b = corners[(i + 1) % corners.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey) || 1;
    let nx = -ey / len;
    let ny = ex / len;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    if (nx * (midX - cx) + ny * (midY - cy) < 0) {
      nx = -nx;
      ny = -ny;
    }
    return {
      a: { x: a.x + nx * distance, y: a.y + ny * distance },
      b: { x: b.x + nx * distance, y: b.y + ny * distance },
    };
  });

  const result: Point[] = [];
  let degenerate = false;
  for (let i = 0; i < corners.length; i++) {
    const prev = offsetEdges[(i - 1 + corners.length) % corners.length];
    const curr = offsetEdges[i];
    const point = lineIntersection(prev.a, prev.b, curr.a, curr.b);
    if (point === null) {
      degenerate = true;
      break;
    }
    result.push(point);
  }

  if (!degenerate && result.length === corners.length) {
    return result;
  }

  return centroidScale(corners, distance);
}

function centroidScale(corners: Quad, distance: number): Point[] {
  const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
  const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;
  return corners.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / len) * distance, y: p.y + (dy / len) * distance };
  });
}

function scaleAndPad(p: Point, scaleX: number, scaleY: number): Point {
  return { x: p.x * scaleX, y: p.y * scaleY };
}

function boundingRect(quad: Quad, padding: number): Rect {
  const { minX, minY, maxX, maxY } = aabbOfPoints(quad);
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}

function clampRect(rect: Rect, bounds: { width: number; height: number }): Rect {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const right = Math.min(bounds.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(bounds.height, Math.ceil(rect.y + rect.height));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}
