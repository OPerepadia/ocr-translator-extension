// A coarse fingerprint of a captured region. Live translation compares it with
// the previous one to skip recognition while nothing on screen moves, such as a
// paused video.

export interface FrameSignature {
  /** Source pixels per cell side. */
  cell: number;
  columns: number;
  rows: number;
  /** Mean brightness of each cell, row by row. */
  luma: Uint8Array;
}

interface Pixels {
  width: number;
  height: number;
  /** RGBA, as from `ImageData`. */
  data: Uint8ClampedArray;
}

// Cells per longest side. Fine enough that a changed punctuation mark moves at
// least one cell, coarse enough to compare in well under a millisecond.
const MAX_GRID_SIDE = 256;
// Brightness levels a cell may drift and still count as the same. Identical
// pixels give identical cells, so this only absorbs dithering.
const CELL_TOLERANCE = 16;

export function createFrameSignature({ width, height, data }: Pixels): FrameSignature {
  const cell = Math.max(1, Math.ceil(Math.max(width, height) / MAX_GRID_SIDE));
  const columns = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const sums = new Uint32Array(columns * rows);
  const counts = new Uint32Array(columns * rows);

  for (let y = 0; y < height; y += 1) {
    const rowStart = Math.floor(y / cell) * columns;
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const luma =
        (data[offset] * 77 + data[offset + 1] * 150 + data[offset + 2] * 29) >> 8;
      const index = rowStart + Math.floor(x / cell);
      sums[index] += luma;
      counts[index] += 1;
    }
  }

  const luma = new Uint8Array(sums.length);
  for (let index = 0; index < sums.length; index += 1) {
    luma[index] = Math.round(sums[index] / counts[index]);
  }
  return { cell, columns, rows, luma };
}

/** True when no cell differs by more than the tolerance. Regions of different
 * sizes never match. */
export function framesMatch(a: FrameSignature, b: FrameSignature): boolean {
  if (a.cell !== b.cell || a.columns !== b.columns || a.rows !== b.rows) {
    return false;
  }
  for (let index = 0; index < a.luma.length; index += 1) {
    if (Math.abs(a.luma[index] - b.luma[index]) > CELL_TOLERANCE) {
      return false;
    }
  }
  return true;
}
