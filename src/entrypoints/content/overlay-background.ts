// Picks a translation card color from the image around each OCR block.

import type { Rect } from "@/shared/types";
import {
  orientedCorners,
  paragraphAngle,
  rotatePoint,
  type OverlayLine,
} from "./overlay-layout";

type Rgb = [number, number, number];

export interface OverlayTint {
  background: string;
  foreground: string;
}

// Wide enough to clear antialiasing, narrow enough to stay near the block.
const SURROUND_MARGIN = 6;
const SURROUND_SAMPLES = 4096;
// Share of the block's short side the band reaches inside it.
const SURROUND_INSET = 0.25;

/** The most common color in a band around the lines, for their translation
 * card. The band straddles the block's edge and follows the text's tilt, so it hugs
 * a tilted block instead of its wider page-aligned bounds. */
export function estimateSurroundingTint(
  image: Pick<ImageData, "width" | "height" | "data">,
  capture: Rect,
  lines: OverlayLine[],
): OverlayTint | undefined {
  if (!lines.length || capture.width <= 0 || capture.height <= 0) {
    return undefined;
  }
  const sx = image.width / capture.width;
  const sy = image.height / capture.height;
  const oriented = lines.map((line) => line.oriented ?? { rect: line.rect, angle: 0 });
  const angle = paragraphAngle(oriented);
  // Corners in a frame turned by the tilt, where the block is upright.
  const corners = oriented.flatMap((line) =>
    orientedCorners(line).map((point) => rotatePoint(point, -angle)));
  const block = {
    left: Math.min(...corners.map((p) => p.x)),
    top: Math.min(...corners.map((p) => p.y)),
    right: Math.max(...corners.map((p) => p.x)),
    bottom: Math.max(...corners.map((p) => p.y)),
  };
  const grow = (box: typeof block, by: number) => ({
    left: box.left - by, top: box.top - by, right: box.right + by, bottom: box.bottom + by,
  });
  const sampleBand = (outer: typeof block, inner: typeof block): Rgb[] => {
    const area = (outer.right - outer.left) * (outer.bottom - outer.top) -
      Math.max(0, inner.right - inner.left) * Math.max(0, inner.bottom - inner.top);
    const step = Math.max(1 / Math.max(sx, sy), Math.sqrt(area / SURROUND_SAMPLES));
    const samples: Rgb[] = [];
    for (let v = outer.top + step / 2; v < outer.bottom; v += step) {
      const crossesInner = v >= inner.top && v < inner.bottom;
      for (let u = outer.left + step / 2; u < outer.right; u += step) {
        if (crossesInner && u >= inner.left && u < inner.right) {
          u += Math.floor((inner.right - u) / step) * step;
          continue;
        }
        const point = rotatePoint({ x: u, y: v }, angle);
        const x = Math.floor((point.x - capture.x) * sx);
        const y = Math.floor((point.y - capture.y) * sy);
        if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
          continue;
        }
        const index = (y * image.width + x) * 4;
        if (image.data[index + 3] === 255) {
          samples.push([image.data[index], image.data[index + 1], image.data[index + 2]]);
        }
      }
    }
    return samples;
  };
  // OCR boxes pad the glyphs, so the inner edge shows what the text sits on: a
  // sign or label can end right at the box, leaving only the wall outside.
  const inset = Math.min(block.right - block.left, block.bottom - block.top) * SURROUND_INSET;
  const samples = sampleBand(grow(block, SURROUND_MARGIN), grow(block, -inset));
  if (samples.length < 16) {
    return undefined;
  }
  // The most common coarse color, so a neighboring line or frame edge in the
  // band does not pull the color toward a mix that is not in the image. Each
  // bin counts with its neighbors: one flat color near a bin edge would
  // otherwise split in two and lose to the glyph ink.
  const bins = new Map<number, Rgb[]>();
  for (const sample of samples) {
    const key = binKey(sample[0] >> 5, sample[1] >> 5, sample[2] >> 5);
    const bin = bins.get(key);
    if (bin) bin.push(sample);
    else bins.set(key, [sample]);
  }
  const neighborhood = (key: number): Rgb[] => {
    const [r, g, b] = [key >> 6, (key >> 3) & 7, key & 7];
    const members: Rgb[] = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dg = -1; dg <= 1; dg++) {
        for (let db = -1; db <= 1; db++) {
          const bin = bins.get(binKey(r + dr, g + dg, b + db));
          if (bin) members.push(...bin);
        }
      }
    }
    return members;
  };
  let best: Rgb[] = [];
  for (const key of bins.keys()) {
    const members = neighborhood(key);
    if (members.length > best.length) best = members;
  }
  return panelColors(medianColor(best));
}

function binKey(r: number, g: number, b: number): number {
  return r < 0 || g < 0 || b < 0 || r > 7 || g > 7 || b > 7 ? -1 : r << 6 | g << 3 | b;
}

function panelColors(color: Rgb): OverlayTint {
  const [red, green, blue] = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  return {
    background: `rgb(${color.join(", ")})`,
    foreground: luminance > 0.22 ? "#152034" : "#ffffff",
  };
}

function medianColor(colors: Rgb[]): Rgb {
  return [0, 1, 2].map((channel) => {
    const values = colors.map((color) => color[channel]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  }) as Rgb;
}
