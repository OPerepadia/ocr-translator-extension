// Puts a corrected paragraph back on its OCR lines, so the selectable text over
// the image has the correction too. No DOM.

// Stands for the break between two lines. A paragraph's own text has none.
const BREAK = "\n";

/** Replace one line of the recognized text. */
export function replaceTextLine(
  text: string,
  line: number,
  replacement: string,
): string {
  const lines = text.split("\n");
  lines[line] = replacement;
  return lines.join("\n");
}

/** Spread a paragraph's text over its OCR lines, each given as a list of pieces
 * (characters). Every piece gets the part of `text` that took its place, so a
 * removed character leaves an empty piece. Lines that already read as `text`
 * are returned unchanged. */
export function spreadText(lines: string[][], text: string): string[][] {
  const from = lines.flatMap((line, index) =>
    index === 0 ? line : [BREAK, ...line],
  );
  const to = Array.from(text);
  if (readsAs(from, to)) {
    return lines;
  }

  const spread = align(from, to);
  let next = 0;
  return lines.map((line, index) => {
    if (index > 0) {
      next += 1;
    }
    return line.map(() => spread[next++]);
  });
}

// Whether the lines read as the text, joined the way OCR joins them: with a
// space or nothing, and without the hyphen of a split word.
function readsAs(from: string[], to: string[]): boolean {
  let at = 0;
  for (let i = 0; i < from.length; i++) {
    if (from[i] === BREAK) {
      if (to[at] === " ") {
        at += 1;
      }
    } else if (from[i] === to[at]) {
      at += 1;
    } else if (!isLineEndHyphen(from, i)) {
      return false;
    }
  }
  return at === to.length;
}

function isLineEndHyphen(from: string[], index: number): boolean {
  return from[index] === "-" && from[index + 1] === BREAK;
}

// Match the pieces to the text with the fewest edits, and return what each
// piece became.
function align(from: string[], to: string[]): string[] {
  const width = to.length + 1;
  const costs = new Uint32Array((from.length + 1) * width);
  for (let j = 1; j <= to.length; j++) {
    costs[j] = j;
  }
  for (let i = 1; i <= from.length; i++) {
    const remove = removeCost(from, i - 1);
    costs[i * width] = costs[(i - 1) * width] + remove;
    for (let j = 1; j <= to.length; j++) {
      costs[i * width + j] = Math.min(
        costs[(i - 1) * width + j - 1] + replaceCost(from[i - 1], to[j - 1]),
        costs[(i - 1) * width + j] + remove,
        costs[i * width + j - 1] + 1,
      );
    }
  }

  // Walk back from the end, so each piece's text is put together right to left.
  const spread = from.map(() => "");
  let i = from.length;
  let j = to.length;
  while (i > 0 || j > 0) {
    const cost = costs[i * width + j];
    if (
      i > 0 &&
      j > 0 &&
      cost ===
        costs[(i - 1) * width + j - 1] + replaceCost(from[i - 1], to[j - 1])
    ) {
      i -= 1;
      j -= 1;
      if (from[i] !== BREAK) {
        spread[i] = to[j] + spread[i];
      }
    } else if (
      i > 0 &&
      cost === costs[(i - 1) * width + j] + removeCost(from, i - 1)
    ) {
      i -= 1;
      if (isLineEndHyphen(from, i)) {
        spread[i] = from[i] + spread[i];
      }
    } else {
      j -= 1;
      // Added text goes on the piece before it, or on the first piece of a line.
      const piece = i > 0 && from[i - 1] !== BREAK ? i - 1 : i;
      if (piece < spread.length) {
        spread[piece] = to[j] + spread[piece];
      }
    }
  }
  return spread;
}

function replaceCost(from: string, to: string): number {
  if (from === BREAK) {
    // Dearer than adding the character and dropping the break.
    return to === " " ? 0 : 2;
  }
  return from === to ? 0 : 1;
}

function removeCost(from: string[], index: number): number {
  return from[index] === BREAK || isLineEndHyphen(from, index) ? 0 : 1;
}
