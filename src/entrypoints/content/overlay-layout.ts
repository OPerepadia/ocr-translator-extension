// Pure geometry/text mapping for the in-place overlay. No DOM: turns the OCR
// result (block bboxes in cropped-image pixels + the joined paragraph texts)
// into page-positioned boxes over the selection rect.

import type { OcrBlock, OcrChar, Rect } from "@/shared/types";

/** One detected OCR line of the source image: its text and where it sits on the
 * page. Used to lay an invisible, selectable copy of the original text over the
 * image glyphs, so selecting it highlights them. */
export interface OverlayLine {
  rect: Rect;
  text: string;
  /** True when this line reads top-to-bottom, from its paragraph. Per line
   * because one box can gather lines of both orientations (a manga page mixes
   * vertical bubbles with horizontal captions). */
  vertical: boolean;
  /** Per-character boxes over the page, when the recognizer located them. The
   * text layer then places one span per character instead of stretching the
   * whole line, so a selection lands on the right glyphs. */
  chars?: Array<{ rect: Rect; text: string }>;
}

export interface OverlayParagraph {
  /** Original OCR position over the page, in page CSS pixels. Anchors the frame
   * and its selectable text layer in the original view. */
  sourceRect: Rect;
  /** Position the translated text is painted at in the translation view. May be
   * wider than `sourceRect` for vertical source text. */
  translationRect: Rect;
  /** The recognized original text for this paragraph. For vertical paragraphs
   * the detected columns are separated by newlines, so the original view breaks
   * columns where the source image does. Display-only: the translation input
   * is the joined `ocrText` line, never this. */
  original: string;
  /** The translated line, or null when the translation could not be split per
   * paragraph (see `segmented`). */
  translated: string | null;
  /** The paragraph's detected lines, in reading order, positioned over the page
   * like `sourceRect`. */
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
  /** The whole translation, used by the fallback combined box. */
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
  /** Reading orientation reported by the OCR provider, when known. */
  orientation?: "horizontal" | "vertical";
}

const VERTICAL_TRANSLATION_ASPECT_RATIO = 2.0;
const VERTICAL_TRANSLATION_MIN_WIDTH = 120;

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
  /** Each block's own bbox, in the same order as `texts`. */
  lineBboxes: Rect[];
  /** Each block's character boxes, in the same order as `texts`. */
  lineChars: Array<OcrChar[] | undefined>;
  orientation?: "horizontal" | "vertical";
}> {
  const groups = new Map<
    number,
    {
      rects: Rect[];
      texts: string[];
      chars: Array<OcrChar[] | undefined>;
      orientation?: "horizontal" | "vertical";
    }
  >();
  blocks.forEach((block, index) => {
    // Fall back to a per-block key when paragraph is missing, offset past real
    // indices so it can't collide with a genuine paragraph 0.
    const key = block.paragraph ?? blocks.length + index;
    const group = groups.get(key);
    if (group) {
      group.rects.push(block.bbox);
      group.texts.push(block.text);
      group.chars.push(block.chars);
    } else {
      groups.set(key, {
        rects: [block.bbox],
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
  const paragraphs: OverlayParagraph[] = groups.map((group) => {
    const sourceRect = mapBboxToPage(
      group.bbox,
      input.imageWidth,
      input.imageHeight,
      input.rect,
    );
    const vertical = group.orientation
      ? group.orientation === "vertical"
      : defaultVertical;
    const toPage = (bbox: Rect): Rect =>
      mapBboxToPage(bbox, input.imageWidth, input.imageHeight, input.rect);
    const lines = group.lineBboxes.map((bbox, index) => {
      const chars = group.lineChars[index];
      return {
        rect: toPage(bbox),
        text: group.texts[index] ?? "",
        vertical,
        ...(chars
          ? {
              chars: chars.map((char) => ({
                rect: toPage(char.bbox),
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
      original: vertical
        ? group.texts.join("\n")
        : (originalLines[group.paragraph] ?? ""),
      translated,
      lines,
      vertical,
    };
  });
  const combinedSourceRect =
    paragraphs.length > 0
      ? unionRect(paragraphs.map((p) => p.sourceRect))
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

/** Shift a whole layout by the same delta, for when the page reflows under an
 * anchored capture. Every page-space rectangle moves, not just the ones on
 * screen: a rebuild (switching views) reads them all again, so any left behind
 * would put their box, or the text layer's spans inside it, back where the
 * capture was taken. */
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
        ...(line.chars
          ? {
              chars: line.chars.map((char) => ({
                ...char,
                rect: move(char.rect),
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
