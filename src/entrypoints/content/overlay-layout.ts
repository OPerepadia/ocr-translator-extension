// Pure geometry/text mapping for the in-place overlay. No DOM: turns the OCR
// result (block bboxes in cropped-image pixels + the joined paragraph texts)
// into page-positioned boxes over the selection rect.

import type { OcrBlock, OcrChar, OrientedRect, Rect } from "@/shared/types";
import { spreadText } from "./text-correction";

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
  /** The line of the recognized text this paragraph is. */
  line: number;
  /** The recognized original text for this paragraph, as sent for translation. */
  original: string;
  /** The translated line, or null when the translation could not be split per
   * paragraph (see `segmented`). */
  translated: string | null;
  lines: OverlayLine[];
  /** True when this paragraph's source text reads vertically; the original
   * view then renders it with a vertical writing mode. Per paragraph because a
   * capture can mix orientations (vertical columns plus a horizontal footer). */
  vertical: boolean;
  /** Typical thickness of the source lines in page pixels, roughly the source
   * font size. The painted translation aims for a font near it. */
  textSize: number;
  /** The room inside the paragraph's speech bubble, when one was found and is
   * wider than the source text. The painted card prefers to fill it; when the
   * translation does not fit, it may still use all of `translationRect`. */
  bubbleRoom?: Rect;
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
  /** `textSize` across all paragraphs, for the combined box. */
  combinedTextSize: number;
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

// Room a painted translation of vertical text may take. The card itself only
// grows as wide as its text needs.
const VERTICAL_TRANSLATION_MIN_WIDTH = 110;
// Space kept between painted cards that had to be moved apart.
const CARD_GAP = 2;
// Share of a bubble's box a translation may use. Bubbles are rounded, so the
// corners of their box are outside them.
const BUBBLE_ROOM_SHARE = 0.8;
const CARD_SEPARATION_PASSES = 8;
// Cards side by side may touch by a fraction of a pixel; an extended card may too.
const EXTEND_TOLERANCE = 1;
// A line only votes on tilt if it is clearly oblong, the same bar the OCR
// assembler sets for reading orientation.
const ANGLE_VOTE_MIN_ASPECT = 1.5;
const ANGLE_SNAP_RADIANS = (3 * Math.PI) / 180;

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
  bubble?: Rect;
}> {
  const groups = new Map<
    number,
    {
      rects: Rect[];
      oriented: OrientedRect[];
      texts: string[];
      chars: Array<OcrChar[] | undefined>;
      orientation?: "horizontal" | "vertical";
      bubble?: Rect;
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
        bubble: block.bubble,
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
      ...(group.bubble ? { bubble: group.bubble } : {}),
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

export function orientedCorners(oriented: OrientedRect): Array<{ x: number; y: number }> {
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

export function rotatePoint(
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
    const original = originalLines[group.paragraph] ?? "";
    // The user may have corrected the text since it was recognized.
    const pieces = group.texts.map((text, index) =>
      group.lineChars[index]?.length
        ? group.lineChars[index].map((char) => char.text)
        : Array.from(text),
    );
    const corrected =
      originalLines.length === paragraphLineCount
        ? spreadText(pieces, original)
        : pieces;
    const lines = group.lineBboxes.map((bbox, index) => {
      const chars = group.lineChars[index];
      return {
        rect: toPage(bbox),
        oriented: orientedLines[index],
        text: corrected[index].join(""),
        vertical,
        ...(chars
          ? {
              chars: chars.map((char, charIndex) => ({
                rect: toPage(char.bbox),
                ...(char.oriented
                  ? { oriented: orientedToPage(char.oriented) }
                  : {}),
                text: corrected[index][charIndex],
              })),
            }
          : {}),
      };
    });
    const translated = segmented ? (translatedLines[group.paragraph] ?? "") : null;
    // A tilted paragraph keeps the plain room: the bubble box is upright.
    const bubbleRoom =
      group.bubble && angle === 0
        ? buildBubbleRoom(toPage(group.bubble), sourceRect, input.rect)
        : undefined;
    const plainRoom = buildTranslationRect(sourceRect, input.rect, vertical);
    return {
      sourceRect,
      translationRect: !translated
        ? sourceRect
        : bubbleRoom
          ? unionRect([plainRoom, bubbleRoom])
          : plainRoom,
      angle,
      line: group.paragraph,
      original,
      translated,
      lines,
      vertical,
      textSize: medianLineThickness(orientedLines),
      ...(translated && bubbleRoom ? { bubbleRoom } : {}),
    };
  });
  // The combined box gathers paragraphs that may each be tilted their own way,
  // so it has no single frame to sit in and stays upright around all of them.
  const combinedSourceRect =
    paragraphs.length > 0
      ? unionRect(paragraphs.map((p) => rotatedBounds(p.sourceRect, p.angle)))
      : { ...input.rect };
  const combinedVertical =
    paragraphs.length > 0 && paragraphs.every((paragraph) => paragraph.vertical);

  return {
    paragraphs,
    segmented,
    combinedRect: buildTranslationRect(
      combinedSourceRect,
      input.rect,
      combinedVertical,
    ),
    combinedSourceRect,
    combinedTranslation: input.translationText,
    combinedTextSize: medianLineThickness(
      paragraphs.flatMap((paragraph) =>
        paragraph.lines.flatMap((line) => (line.oriented ? [line.oriented] : [])),
      ),
    ),
  };
}

/** The median short side of the lines' tilted boxes: the line's thickness
 * whichever way it runs. Zero when there are no lines. */
export function medianLineThickness(lines: OrientedRect[]): number {
  const sizes = lines
    .map((line) => Math.min(line.rect.width, line.rect.height))
    .sort((a, b) => a - b);
  if (sizes.length === 0) {
    return 0;
  }
  const middle = Math.floor(sizes.length / 2);
  return sizes.length % 2 === 1
    ? sizes[middle]
    : (sizes[middle - 1] + sizes[middle]) / 2;
}

export interface CardPlacement {
  /** The card's current box. */
  rect: Rect;
  /** Where the card's centre may move to, so it stays over its source text. */
  slide: Rect;
}

/** Move overlapping cards apart. Each pair is pushed along the axis that frees
 * it with the shorter move, as far as their slide areas and `bounds` allow.
 * Overlaps that no move can clear are reduced as much as possible. */
export function separateCards(cards: CardPlacement[], bounds?: Rect): Rect[] {
  const rects = cards.map((card) => ({ ...card.rect }));
  for (let pass = 0; pass < CARD_SEPARATION_PASSES; pass++) {
    let moved = false;
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        if (pushApart(rects, cards, i, j, bounds)) {
          moved = true;
        }
      }
    }
    if (!moved) {
      break;
    }
  }
  return rects;
}

type Axis = "x" | "y";

function pushApart(
  rects: Rect[],
  cards: CardPlacement[],
  i: number,
  j: number,
  bounds: Rect | undefined,
): boolean {
  const a = rects[i];
  const b = rects[j];
  const plans = (["x", "y"] as Axis[])
    .map((axis) => {
      const size = axis === "x" ? "width" : "height";
      const need =
        Math.min(a[axis] + a[size], b[axis] + b[size]) -
        Math.max(a[axis], b[axis]) +
        CARD_GAP;
      // The card whose centre comes first moves back, the other forward.
      const aFirst = a[axis] + a[size] / 2 <= b[axis] + b[size] / 2;
      const roomA = moveRoom(a, cards[i].slide, bounds, axis, aFirst ? -1 : 1);
      const roomB = moveRoom(b, cards[j].slide, bounds, axis, aFirst ? 1 : -1);
      return { axis, need, aFirst, roomA, roomB };
    });
  // Not touching on either axis: nothing to do.
  if (plans.some((plan) => plan.need <= CARD_GAP)) {
    return false;
  }
  const solvable = plans.filter((plan) => plan.roomA + plan.roomB >= plan.need);
  const plan =
    solvable.length > 0
      ? solvable.reduce((best, next) => (next.need < best.need ? next : best))
      : plans.reduce((best, next) =>
          (next.roomA + next.roomB) / next.need >
          (best.roomA + best.roomB) / best.need
            ? next
            : best,
        );
  // Share the move, letting one card take more when the other is blocked.
  const moveA = Math.min(plan.roomA, Math.max(plan.need / 2, plan.need - plan.roomB));
  const moveB = Math.min(plan.roomB, plan.need - moveA);
  if (moveA + moveB < 0.5) {
    return false;
  }
  const sign = plan.aFirst ? -1 : 1;
  rects[i] = { ...a, [plan.axis]: a[plan.axis] + sign * moveA };
  rects[j] = { ...b, [plan.axis]: b[plan.axis] - sign * moveB };
  return true;
}

/** How far a card can move along one axis before its centre leaves its slide
 * area or its edge leaves `bounds`. */
function moveRoom(
  rect: Rect,
  slide: Rect,
  bounds: Rect | undefined,
  axis: Axis,
  direction: -1 | 1,
): number {
  const size = axis === "x" ? "width" : "height";
  const center = rect[axis] + rect[size] / 2;
  let low = slide[axis];
  let high = slide[axis] + slide[size];
  // A card larger than the bounds cannot be kept inside them anyway.
  if (bounds && rect[size] <= bounds[size]) {
    low = Math.max(low, bounds[axis] + rect[size] / 2);
    high = Math.min(high, bounds[axis] + bounds[size] - rect[size] / 2);
  }
  const room = direction < 0 ? center - low : high - center;
  return Math.max(0, room);
}

/** The card extended over `cover`, stopped at the edges of other cards. Undefined
 * if it cannot grow without reaching over one. */
export function extendCard(cards: Rect[], index: number, cover: Rect): Rect | undefined {
  const card = cards[index];
  let extended = unionRect([card, cover]);
  for (const [otherIndex, rect] of cards.entries()) {
    const other = growRect(rect, -EXTEND_TOLERANCE);
    if (otherIndex === index || !intersectRect(extended, other)) {
      continue;
    }
    // Pull back one side to the other card's edge, but not past the card itself;
    // keep the choice that loses the least.
    const { x, y } = extended;
    const right = x + extended.width;
    const bottom = y + extended.height;
    const left = Math.min(other.x + other.width, card.x);
    const top = Math.min(other.y + other.height, card.y);
    const newRight = Math.max(other.x, card.x + card.width);
    const newBottom = Math.max(other.y, card.y + card.height);
    const options = [
      { x: left, y, width: right - left, height: extended.height },
      { x, y: top, width: extended.width, height: bottom - top },
      { x, y, width: newRight - x, height: extended.height },
      { x, y, width: extended.width, height: newBottom - y },
    ].filter((option) => !intersectRect(option, other));
    if (!options.length) {
      return undefined;
    }
    extended = options.reduce((best, option) =>
      option.width * option.height > best.width * best.height ? option : best);
  }
  return extended;
}

export function growRect(rect: Rect, by: number): Rect {
  return {
    x: rect.x - by,
    y: rect.y - by,
    width: rect.width + 2 * by,
    height: rect.height + 2 * by,
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
      ...(paragraph.bubbleRoom
        ? { bubbleRoom: move(paragraph.bubbleRoom) }
        : {}),
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

/** The room inside a speech bubble: the middle of its box, grown to cover the
 * source text and cut to the capture. Undefined when the bubble does not
 * reach past the source text, so there is no room to gain. */
export function buildBubbleRoom(
  bubble: Rect,
  sourceRect: Rect,
  bounds: Rect,
): Rect | undefined {
  const width = bubble.width * BUBBLE_ROOM_SHARE;
  const height = bubble.height * BUBBLE_ROOM_SHARE;
  const inner = {
    x: bubble.x + (bubble.width - width) / 2,
    y: bubble.y + (bubble.height - height) / 2,
    width,
    height,
  };
  const room = intersectRect(unionRect([inner, sourceRect]), bounds);
  if (!room || room.width <= sourceRect.width) {
    return undefined;
  }
  return room;
}

export function intersectRect(a: Rect, b: Rect): Rect | undefined {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) {
    return undefined;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

// Painted translations only. Translated vertical text gets more horizontal
// room and is re-centered in the capture.
function buildTranslationRect(
  sourceRect: Rect,
  bounds: Rect,
  vertical: boolean,
): Rect {
  if (!vertical) {
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

/** Shift `rect` inside `bounds` on each axis where it fits. */
export function fitRectNearBounds(rect: Rect, bounds: Rect): Rect {
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
