// Decides whether two reads of the screen show the same line. Recognition
// wobbles from frame to frame: a letter is dropped, a comma turns into a full
// stop. None of that should look like a new subtitle.

// A read this similar to the line on screen counts as that line.
const SAME_LINE_SIMILARITY = 0.85;
// Subtitles are short; this keeps a misread block of text from costing much.
const MAX_COMPARED_LENGTH = 400;

const NOT_TEXT = /[^\p{L}\p{N}\p{M}]/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/gu;

/** The text with case, punctuation and spacing taken out. */
export function comparisonKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(NOT_TEXT, "")
    .slice(0, MAX_COMPARED_LENGTH);
}

/**
 * Whether a read is worth showing or translating. Video noise often reads as
 * a stray glyph or two, so a read needs at least two letters or digits. That
 * also drops a subtitle made of a single character.
 */
export function isReadable(text: string): boolean {
  return (text.match(LETTER_OR_DIGIT)?.length ?? 0) >= 2;
}

export function isSameLine(a: string, b: string): boolean {
  const left = Array.from(comparisonKey(a));
  const right = Array.from(comparisonKey(b));
  const longest = Math.max(left.length, right.length);
  if (longest === 0) {
    return true;
  }
  if (Math.abs(left.length - right.length) / longest > 1 - SAME_LINE_SIMILARITY) {
    return false;
  }
  return 1 - editDistance(left, right) / longest >= SAME_LINE_SIMILARITY;
}

function editDistance(a: string[], b: string[]): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}
