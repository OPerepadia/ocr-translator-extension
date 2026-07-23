// Pure geometry/text mapping for the in-place overlay. No DOM: turns the OCR
// result (block bboxes in cropped-image pixels + the joined paragraph texts)
// into page-positioned boxes over the selection rect.

import type { OcrBlock, Rect } from "@/shared/types";

export interface OverlayParagraph {
  /** Original OCR position over the page, in page CSS pixels. */
  sourceRect: Rect;
  /** Position used for translated text. May be wider for vertical source text. */
  translationRect: Rect;
  /** The recognized original text for this paragraph. For vertical paragraphs
   * the detected columns are separated by newlines, so the original view breaks
   * columns where the source image does. Display-only: the translation input
   * is the joined `ocrText` line, never this. */
  original: string;
  /** The translated line, or null when the translation could not be split per
   * paragraph (see `segmented`). */
  translated: string | null;
  backgroundTone: "light" | "dark";
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
  /** The fallback box for the unsegmented translation case. */
  combinedRect: Rect;
  /** The whole translation, used by the fallback combined box. */
  combinedTranslation: string;
  combinedBackgroundTone: "light" | "dark";
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
  orientation?: "horizontal" | "vertical";
  backgroundTone?: "light" | "dark";
}> {
  const groups = new Map<
    number,
    {
      rects: Rect[];
      texts: string[];
      orientation?: "horizontal" | "vertical";
      tones: Array<{ tone: "light" | "dark"; area: number }>;
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
      if (block.backgroundTone) {
        group.tones.push({
          tone: block.backgroundTone,
          area: block.bbox.width * block.bbox.height,
        });
      }
    } else {
      groups.set(key, {
        rects: [block.bbox],
        texts: [block.text],
        orientation: block.orientation,
        tones: block.backgroundTone
          ? [{ tone: block.backgroundTone, area: block.bbox.width * block.bbox.height }]
          : [],
      });
    }
  });

  return [...groups.entries()]
    .map(([paragraph, group]) => {
      const backgroundTone = dominantTone(group.tones);
      return {
        paragraph,
        bbox: unionRect(group.rects),
        texts: group.texts,
        orientation: group.orientation,
        ...(backgroundTone ? { backgroundTone } : {}),
      };
    })
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
    const translated = segmented ? (translatedLines[group.paragraph] ?? "") : null;
    const vertical = group.orientation
      ? group.orientation === "vertical"
      : defaultVertical;
    return {
      sourceRect,
      translationRect: translated
        ? buildTranslationRect(sourceRect, input.rect, translated)
        : sourceRect,
      original: vertical
        ? group.texts.join("\n")
        : (originalLines[group.paragraph] ?? ""),
      translated,
      backgroundTone: group.backgroundTone ?? "light",
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
    combinedTranslation: input.translationText,
    combinedBackgroundTone:
      dominantTone(
        paragraphs.map((paragraph) => ({
          tone: paragraph.backgroundTone,
          area: paragraph.sourceRect.width * paragraph.sourceRect.height,
        })),
      ) ?? "light",
  };
}

function dominantTone(
  tones: Array<{ tone: "light" | "dark"; area: number }>,
): "light" | "dark" | undefined {
  if (tones.length === 0) {
    return undefined;
  }
  const balance = tones.reduce(
    (sum, item) => sum + (item.tone === "light" ? item.area : -item.area),
    0,
  );
  return balance >= 0 ? "light" : "dark";
}

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

function unionRect(rects: Rect[]): Rect {
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.width));
  const maxY = Math.max(...rects.map((r) => r.y + r.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
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
