// Assemble recognized text lines into an OcrResult. Pure TypeScript.

import type {
  OcrBlock,
  OcrChar,
  OrientedRect,
  PipelineOcrResult,
  Rect,
} from "../../../shared/types";

export interface RecognizedLine {
  bbox: Rect;
  /** The line's reading frame, used for orientation and overlay placement. */
  oriented?: OrientedRect;
  text: string;
  confidence: number;
  chars?: OcrChar[];
}

export interface AssembleOptions {
  backend?: string;
  direction?: "ltr" | "rtl";
}

export const LOW_CONFIDENCE_FILTER_THRESHOLD = 0.7;

// A box only votes on orientation if it is clearly oblong; near-square boxes
// (single glyphs, logos) have no reliable long axis and abstain.
const READING_ORIENTATION_MIN_ASPECT = 1.5;
// Two boxes count as the same column (ordered top-to-bottom rather than as
// separate columns) when their centre-x is within this fraction of a column.
const VERTICAL_COLUMN_TOLERANCE_FACTOR = 0.5;

/** A visual row: one or more boxes whose vertical centres overlap. */
interface Row {
  bbox: Rect;
  text: string;
  members: RecognizedLine[];
}

export function filterRecognizedLines(
  lines: RecognizedLine[],
): RecognizedLine[] {
  return lines.filter(
    (line) =>
      line.text.trim().length > 0 &&
      line.confidence >= LOW_CONFIDENCE_FILTER_THRESHOLD,
  );
}

export function assembleGroupedResult(
  groups: RecognizedLine[][],
  options: AssembleOptions = {},
): PipelineOcrResult {
  const filteredGroups = groups
    .map((group) => filterRecognizedLines(group))
    .filter((group) => group.length > 0);
  const allLines = filteredGroups.flat();
  const pageOrientation = isVerticalLayout(allLines)
    ? "vertical"
    : "horizontal";
  const rtl = options.direction === "rtl";
  const scale = median(allLines.map((line) => line.bbox.height));
  const orderedGroups = filteredGroups
    .map((group) => orderLearnedGroup(group, pageOrientation, rtl))
    .sort((a, b) => {
      if (pageOrientation === "vertical") {
        const band = Math.max(1, scale);
        const aCenter = blockCentroid(a.lines);
        const bCenter = blockCentroid(b.lines);
        const rowDifference =
          Math.round(aCenter.y / band) - Math.round(bCenter.y / band);
        return rowDifference || bCenter.x - aCenter.x;
      }
      const topDifference = topEdge(a.lines) - topEdge(b.lines);
      if (Math.abs(topDifference) > scale) return topDifference;
      return rtl
        ? rightEdge(b.lines) - rightEdge(a.lines)
        : leftEdge(a.lines) - leftEdge(b.lines);
    });

  const blocks: OcrBlock[] = [];
  orderedGroups.forEach((group, paragraph) => {
    for (const line of group.lines) {
      blocks.push({
        text: line.text,
        bbox: line.bbox,
        ...(line.oriented ? { oriented: line.oriented } : {}),
        ...(line.chars ? { chars: line.chars } : {}),
        confidence: line.confidence,
        paragraph,
        orientation: group.orientation,
      });
    }
  });
  return buildResult(
    orderedGroups.map((group) => group.text),
    blocks,
    options,
    pageOrientation,
  );
}

function orderLearnedGroup(
  group: RecognizedLine[],
  pageOrientation: "horizontal" | "vertical",
  rtl: boolean,
): {
  lines: RecognizedLine[];
  text: string;
  orientation: "horizontal" | "vertical";
} {
  const orientation = orientationVote(group) ?? pageOrientation;
  if (orientation === "vertical") {
    const columnWidth = median(group.map((line) => line.bbox.width));
    const lines = orderColumns(
      group,
      VERTICAL_COLUMN_TOLERANCE_FACTOR * columnWidth,
    );
    return { lines, text: joinCjkAware(lines.map((line) => line.text)), orientation };
  }
  const rows = buildRows(
    group.slice().sort((a, b) => centerY(a.bbox) - centerY(b.bbox)),
    rtl,
  );
  const text = rows.reduce(
    (joined, row) => joinAcrossLineBreak(joined, row.text),
    "",
  );
  return { lines: rows.flatMap((row) => row.members), text, orientation };
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

function centerY(rect: Rect): number {
  return rect.y + rect.height / 2;
}

function centerX(rect: Rect): number {
  return rect.x + rect.width / 2;
}

function median(values: number[]): number {
  if (values.length === 0) return 1;
  const sorted = values.slice().sort((a, b) => a - b);
  return Math.max(1, sorted[sorted.length >> 1]);
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
    const rect = line.oriented?.rect ?? line.bbox;
    const shape = readingOrientation(rect);
    // Tilt can make an oblong line's axis-aligned bounds look square.
    const orientation = shape && line.oriented
      ? Math.abs(Math.sin(line.oriented.angle)) > Math.abs(Math.cos(line.oriented.angle))
        ? "vertical"
        : "horizontal"
      : shape;
    if (!orientation) continue;
    const long = Math.max(rect.width, rect.height);
    if (orientation === "vertical") vertical += long;
    else horizontal += long;
  }
  if (vertical === 0 && horizontal === 0) return undefined;
  return vertical > horizontal ? "vertical" : "horizontal";
}

function isVerticalLayout(lines: RecognizedLine[]): boolean {
  return orientationVote(lines) === "vertical";
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
