// Character dictionary handling for the PP-OCRv6 recognizer.
//
// The model emits `dict.length + 2` classes. The class layout follows
// PaddleOCR's CTCLabelDecode with use_space_char:
//   index 0                 -> CTC blank
//   index 1 .. dict.length  -> dict[index - 1]
//   index dict.length + 1   -> " " (space, appended by use_space_char)

const BLANK_INDEX = 0;

/** Parse a dict.txt file (one character per line) into an array. A single
 * trailing newline is ignored; internal blank lines are preserved as entries
 * because the model's class count depends on the exact line count. */
export function parseDict(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** Build a class-index → character mapper for the given dictionary. */
export function makeCharAt(dict: string[]): (index: number) => string | null {
  const spaceIndex = dict.length + 1;
  return (index: number): string | null => {
    if (index === BLANK_INDEX) {
      return null;
    }
    if (index >= 1 && index <= dict.length) {
      return dict[index - 1];
    }
    if (index === spaceIndex) {
      return " ";
    }
    return null;
  };
}

/** Number of output classes implied by a dictionary (blank + dict + space). */
export function classCount(dict: string[]): number {
  return dict.length + 2;
}
