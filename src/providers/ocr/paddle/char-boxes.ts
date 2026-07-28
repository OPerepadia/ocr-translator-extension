// Turn a CTC decode into per-character boxes on the source image. Pure math, no
// browser or ORT dependencies.
//
// The recognizer sees one line crop, stretched to a fixed height, and emits T
// timesteps spread evenly across that crop's width. So the run of timesteps that
// produced a character locates it along the line: fraction = timestep / T. The
// crop comes from a (padded) detector quad, and tall crops are rotated upright
// before recognition, so the fraction runs down the quad instead of across it.

import type { OcrChar, Rect } from "../../../shared/types";
import type { CtcChar } from "./ctc";
import type { Point, Quad } from "./geometry";

// CTC peaks are narrow: a character usually wins one or two timesteps and the
// rest go to blank. Character boundaries are therefore placed midway between
// neighbouring peaks rather than at the peaks' own edges.
export function charBoxes(args: {
  chars: CtcChar[];
  timeSteps: number;
  /** The detector's quad for this line, ordered top-left, -right, -bottom-right,
   * -bottom-left (what `padQuad` returns). Boxes are cut from this one, so they
   * hug the text rather than the padding the recognizer saw. */
  quad: Quad;
  /** How far the crop was padded out from `quad` on each side. */
  padding: number;
  /** True when the crop was rotated upright for recognition, i.e. the line
   * reads top-to-bottom down the quad. */
  rotated: boolean;
}): OcrChar[] {
  const { chars, timeSteps, quad, padding, rotated } = args;
  if (chars.length === 0 || timeSteps <= 0) {
    return [];
  }

  const length = quadLength(quad, rotated);
  const centers = chars.map((entry) =>
    unpad((entry.start + entry.end) / 2 / timeSteps, length, padding),
  );
  const bounds = charBounds(centers);

  return chars.map((entry, index) => {
    const [from, to] = bounds[index];
    return {
      text: entry.char,
      bbox: sliceQuad(quad, from, to, rotated),
    };
  });
}

/** Re-base a fraction of the padded crop onto the unpadded quad. */
function unpad(fraction: number, length: number, padding: number): number {
  if (padding <= 0 || length <= 0) {
    return fraction;
  }
  return (fraction * (length + padding * 2) - padding) / length;
}

/** The quad's extent along the reading direction. */
function quadLength(quad: Quad, rotated: boolean): number {
  const [topLeft, topRight, bottomRight, bottomLeft] = quad;
  return rotated
    ? Math.max(
        distance(topLeft, bottomLeft),
        distance(topRight, bottomRight),
      )
    : Math.max(distance(topLeft, topRight), distance(bottomLeft, bottomRight));
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Split [0, 1] at the midpoints between peak centres. The first and last
 * characters keep their outer edge at the crop edge, since the crop is padded
 * around the text anyway. */
function charBounds(centers: number[]): Array<[number, number]> {
  return centers.map((center, index) => {
    const previous = centers[index - 1];
    const next = centers[index + 1];
    const from = previous === undefined ? 0 : (previous + center) / 2;
    const to = next === undefined ? 1 : (center + next) / 2;
    return [clamp01(from), clamp01(Math.max(from, to))];
  });
}

/** The bounding box of the quad's slice between two fractions along the reading
 * direction. */
function sliceQuad(
  quad: Quad,
  from: number,
  to: number,
  rotated: boolean,
): Rect {
  const [topLeft, topRight, bottomRight, bottomLeft] = quad;
  // Reading across the quad (normal lines) walks the top and bottom edges;
  // reading down it (rotated crops) walks the left and right edges.
  const [startA, endA, startB, endB] = rotated
    ? [topLeft, bottomLeft, topRight, bottomRight]
    : [topLeft, topRight, bottomLeft, bottomRight];

  return boundingRect([
    lerp(startA, endA, from),
    lerp(startA, endA, to),
    lerp(startB, endB, from),
    lerp(startB, endB, to),
  ]);
}

function boundingRect(points: Point[]): Rect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  };
}

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
