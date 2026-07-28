// Assemble recognized text lines into an OcrResult. Pure TypeScript.

import type {
  OcrBlock,
  OcrChar,
  PipelineOcrResult,
  Rect,
} from "../../../shared/types";

export interface RecognizedLine {
  bbox: Rect;
  text: string;
  confidence: number;
  chars?: OcrChar[];
}

export interface AssembleOptions {
  backend?: string;
  direction?: "ltr" | "rtl";
}

export const LOW_CONFIDENCE_FILTER_THRESHOLD = 0.7;

// Paragraph grouping reads the statistics of the vertical gaps between
// consecutive lines: a break is declared when a gap is much larger than the
// page's typical line spacing (estimated from the gaps themselves), or when a
// line's height, left edge, or list shape changes. All distances are in units
// of the median line height, so the thresholds are font-size independent.
const HEIGHT_TOLERANCE = 0.4;
// A gap wider than this many line heights always breaks, even before a line
// rhythm can be estimated (e.g. only two lines on the page).
const ABSOLUTE_BREAK_RATIO = 1.5;
// A paragraph break sits at least this many line heights above the body rhythm.
const GAP_BREAK_MARGIN = 1.5;
// Low percentile of the gaps taken as the body line spacing — low so that the
// paragraph-break gaps mixed into the sample don't inflate the estimate.
const BODY_GAP_PERCENTILE = 0.3;
const EDGE_ALIGNMENT_TOLERANCE = 0.6;
const LIST_ITEM_BREAK_GAP_RATIO = 0.8;
const MAX_LIST_ITEM_WORD_COUNT = 4;
// A horizontal gap wider than this many median line heights reads as a gutter
// between side-by-side text groups (e.g. image captions or speech bubbles)
// rather than a space within a line.
const COLUMN_GUTTER_RATIO = 1.5;

// Vertical (CJK top-to-bottom, columns right-to-left) layout tuning.
// A box only votes on orientation if it is clearly oblong; near-square boxes
// (single glyphs, logos) have no reliable long axis and abstain.
const READING_ORIENTATION_MIN_ASPECT = 1.5;
// Block clustering margin, in units of column width. Each box is grown by this
// margin and overlapping boxes form one block, so the effective gate is twice
// it (~0.8 column widths). Sized between the negative gap of columns within one
// speech bubble (they overlap in x) and the real gap between separate bubbles
// (~1+ column widths apart in the manga samples).
const VERTICAL_BLOCK_MARGIN_FACTOR = 0.4;
// Two boxes count as the same column (ordered top-to-bottom rather than as
// separate columns) when their centre-x is within this fraction of a column.
const VERTICAL_COLUMN_TOLERANCE_FACTOR = 0.5;

/** A visual row: one or more boxes whose vertical centres overlap, merged
 * left-to-right. The paragraph grouper treats each row as one line. */
interface Row {
  bbox: Rect;
  text: string;
  members: RecognizedLine[];
}

/** Order detected lines into reading order, group them into blocks, and join
 * each block's lines into full sentences for translation.
 *
 * Horizontal text is grouped into paragraphs (lines joined with spaces, or
 * nothing between CJK characters; hyphen-split words reassembled). Vertical CJK
 * text is grouped into blocks (e.g. speech bubbles), columns read right-to-left.
 * Blocks are separated by a newline, and `blocks` carry their block index. */
export function assembleResult(
  lines: RecognizedLine[],
  options: AssembleOptions = {},
): PipelineOcrResult {
  const nonEmpty = lines.filter((line) => line.text.trim().length > 0);
  const filtered = filterLowConfidenceLines(nonEmpty);
  const vertical = isVerticalLayout(filtered);
  return vertical
    ? assembleVertical(filtered, options)
    : assembleHorizontal(filtered, options);
}

function filterLowConfidenceLines(lines: RecognizedLine[]): RecognizedLine[] {
  return lines.filter(
    (line) => line.confidence >= LOW_CONFIDENCE_FILTER_THRESHOLD,
  );
}

function assembleHorizontal(
  nonEmpty: RecognizedLine[],
  options: AssembleOptions,
): PipelineOcrResult {
  const rtl = options.direction === "rtl";
  // Split side-by-side columns first, then group rows/paragraphs within each so
  // a line in one column never joins a line in another at the same height.
  const columns = splitIntoColumns(nonEmpty, rtl);

  const blocks: OcrBlock[] = [];
  const paragraphTexts: string[] = [];
  let paragraphIndex = 0;
  for (const column of columns) {
    const ordered = column
      .slice()
      .sort((a, b) => centerY(a.bbox) - centerY(b.bbox));
    const paragraphs = groupRowsIntoParagraphs(buildRows(ordered, rtl), rtl);
    for (const paragraph of paragraphs) {
      let text = "";
      for (const row of paragraph) {
        text = joinAcrossLineBreak(text, row.text);
        for (const member of row.members) {
          blocks.push({
            text: member.text,
            bbox: member.bbox,
            ...(member.chars ? { chars: member.chars } : {}),
            confidence: member.confidence,
            paragraph: paragraphIndex,
          });
        }
      }
      paragraphTexts.push(text);
      paragraphIndex++;
    }
  }

  return buildResult(paragraphTexts, blocks, options, "horizontal");
}

/** Cluster lines into local horizontal reading groups, ordered top-to-bottom and
 * in reading direction within a row. Lines must be close both horizontally and
 * vertically to connect, so unrelated text lower on the page cannot bridge two
 * separate speech bubbles. */
function splitIntoColumns(
  lines: RecognizedLine[],
  rtl: boolean,
): RecognizedLine[][] {
  if (lines.length < 2) {
    return [lines];
  }
  const scale = median(lines.map((l) => l.bbox.height));
  const gutter = COLUMN_GUTTER_RATIO * scale;
  const maxVerticalGap = ABSOLUTE_BREAK_RATIO * scale;

  const groups = clusterLines(
    lines,
    (a, b) =>
      horizontalGap(a.bbox, b.bbox) < gutter &&
      verticalGap(a.bbox, b.bbox) <= maxVerticalGap,
  );

  return groups.sort((a, b) => {
    const topDiff = topEdge(a) - topEdge(b);
    if (Math.abs(topDiff) > scale) return topDiff;
    return rtl ? rightEdge(b) - rightEdge(a) : leftEdge(a) - leftEdge(b);
  });
}

/** Signed horizontal gap between two boxes: negative when their x-ranges
 * overlap, the empty space between them when they don't. */
function horizontalGap(a: Rect, b: Rect): number {
  return Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
}

/** Signed vertical gap between two boxes: negative when their y-ranges overlap. */
function verticalGap(a: Rect, b: Rect): number {
  return Math.max(b.y - bottom(a), a.y - bottom(b));
}

function leftEdge(lines: RecognizedLine[]): number {
  return Math.min(...lines.map((l) => l.bbox.x));
}

function rightEdge(lines: RecognizedLine[]): number {
  return Math.max(...lines.map((l) => l.bbox.x + l.bbox.width));
}

function topEdge(lines: RecognizedLine[]): number {
  return Math.min(...lines.map((l) => l.bbox.y));
}

/** Group vertical CJK boxes into blocks and read each block's columns
 * right-to-left, top-to-bottom. The detector returns each column as one box
 * (verified on manga/anime samples), so no per-character assembly is needed —
 * the work is clustering boxes into blocks and ordering them. A block that is
 * itself horizontal (e.g. a copyright footer under a vertical tagline) is read
 * left-to-right instead. */
function assembleVertical(
  nonEmpty: RecognizedLine[],
  options: AssembleOptions,
): PipelineOcrResult {
  const verticalBoxes = nonEmpty.filter((l) => l.bbox.height > l.bbox.width);
  const widthSource = verticalBoxes.length > 0 ? verticalBoxes : nonEmpty;
  const columnWidth = median(widthSource.map((l) => l.bbox.width));
  const band = median(widthSource.map((l) => l.bbox.height));
  const margin = VERTICAL_BLOCK_MARGIN_FACTOR * columnWidth;
  const columnTolerance = VERTICAL_COLUMN_TOLERANCE_FACTOR * columnWidth;

  const orderedBlocks = clusterBlocks(nonEmpty, margin)
    .map((block) => {
      // Blocks where every box abstains (near-square) follow the page's
      // vertical layout.
      const orientation = orientationVote(block) ?? "vertical";
      const lines =
        orientation === "vertical"
          ? orderColumns(block, columnTolerance)
          : orderRows(block);
      return { lines, orientation };
    })
    .sort((a, b) => {
      const ca = blockCentroid(a.lines);
      const cb = blockCentroid(b.lines);
      const rowA = Math.round(ca.y / band);
      const rowB = Math.round(cb.y / band);
      if (rowA !== rowB) return rowA - rowB; // top band first
      return cb.x - ca.x; // right-to-left within a band
    });

  const blocks: OcrBlock[] = [];
  const blockTexts: string[] = [];
  orderedBlocks.forEach((block, blockIndex) => {
    blockTexts.push(joinCjkAware(block.lines.map((l) => l.text)));
    for (const member of block.lines) {
      blocks.push({
        text: member.text,
        bbox: member.bbox,
        ...(member.chars ? { chars: member.chars } : {}),
        confidence: member.confidence,
        paragraph: blockIndex,
        orientation: block.orientation,
      });
    }
  });

  return buildResult(blockTexts, blocks, options, "vertical");
}

/** Order a block's boxes in horizontal reading order: rows top-to-bottom,
 * left-to-right within a row. */
function orderRows(block: RecognizedLine[]): RecognizedLine[] {
  const ordered = block
    .slice()
    .sort((a, b) => centerY(a.bbox) - centerY(b.bbox));
  return buildRows(ordered, false).flatMap((row) => row.members);
}

function buildResult(
  blockTexts: string[],
  blocks: OcrBlock[],
  options: AssembleOptions,
  orientation: "horizontal" | "vertical",
): PipelineOcrResult {
  const confidence =
    blocks.length === 0
      ? 0
      : blocks.reduce((sum, block) => sum + (block.confidence ?? 0), 0) /
        blocks.length;
  return {
    text: blockTexts.join("\n"),
    blocks,
    // PP-OCR does not detect language; leave it for the pipeline to fall back
    // to the requested source language.
    lang: undefined,
    confidence,
    orientation,
    providerMeta: { backend: options.backend, boxes: blocks.length, orientation },
  };
}

/** Cluster vertically-overlapping boxes into rows, each merged in reading order. */
function buildRows(ordered: RecognizedLine[], rtl: boolean): Row[] {
  const grouped: RecognizedLine[][] = [];
  for (const line of ordered) {
    const row = grouped[grouped.length - 1];
    if (row && sameRow(row[row.length - 1], line)) {
      row.push(line);
    } else {
      grouped.push([line]);
    }
  }

  return grouped.map((members) => {
    members.sort((a, b) =>
      rtl ? b.bbox.x - a.bbox.x : a.bbox.x - b.bbox.x,
    );
    return {
      bbox: unionRect(members.map((m) => m.bbox)),
      text: joinCjkAware(members.map((m) => m.text)),
      members,
    };
  });
}

/** Split rows (already in top-to-bottom order) into paragraphs. The gap
 * threshold is derived once from the page's own line spacing, then each row is
 * compared to the one above it. */
function groupRowsIntoParagraphs(rows: Row[], rtl: boolean): Row[][] {
  if (rows.length === 0) return [];
  const scale = median(rows.map((r) => r.bbox.height));
  const breakRatio = paragraphBreakRatio(rows, scale);

  const paragraphs: Row[][] = [[rows[0]]];
  for (let i = 1; i < rows.length; i++) {
    if (startsNewParagraph(rows[i - 1], rows[i], scale, breakRatio, rtl)) {
      paragraphs.push([rows[i]]);
    } else {
      paragraphs[paragraphs.length - 1].push(rows[i]);
    }
  }
  return paragraphs;
}

/** Gap (in line heights) above which a vertical gap means a paragraph break.
 * The body line spacing is estimated from a low percentile of the gaps so that
 * the break gaps themselves don't pull the estimate up. With too few lines to
 * estimate a rhythm, fall back to the absolute floor. */
function paragraphBreakRatio(rows: Row[], scale: number): number {
  const gapRatios: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    gapRatios.push((rows[i].bbox.y - bottom(rows[i - 1].bbox)) / scale);
  }
  if (gapRatios.length < 2) return ABSOLUTE_BREAK_RATIO;
  const bodyGap = percentile(gapRatios, BODY_GAP_PERCENTILE);
  return Math.max(ABSOLUTE_BREAK_RATIO, bodyGap + GAP_BREAK_MARGIN);
}

/** Whether `cur` opens a new paragraph relative to the line `prev` above it. */
function startsNewParagraph(
  prev: Row,
  cur: Row,
  scale: number,
  breakRatio: number,
  rtl: boolean,
): boolean {
  const gapRatio = (cur.bbox.y - bottom(prev.bbox)) / scale;
  if (gapRatio > ABSOLUTE_BREAK_RATIO) return true;
  if (gapRatio > breakRatio) return true;

  // Height step: a heading or a differently-sized line starts a new block.
  const big = Math.max(cur.bbox.height, prev.bbox.height);
  const small = Math.max(1, Math.min(cur.bbox.height, prev.bbox.height));
  if (big / small - 1 > HEIGHT_TOLERANCE) return true;

  const edgeShift = rtl
    ? right(prev.bbox) - right(cur.bbox)
    : cur.bbox.x - prev.bbox.x;
  const centerShift = rtl
    ? centerX(prev.bbox) - centerX(cur.bbox)
    : centerX(cur.bbox) - centerX(prev.bbox);
  if (
    edgeShift > EDGE_ALIGNMENT_TOLERANCE * scale &&
    centerShift > EDGE_ALIGNMENT_TOLERANCE * scale
  ) {
    return true;
  }

  // A short line starting with a capital or digit, set off by a wider-than-body
  // gap, is a fresh list/menu item.
  const wordCount = cur.text.split(/\s+/).filter(Boolean).length;
  if (
    startsWithBreakSignal(cur.text) &&
    wordCount <= MAX_LIST_ITEM_WORD_COUNT &&
    gapRatio > LIST_ITEM_BREAK_GAP_RATIO
  ) {
    return true;
  }

  // An explicit list marker (bullet glyph, "1.", "a)") is a definitive item
  // start; wrapped continuation lines never carry one.
  return startsWithListMarker(cur.text);
}

function centerY(rect: Rect): number {
  return rect.y + rect.height / 2;
}

function centerX(rect: Rect): number {
  return rect.x + rect.width / 2;
}

function bottom(rect: Rect): number {
  return rect.y + rect.height;
}

function right(rect: Rect): number {
  return rect.x + rect.width;
}

function median(values: number[]): number {
  if (values.length === 0) return 1;
  const sorted = values.slice().sort((a, b) => a - b);
  return Math.max(1, sorted[sorted.length >> 1]);
}

/** Value at percentile `p` (0..1) of `values`. Unlike `median` it does not
 * clamp, so it works on signed gaps. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * (sorted.length - 1))),
  );
  return sorted[index];
}

/** A single box's reading orientation from its aspect ratio, or undefined when
 * it is too near-square to vote (single glyphs, logos, decorative marks). */
function readingOrientation(
  rect: Rect,
): "horizontal" | "vertical" | undefined {
  const w = Math.max(1, rect.width);
  const h = Math.max(1, rect.height);
  if (Math.max(w, h) / Math.min(w, h) < READING_ORIENTATION_MIN_ASPECT) {
    return undefined;
  }
  return h > w ? "vertical" : "horizontal";
}

/** Length-weighted vote over box aspect ratios: do the boxes read vertically?
 * The detector fuses a vertical column into one tall box and a horizontal line
 * into a wide one, so the box shapes carry the answer. Weighting by long-axis
 * length keeps one long body column from being outvoted by short scraps.
 * Undefined when every box abstains (all near-square). */
function orientationVote(
  lines: RecognizedLine[],
): "horizontal" | "vertical" | undefined {
  let vertical = 0;
  let horizontal = 0;
  for (const line of lines) {
    const orientation = readingOrientation(line.bbox);
    if (!orientation) continue;
    const long = Math.max(line.bbox.width, line.bbox.height);
    if (orientation === "vertical") vertical += long;
    else horizontal += long;
  }
  if (vertical === 0 && horizontal === 0) return undefined;
  return vertical > horizontal ? "vertical" : "horizontal";
}

function isVerticalLayout(lines: RecognizedLine[]): boolean {
  return orientationVote(lines) === "vertical";
}

/** Cluster boxes into blocks (e.g. speech bubbles): grow each box by `margin`
 * and union any that overlap, so columns of one bubble group together while
 * separate bubbles stay apart. */
function clusterBlocks(
  lines: RecognizedLine[],
  margin: number,
): RecognizedLine[][] {
  return clusterLines(lines, (a, b) => rectsTouch(a.bbox, b.bbox, margin));
}

/** Group boxes into clusters: two boxes join when `connected` reports them as
 * neighbours. The caller defines what "neighbour" means, so one routine serves
 * both clustering paths (overlapping blocks, and side-by-side columns).
 *
 * The one constraint: a cluster never mixes reading orientations. A merge that
 * would put a vertical box and a horizontal box together is rejected. A
 * near-square box has no orientation of its own — it may join either side, but
 * can never bridge a vertical cluster to a horizontal one.
 *
 * Union-find over O(n^2) pairs; n (the box count) is small. */
function clusterLines(
  lines: RecognizedLine[],
  connected: (a: RecognizedLine, b: RecognizedLine) => boolean,
): RecognizedLine[][] {
  const parent = lines.map((_, i) => i);
  // Per-cluster orientation flags, kept up to date on the cluster root.
  const vertical = lines.map((l) => readingOrientation(l.bbox) === "vertical");
  const horizontal = lines.map(
    (l) => readingOrientation(l.bbox) === "horizontal",
  );
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if ((vertical[ra] || vertical[rb]) && (horizontal[ra] || horizontal[rb])) {
      return; // merging would mix reading orientations
    }
    parent[ra] = rb;
    vertical[rb] = vertical[ra] || vertical[rb];
    horizontal[rb] = horizontal[ra] || horizontal[rb];
  };

  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (connected(lines[i], lines[j])) union(i, j);
    }
  }

  const groups = new Map<number, RecognizedLine[]>();
  lines.forEach((line, i) => {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(line);
    else groups.set(root, [line]);
  });
  return [...groups.values()];
}

/** Whether two boxes intersect once both are grown outward by `margin`. */
function rectsTouch(a: Rect, b: Rect, margin: number): boolean {
  return (
    a.x - margin < b.x + b.width + margin &&
    b.x - margin < a.x + a.width + margin &&
    a.y - margin < b.y + b.height + margin &&
    b.y - margin < a.y + a.height + margin
  );
}

/** Order a block's boxes in vertical reading order: columns right-to-left,
 * boxes within a column top-to-bottom. */
function orderColumns(
  block: RecognizedLine[],
  columnTolerance: number,
): RecognizedLine[] {
  return block.slice().sort((a, b) => {
    const ax = centerX(a.bbox);
    const bx = centerX(b.bbox);
    if (Math.abs(ax - bx) > columnTolerance) return bx - ax; // right-to-left
    return centerY(a.bbox) - centerY(b.bbox); // top-to-bottom within a column
  });
}

function blockCentroid(block: RecognizedLine[]): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const line of block) {
    x += centerX(line.bbox);
    y += centerY(line.bbox);
  }
  return { x: x / block.length, y: y / block.length };
}

function sameRow(a: RecognizedLine, b: RecognizedLine): boolean {
  const tolerance = 0.5 * Math.min(a.bbox.height, b.bbox.height);
  return Math.abs(centerY(a.bbox) - centerY(b.bbox)) < tolerance;
}

function unionRect(rects: Rect[]): Rect {
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.width));
  const maxY = Math.max(...rects.map((r) => r.y + r.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Concatenate text fragments (row members or vertical columns) in order. No
 * space between adjacent CJK characters; a space elsewhere. */
function joinCjkAware(texts: string[]): string {
  return texts.reduce((acc, text) => {
    if (acc.length === 0) return text;
    if (text.length === 0) return acc;
    const sep = isCjkChar(acc[acc.length - 1]) && isCjkChar(text[0]) ? "" : " ";
    return acc + sep + text;
  }, "");
}

/** Append the next line of a paragraph. Reassembles a hyphen-split word
 * ("exam-" + "ple" -> "example"); otherwise joins with a space, or nothing
 * when both sides of the break are CJK. */
function joinAcrossLineBreak(acc: string, next: string): string {
  if (acc.length === 0) return next;
  if (next.length === 0) return acc;
  const prevChar = acc[acc.length - 1];
  if (prevChar === "-" && acc.length >= 2 && isWordChar(acc[acc.length - 2])) {
    return acc.slice(0, -1) + next;
  }
  const sep = isCjkChar(prevChar) && isCjkChar(next[0]) ? "" : " ";
  return acc + sep + next;
}

/** Han, Hiragana, Katakana, or Hangul — scripts written without spaces between
 * words. Uses Unicode script properties; fullwidth ASCII (script Latin/Common)
 * does not match, so half-width ASCII surrogates are not mistaken for CJK. */
const CJK_CHAR = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;
function isCjkChar(ch: string): boolean {
  return ch.length > 0 && CJK_CHAR.test(ch);
}

function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

/** True when the first character is a digit or an uppercase letter — the head
 * of a likely list/menu item. CJK characters have no case, so they abstain. */
function startsWithBreakSignal(text: string): boolean {
  const first = text.trimStart()[0];
  if (!first) return false;
  if (/[0-9]/.test(first)) return true;
  if (!/\p{L}/u.test(first)) return false;
  return first === first.toUpperCase() && first !== first.toLowerCase();
}

/** True when the row opens with an explicit list marker: a bullet glyph, or an
 * enumerator like "1.", "12)", "a)". `-` is deliberately excluded — it clashes
 * with hyphenation and with sub-detail lines meant to stay glued to their item. */
function startsWithListMarker(text: string): boolean {
  const t = text.trimStart();
  if (/^[•●◦▪‣∙·*]/u.test(t)) return true;
  return /^(?:\d{1,3}|[a-z])[.)]\s/iu.test(t);
}
