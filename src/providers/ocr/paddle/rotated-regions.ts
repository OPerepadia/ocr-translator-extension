// Geometry for reading comic text regions turned a quarter turn: the crop
// around a region, mapping boxes from the turned crop back onto the page, and
// choosing between the page's reading of a region and the turned one.

import { filterRecognizedLines, type RecognizedLine } from "./assemble";
import { isRotatedForRecognition } from "./crop";
import type { DetectedBox } from "./db-postprocess";
import type { Quad } from "./geometry";
import type { Rect } from "../../../shared/types";

/** Context kept around a text region when it is cropped, as a share of its
 * longer side. The layout model's boxes can clip the outermost glyphs. */
const REGION_MARGIN = 0.1;
const MIN_REGION_MARGIN = 8;

/** A region with a margin around it, in whole pixels inside the image. */
export function regionCrop(
  region: Rect,
  image: { width: number; height: number },
): Rect {
  const margin = Math.max(
    MIN_REGION_MARGIN,
    Math.round(REGION_MARGIN * Math.max(region.width, region.height)),
  );
  const x = Math.max(0, Math.floor(region.x - margin));
  const y = Math.max(0, Math.floor(region.y - margin));
  return {
    x,
    y,
    width: Math.min(image.width, Math.ceil(region.x + region.width + margin)) - x,
    height: Math.min(image.height, Math.ceil(region.y + region.height + margin)) - y,
  };
}

/** Map a box found in a crop turned counter-clockwise back onto the page. The
 * turn moved (x, y) to (y, width - x), so (u, v) comes from (width - v, u). A
 * line across the turned crop is a column on the page. */
export function toPageBox(box: DetectedBox, crop: Rect): DetectedBox {
  const { x, y, width, height } = box.bbox;
  return {
    quad: box.quad.map((point) => ({
      x: crop.x + crop.width - point.y,
      y: crop.y + point.x,
    })) as Quad,
    bbox: {
      x: crop.x + crop.width - (y + height),
      y: crop.y + x,
      width: height,
      height: width,
    },
    score: box.score,
    readsDown: !isRotatedForRecognition(box.quad),
  };
}

/** The region holding the center of a line, the smallest if several do, or -1. */
export function regionOf(line: Rect, regions: { bbox: Rect }[]): number {
  const centerX = line.x + line.width / 2;
  const centerY = line.y + line.height / 2;
  let best = -1;
  regions.forEach(({ bbox }, index) => {
    const inside =
      centerX >= bbox.x &&
      centerX <= bbox.x + bbox.width &&
      centerY >= bbox.y &&
      centerY <= bbox.y + bbox.height;
    if (
      inside &&
      (best === -1 ||
        bbox.width * bbox.height <
          regions[best].bbox.width * regions[best].bbox.height)
    ) {
      best = index;
    }
  });
  return best;
}

/** Confidently read characters among the lines that would be shown. */
export function readingScore(lines: RecognizedLine[]): number {
  return filterRecognizedLines(lines).reduce(
    (score, line) => score + line.confidence * [...line.text].length,
    0,
  );
}
