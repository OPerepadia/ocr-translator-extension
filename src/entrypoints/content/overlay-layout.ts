// Pure geometry/text mapping for the in-place overlay. No DOM: turns the OCR
// result (block bboxes in cropped-image pixels + the joined paragraph texts)
// into page-positioned boxes over the selection rect.

import type { OcrBlock, OcrChar, OrientedRect, Rect } from "@/shared/types";

export interface OverlayLine {
  rect: Rect;
  /** The line's own tilted box over the page; always set, matching `rect`
   * untilted when the provider reported none. The text layer lays a tilted
   * paragraph's spans out from these, since `rect` has grown around the tilt. */
  oriented?: OrientedRect;
  text: string;
  /** True when this line reads top-to-bottom, from its paragraph. Per line
   * because one box can gather lines of both orientations (a manga page mixes
   * vertical bubbles with horizontal captions). */
  vertical: boolean;
  /** Per-character boxes over the page, when the recognizer located them. The
   * text layer then places one span per character instead of stretching the
   * whole line, so a selection lands on the right glyphs. */
  chars?: Array<{ rect: Rect; oriented?: OrientedRect; text: string }>;
}

export interface OverlayParagraph {
  /** Original OCR position over the page, in page CSS pixels. Anchors the frame
   * and its selectable text layer in the original view. */
  sourceRect: Rect;
  /** Position the translated text is painted at in the translation view. May be
   * wider than `sourceRect` for vertical source text. */
  translationRect: Rect;
  /** Tilt of both rects, about their own centre, in radians. Zero for upright
   * text, which is every paragraph the detector reports no tilted boxes for. */
  angle: number;
  /** The recognized original text for this paragraph. For vertical paragraphs
   * the detected columns are separated by newlines, so the original view breaks
   * columns where the source image does. Display-only: the translation input
   * is the joined `ocrText` line, never this. */
  original: string;
  /** The translated line, or null when the translation could not be split per
   * paragraph (see `segmented`). */
  translated: string | null;
  lines: OverlayLine[];
  /** True when this paragraph's source text reads vertically; the original
   * view then renders it with a vertical writing mode. Per paragraph because a
   * capture can mix orientations (vertical columns plus a horizontal footer). */
  vertical: boolean;
}

export interface OverlayLayout {
  paragraphs: OverlayParagraph[];
  /** True when the translation split into one line per paragraph, so each box
   * gets its own translation. False when the line counts differ, in which case
   * the translation view uses the combined box below instead. */
  segmented: boolean;
  /** The fallback painted box for the unsegmented translation case. Widened for
   * vertical source text, like a paragraph's `translationRect`. */
  combinedRect: Rect;
  /** The same fallback box left on the source text, for the original view's
   * frame and popover. */
  combinedSourceRect: Rect;
  combinedTranslation: string;
}

export interface BuildOverlayInput {
  ocrText: string;
  translationText: string;
  blocks: OcrBlock[];
  imageWidth: number;
  imageHeight: number;
  /** The selection rect on the page, in page CSS pixels. */
  rect: Rect;
  orientation?: "horizontal" | "vertical";
}

const VERTICAL_TRANSLATION_ASPECT_RATIO = 2.0;
const VERTICAL_TRANSLATION_MIN_WIDTH = 120;
// A line only votes on tilt if it is clearly oblong, the same bar the OCR
// assembler sets for reading orientation.
const ANGLE_VOTE_MIN_ASPECT = 1.5;
const ANGLE_SNAP_RADIANS = (2 * Math.PI) / 180;

export function getRenderedImageRect(args: {
  elementRect: Rect;
  naturalWidth: number;
  naturalHeight: number;
  objectFit: string;
  objectPosition: string;
}): Rect {
  const {
    elementRect,
    naturalWidth,
    naturalHeight,
    objectFit,
    objectPosition,
  } = args;
  if (
    naturalWidth <= 0 ||
    naturalHeight <= 0 ||
    (objectFit !== "contain" && objectFit !== "scale-down")
  ) {
    return { ...elementRect };
  }

  const containScale = Math.min(
    elementRect.width / naturalWidth,
    elementRect.height / naturalHeight,
  );
  const scale =
    objectFit === "scale-down" ? Math.min(1, containScale) : containScale;
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  const [xPosition = "50%", yPosition = "50%"] = objectPosition
    .trim()
    .split(/\s+/);

  return {
    x: elementRect.x + positionOffset(xPosition, elementRect.width - width),
    y: elementRect.y + positionOffset(yPosition, elementRect.height - height),
    width,
    height,
  };
}

/** Group blocks by their paragraph index, unioning each group's bboxes and
 * collecting the block texts in encounter order (the assembler emits blocks in
 * reading order). A paragraph's orientation is its blocks' orientation (uniform
 * within a paragraph, undefined when the provider doesn't set it). Blocks
 * without a paragraph index are treated as their own single-block paragraph. */
export function groupParagraphs(blocks: OcrBlock[]): Array<{
  paragraph: number;
  bbox: Rect;
  texts: string[];
  lineBboxes: Rect[];
  /** Each block's tilted box, in the same order as `texts`. Falls back to the
   * block's own bbox, untilted, when the provider reports none. */
  lineOriented: OrientedRect[];
  lineChars: Array<OcrChar[] | undefined>;
  orientation?: "horizontal" | "vertical";
}> {
  const groups = new Map<
    number,
    {
      rects: Rect[];
      oriented: OrientedRect[];
      texts: string[];
      chars: Array<OcrChar[] | undefined>;
      orientation?: "horizontal" | "vertical";
    }
  >();
  blocks.forEach((block, index) => {
    // Fall back to a per-block key when paragraph is missing, offset past real
    // indices so it can't collide with a genuine paragraph 0.
    const key = block.paragraph ?? blocks.length + index;
    const oriented = block.oriented ?? { rect: block.bbox, angle: 0 };
    const group = groups.get(key);
    if (group) {
      group.rects.push(block.bbox);
      group.oriented.push(oriented);
      group.texts.push(block.text);
      group.chars.push(block.chars);
    } else {
      groups.set(key, {
        rects: [block.bbox],
        oriented: [oriented],
        texts: [block.text],
        chars: [block.chars],
        orientation: block.orientation,
      });
    }
  });

  return [...groups.entries()]
    .map(([paragraph, group]) => ({
      paragraph,
      bbox: unionRect(group.rects),
      texts: group.texts,
      lineBboxes: group.rects,
      lineOriented: group.oriented,
      lineChars: group.chars,
      orientation: group.orientation,
    }))
    .sort((a, b) => a.paragraph - b.paragraph);
}

/** Map a bbox (in cropped-image pixels) onto the selection rect (page CSS
 * pixels) by fraction, so it lands over the same spot on the page. */
export function mapBboxToPage(
  bbox: Rect,
  imageWidth: number,
  imageHeight: number,
  rect: Rect,
): Rect {
  const sx = rect.width / imageWidth;
  const sy = rect.height / imageHeight;
  return {
    x: rect.x + bbox.x * sx,
    y: rect.y + bbox.y * sy,
    width: bbox.width * sx,
    height: bbox.height * sy,
  };
}

/** Map a tilt from image space onto the page. Only matters when the capture is
 * scaled by different factors on the two axes, which shears the angle. */
export function mapAngleToPage(angle: number, sx: number, sy: number): number {
  return Math.atan2(sy * Math.sin(angle), sx * Math.cos(angle));
}

/** Turn a box from the frame the provider reports it in — squared to the
 * direction the text advances — into the one it is laid out in. They are the
 * same for ordinary text; a paragraph set vertically runs its text down the box
 * instead of across it, so its boxes turn a quarter to match. */
export function toWritingFrame(
  oriented: OrientedRect,
  vertical: boolean,
): OrientedRect {
  if (!vertical) {
    return oriented;
  }
  const { rect, angle } = oriented;
  // A rect turned a quarter about its own centre covers the same ground with
  // its sides swapped.
  const width = rect.height;
  const height = rect.width;
  return {
    rect: {
      x: rect.x + rect.width / 2 - width / 2,
      y: rect.y + rect.height / 2 - height / 2,
      width,
      height,
    },
    angle: angle - Math.PI / 2,
  };
}

/** The axis-aligned box a tilted rect covers, for the things that still work in
 * page space: the frame the popover is placed against, and the union that gives
 * a mixed-tilt capture its one combined box. */
export function rotatedBounds(rect: Rect, angle: number): Rect {
  if (angle === 0) {
    return { ...rect };
  }
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const width = rect.width * cos + rect.height * sin;
  const height = rect.width * sin + rect.height * cos;
  return {
    x: rect.x + (rect.width - width) / 2,
    y: rect.y + (rect.height - height) / 2,
    width,
    height,
  };
}

/** How far a paragraph is tilted: its lines' angles, each weighted by how long
 * the line is, with near-square lines abstaining — a single short word's box has
 * no dependable direction to report. Small angles come back as none: the
 * detector's boxes wander a degree or two on upright text, and tilting a whole
 * capture by that would only look careless. */
export function paragraphAngle(lines: OrientedRect[]): number {
  // Averaged as doubled angles, so the mean is taken over box orientations
  // rather than over raw numbers: a box turned by half a turn is the same box,
  // and its angle may be reported either way round.
  let x = 0;
  let y = 0;
  let total = 0;
  for (const line of lines) {
    const long = Math.max(line.rect.width, line.rect.height);
    const short = Math.max(1, Math.min(line.rect.width, line.rect.height));
    if (long / short < ANGLE_VOTE_MIN_ASPECT) {
      continue;
    }
    x += Math.cos(2 * line.angle) * long;
    y += Math.sin(2 * line.angle) * long;
    total += long;
  }
  if (total === 0) {
    return 0;
  }
  const angle = Math.atan2(y, x) / 2;
  return Math.abs(angle) < ANGLE_SNAP_RADIANS ? 0 : angle;
}

/** The snug box around a paragraph's lines, measured in a frame tilted by
 * `angle` so it hugs the text instead of growing around the tilt. */
function orientedParagraphRect(lines: OrientedRect[], angle: number): Rect {
  const corners = lines.flatMap((line) =>
    orientedCorners(line).map((point) => rotatePoint(point, -angle)),
  );
  const minX = Math.min(...corners.map((p) => p.x));
  const minY = Math.min(...corners.map((p) => p.y));
  const maxX = Math.max(...corners.map((p) => p.x));
  const maxY = Math.max(...corners.map((p) => p.y));
  const width = maxX - minX;
  const height = maxY - minY;
  // The centre is the one point the tilted frame and the page agree on.
  const center = rotatePoint(
    { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    angle,
  );
  return {
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
  };
}

function orientedCorners(oriented: OrientedRect): Array<{ x: number; y: number }> {
  const { rect, angle } = oriented;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;
  return [
    [-halfWidth, -halfHeight],
    [halfWidth, -halfHeight],
    [halfWidth, halfHeight],
    [-halfWidth, halfHeight],
  ].map(([dx, dy]) => {
    const corner = rotatePoint({ x: dx, y: dy }, angle);
    return { x: cx + corner.x, y: cy + corner.y };
  });
}

function rotatePoint(
  point: { x: number; y: number },
  angle: number,
): { x: number; y: number } {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
  };
}

export function buildOverlayLayout(input: BuildOverlayInput): OverlayLayout {
  const groups = groupParagraphs(input.blocks);
  const originalLines = input.ocrText.split("\n");
  const translatedLines = input.translationText.split("\n");
  const paragraphLineCount =
    groups.length > 0
      ? Math.max(...groups.map((group) => group.paragraph)) + 1
      : 0;
  // The translation maps per box only when it has one line per OCR paragraph.
  const segmented =
    translatedLines.length === originalLines.length &&
    translatedLines.length >= paragraphLineCount;

  const defaultVertical = input.orientation === "vertical";
  const scaleX = input.rect.width / input.imageWidth;
  const scaleY = input.rect.height / input.imageHeight;
  const paragraphs: OverlayParagraph[] = groups.map((group) => {
    const vertical = group.orientation
      ? group.orientation === "vertical"
      : defaultVertical;
    const toPage = (bbox: Rect): Rect =>
      mapBboxToPage(bbox, input.imageWidth, input.imageHeight, input.rect);
    const orientedToPage = (oriented: OrientedRect): OrientedRect =>
      toWritingFrame(
        {
          rect: toPage(oriented.rect),
          angle: mapAngleToPage(oriented.angle, scaleX, scaleY),
        },
        vertical,
      );
    const orientedLines = group.lineOriented.map(orientedToPage);
    const angle = paragraphAngle(orientedLines);
    // Upright paragraphs keep the plain union of their lines' boxes, so nothing
    // about an ordinary capture shifts; only a tilted one needs the snug box
    // measured in its own frame.
    const sourceRect =
      angle === 0
        ? toPage(group.bbox)
        : orientedParagraphRect(orientedLines, angle);
    const lines = group.lineBboxes.map((bbox, index) => {
      const chars = group.lineChars[index];
      return {
        rect: toPage(bbox),
        oriented: orientedLines[index],
        text: group.texts[index] ?? "",
        vertical,
        ...(chars
          ? {
              chars: chars.map((char) => ({
                rect: toPage(char.bbox),
                ...(char.oriented
                  ? { oriented: orientedToPage(char.oriented) }
                  : {}),
                text: char.text,
              })),
            }
          : {}),
      };
    });
    const translated = segmented ? (translatedLines[group.paragraph] ?? "") : null;
    return {
      sourceRect,
      translationRect: translated
        ? buildTranslationRect(sourceRect, input.rect, translated)
        : sourceRect,
      angle,
      original: vertical
        ? group.texts.join("\n")
        : (originalLines[group.paragraph] ?? ""),
      translated,
      lines,
      vertical,
    };
  });
  // The combined box gathers paragraphs that may each be tilted their own way,
  // so it has no single frame to sit in and stays upright around all of them.
  const combinedSourceRect =
    paragraphs.length > 0
      ? unionRect(paragraphs.map((p) => rotatedBounds(p.sourceRect, p.angle)))
      : { ...input.rect };

  return {
    paragraphs,
    segmented,
    combinedRect: buildTranslationRect(
      combinedSourceRect,
      input.rect,
      input.translationText,
    ),
    combinedSourceRect,
    combinedTranslation: input.translationText,
  };
}

/** Shift every page-space rectangle after the anchored content reflows. */
export function moveOverlayLayout(
  layout: OverlayLayout,
  dx: number,
  dy: number,
): OverlayLayout {
  if (dx === 0 && dy === 0) {
    return layout;
  }
  const move = (rect: Rect): Rect => ({
    ...rect,
    x: rect.x + dx,
    y: rect.y + dy,
  });
  return {
    ...layout,
    paragraphs: layout.paragraphs.map((paragraph) => ({
      ...paragraph,
      sourceRect: move(paragraph.sourceRect),
      translationRect: move(paragraph.translationRect),
      lines: paragraph.lines.map((line) => ({
        ...line,
        rect: move(line.rect),
        ...(line.oriented
          ? { oriented: { ...line.oriented, rect: move(line.oriented.rect) } }
          : {}),
        ...(line.chars
          ? {
              chars: line.chars.map((char) => ({
                ...char,
                rect: move(char.rect),
                ...(char.oriented
                  ? { oriented: { ...char.oriented, rect: move(char.oriented.rect) } }
                  : {}),
              })),
            }
          : {}),
      })),
    })),
    combinedRect: move(layout.combinedRect),
    combinedSourceRect: move(layout.combinedSourceRect),
  };
}

// Painted translations only. A tall narrow column of CJK becomes a much longer
// run of Latin words, which will not fit the source box at a readable size, so
// the painted box is widened and re-centered inside the capture.
function buildTranslationRect(sourceRect: Rect, bounds: Rect, text: string): Rect {
  if (!shouldWidenVerticalTranslation(sourceRect, text)) {
    return sourceRect;
  }

  const width = Math.max(VERTICAL_TRANSLATION_MIN_WIDTH, sourceRect.width);
  const height = sourceRect.height;
  return fitRectNearBounds(
    {
      x: sourceRect.x + sourceRect.width / 2 - width / 2,
      y: sourceRect.y + sourceRect.height / 2 - height / 2,
      width,
      height,
    },
    bounds,
  );
}

function shouldWidenVerticalTranslation(sourceRect: Rect, text: string): boolean {
  return (
    sourceRect.height / Math.max(1, sourceRect.width) >=
      VERTICAL_TRANSLATION_ASPECT_RATIO && !isMostlyCjk(text)
  );
}

function fitRectNearBounds(rect: Rect, bounds: Rect): Rect {
  return {
    ...rect,
    x: fitAxis(rect.x, rect.width, bounds.x, bounds.width),
    y: fitAxis(rect.y, rect.height, bounds.y, bounds.height),
  };
}

function fitAxis(start: number, size: number, boundsStart: number, boundsSize: number): number {
  if (size > boundsSize) {
    return start;
  }
  const boundsEnd = boundsStart + boundsSize;
  return clamp(start, boundsStart, boundsEnd - size);
}

const CJK_CHAR = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;
const MEANINGFUL_CHAR = /[\p{L}\p{N}]/u;

// A CJK translation of a vertical column stays about as narrow as the source, so
// widening it would only push the text off the glyphs it belongs to.
function isMostlyCjk(text: string): boolean {
  let cjk = 0;
  let meaningful = 0;
  for (const ch of text) {
    if (!MEANINGFUL_CHAR.test(ch)) {
      continue;
    }
    meaningful++;
    if (CJK_CHAR.test(ch)) {
      cjk++;
    }
  }
  return meaningful > 0 && cjk / meaningful >= 0.5;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function unionRect(rects: Rect[]): Rect {
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.width));
  const maxY = Math.max(...rects.map((r) => r.y + r.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function positionOffset(position: string, availableSpace: number): number {
  switch (position) {
    case "left":
    case "top":
      return 0;
    case "center":
      return availableSpace / 2;
    case "right":
    case "bottom":
      return availableSpace;
  }

  const value = Number.parseFloat(position);
  if (!Number.isFinite(value)) {
    return availableSpace / 2;
  }
  return position.endsWith("%") ? availableSpace * (value / 100) : value;
}
