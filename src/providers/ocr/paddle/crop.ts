// Image crop helpers for the engine. Bitmap resize uses OffscreenCanvas in the
// worker; quad crop math works on plain RGBA buffers and is unit-testable.

import { computeRecWidth } from "./preprocess";
import {
  lineIntersection,
  type Point,
  type Quad,
} from "./geometry";

export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

function context(width: number, height: number): OffscreenCanvasRenderingContext2D {
  const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Could not create an OffscreenCanvas 2D context.");
  }
  // High-quality interpolation keeps small upscaled text and downscaled wide
  // lines legible for the recognizer.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return ctx;
}

/** Resize an entire bitmap into a fresh ImageData of the target size. */
export function resizeToImageData(
  bitmap: ImageBitmap,
  targetWidth: number,
  targetHeight: number,
): ImageData {
  const ctx = context(targetWidth, targetHeight);
  ctx.drawImage(
    bitmap,
    0,
    0,
    bitmap.width,
    bitmap.height,
    0,
    0,
    targetWidth,
    targetHeight,
  );
  return ctx.getImageData(0, 0, targetWidth, targetHeight);
}

/** Copy a bitmap into ImageData once so multiple line crops can sample it. */
export function bitmapToImageData(bitmap: ImageBitmap): ImageData {
  return resizeToImageData(bitmap, bitmap.width, bitmap.height);
}

/**
 * Perspective-crop a detector quad, rotate tall vertical crops into recognizer
 * orientation, then resize to the recognizer's fixed height.
 */
export function cropQuadToImageData(
  source: RgbaImage,
  quad: Quad,
  recHeight: number,
  minWidth: number,
  maxWidth: number,
  padding = 0,
): ImageData {
  const crop = orientCropForRecognition(cropQuad(source, padQuad(quad, padding)));
  const recWidth = computeRecWidth(
    crop.width,
    crop.height,
    recHeight,
    minWidth,
    maxWidth,
  );
  return resizeRgbaToImageData(crop, recWidth, recHeight);
}

export function cropQuad(source: RgbaImage, quad: Quad): RgbaImage {
  const ordered = orderQuad(quad);
  const width = Math.max(
    distance(ordered[0], ordered[1]),
    distance(ordered[3], ordered[2]),
  );
  const height = Math.max(
    distance(ordered[0], ordered[3]),
    distance(ordered[1], ordered[2]),
  );
  const dstW = Math.max(1, Math.round(width));
  const dstH = Math.max(1, Math.round(height));
  const data = new Uint8ClampedArray(dstW * dstH * 4);

  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = ordered.map(pointTuple);
  const dx1 = x1 - x2;
  const dy1 = y1 - y2;
  const dx2 = x3 - x2;
  const dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dy1 * dx2;

  if (Math.abs(den) < 1e-9) {
    return cropBoundingRect(source, ordered);
  }

  const g = (sx * dy2 - sy * dx2) / den;
  const h = (dx1 * sy - dy1 * sx) / den;
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + h * x3;
  const c = x0;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + h * y3;
  const f = y0;

  for (let y = 0; y < dstH; y++) {
    const v = (y + 0.5) / dstH;
    for (let x = 0; x < dstW; x++) {
      const u = (x + 0.5) / dstW;
      const w = g * u + h * v + 1;
      const [r, gg, bb, aa] = bilinearRgba(
        source,
        (a * u + b * v + c) / w,
        (d * u + e * v + f) / w,
      );
      const i = (y * dstW + x) * 4;
      data[i] = r;
      data[i + 1] = gg;
      data[i + 2] = bb;
      data[i + 3] = aa;
    }
  }

  return { data, width: dstW, height: dstH };
}

export function padQuad(quad: Quad, padding: number): Quad {
  const ordered = orderQuad(quad);
  if (padding <= 0) {
    return ordered;
  }

  const center = centroid(ordered);
  const offsetEdges = ordered.map((a, index) => {
    const b = ordered[(index + 1) % ordered.length];
    const edgeX = b.x - a.x;
    const edgeY = b.y - a.y;
    const len = Math.hypot(edgeX, edgeY) || 1;
    let nx = -edgeY / len;
    let ny = edgeX / len;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;

    if (nx * (midX - center.x) + ny * (midY - center.y) < 0) {
      nx = -nx;
      ny = -ny;
    }

    return {
      a: { x: a.x + nx * padding, y: a.y + ny * padding },
      b: { x: b.x + nx * padding, y: b.y + ny * padding },
    };
  });

  const padded = ordered.map((_, index) => {
    const prev = offsetEdges[(index - 1 + offsetEdges.length) % offsetEdges.length];
    const current = offsetEdges[index];
    return lineIntersection(prev.a, prev.b, current.a, current.b);
  });

  if (padded.every((point): point is Point => point !== null)) {
    return orderQuad(padded as Quad);
  }

  return ordered.map((point) => {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    const len = Math.hypot(dx, dy) || 1;
    return {
      x: point.x + (dx / len) * padding,
      y: point.y + (dy / len) * padding,
    };
  }) as Quad;
}

/** Whether a crop of this quad is rotated upright before recognition — the same
 * test `orientCropForRecognition` applies, but on the quad, so callers can tell
 * which way the recognizer's timesteps run without cropping anything. */
export function isRotatedForRecognition(quad: Quad): boolean {
  const ordered = orderQuad(quad);
  const width = Math.max(
    distance(ordered[0], ordered[1]),
    distance(ordered[3], ordered[2]),
  );
  const height = Math.max(
    distance(ordered[0], ordered[3]),
    distance(ordered[1], ordered[2]),
  );
  return Math.max(1, Math.round(height)) / Math.max(1, Math.round(width)) >= 1.5;
}

export function orientCropForRecognition(crop: RgbaImage): RgbaImage {
  return crop.height / crop.width >= 1.5 ? rotate90CounterClockwise(crop) : crop;
}

function resizeRgbaToImageData(
  source: RgbaImage,
  targetWidth: number,
  targetHeight: number,
): ImageData {
  const data = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  const sx = source.width / targetWidth;
  const sy = source.height / targetHeight;

  for (let y = 0; y < targetHeight; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const [r, g, b, a] = bilinearRgba(
        source,
        (x + 0.5) * sx - 0.5,
        (y + 0.5) * sy - 0.5,
      );
      const i = (y * targetWidth + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }

  return new ImageData(data, targetWidth, targetHeight);
}

function rotate90CounterClockwise(source: RgbaImage): RgbaImage {
  const data = new Uint8ClampedArray(source.data.length);
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const src = (y * source.width + x) * 4;
      const dst = ((source.width - 1 - x) * source.height + y) * 4;
      data[dst] = source.data[src];
      data[dst + 1] = source.data[src + 1];
      data[dst + 2] = source.data[src + 2];
      data[dst + 3] = source.data[src + 3];
    }
  }
  return { data, width: source.height, height: source.width };
}

function cropBoundingRect(source: RgbaImage, quad: Quad): RgbaImage {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const sx = Math.max(0, Math.floor(Math.min(...xs)));
  const sy = Math.max(0, Math.floor(Math.min(...ys)));
  const right = Math.min(source.width, Math.ceil(Math.max(...xs)));
  const bottom = Math.min(source.height, Math.ceil(Math.max(...ys)));
  const width = Math.max(1, right - sx);
  const height = Math.max(1, bottom - sy);
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = ((sy + y) * source.width + sx + x) * 4;
      const dst = (y * width + x) * 4;
      data[dst] = source.data[src];
      data[dst + 1] = source.data[src + 1];
      data[dst + 2] = source.data[src + 2];
      data[dst + 3] = source.data[src + 3];
    }
  }

  return { data, width, height };
}

function orderQuad(points: Quad): Quad {
  const center = centroid(points);
  const sorted = points
    .slice()
    .sort(
      (a, b) =>
        Math.atan2(a.y - center.y, a.x - center.x) -
        Math.atan2(b.y - center.y, b.x - center.x),
    );
  const start = sorted.reduce((bestIndex, point, index) => {
    const best = sorted[bestIndex];
    const pointScore = point.x + point.y;
    const bestScore = best.x + best.y;
    if (pointScore !== bestScore) {
      return pointScore < bestScore ? index : bestIndex;
    }
    return point.y < best.y || (point.y === best.y && point.x < best.x)
      ? index
      : bestIndex;
  }, 0);

  return [
    sorted[start],
    sorted[(start + 1) % sorted.length],
    sorted[(start + 2) % sorted.length],
    sorted[(start + 3) % sorted.length],
  ];
}

function bilinearRgba(
  source: RgbaImage,
  x: number,
  y: number,
): [number, number, number, number] {
  const x0 = clamp(Math.floor(x), 0, source.width - 1);
  const y0 = clamp(Math.floor(y), 0, source.height - 1);
  const x1 = Math.min(source.width - 1, x0 + 1);
  const y1 = Math.min(source.height - 1, y0 + 1);
  const fx = clamp(x - x0, 0, 1);
  const fy = clamp(y - y0, 0, 1);
  const out: [number, number, number, number] = [0, 0, 0, 0];

  for (let c = 0; c < 4; c++) {
    const top =
      sample(source, x0, y0, c) * (1 - fx) + sample(source, x1, y0, c) * fx;
    const bottom =
      sample(source, x0, y1, c) * (1 - fx) + sample(source, x1, y1, c) * fx;
    out[c] = top * (1 - fy) + bottom * fy;
  }

  return out;
}

function sample(source: RgbaImage, x: number, y: number, channel: number): number {
  return source.data[(y * source.width + x) * 4 + channel];
}

function pointTuple(point: Point): [number, number] {
  return [point.x, point.y];
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function centroid(points: Quad): Point {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
