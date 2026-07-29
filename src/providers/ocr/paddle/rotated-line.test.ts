// Reads a real image of a line of text set at 45 degrees and runs the geometry
// the engine runs on it: the detector's box for the line, then the per-character
// boxes cut from it. Nothing here needs ORT — the detector's own minAreaRect is
// what turns the ink into a box, so the fixture stands in for the model.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { charBoxes } from "./char-boxes";
import { isRotatedForRecognition, padQuad } from "./crop";
import { minAreaRect, orientedRectOfQuad, type Point, type Quad } from "./geometry";

// The detector padding from the PP-OCRv6 manifest.
const PADDING = 3;
// "Diagonal minus 45" — what the recognizer reads off this fixture.
const CHAR_COUNT = 17;

interface Greyscale {
  pixels: Uint8Array;
  width: number;
  height: number;
}

/** Read an uncompressed 24-bit BMP as greyscale. Rows run bottom-up and are
 * padded to a multiple of four bytes. */
function readBmp(path: string): Greyscale {
  const file = readFileSync(path);
  const pixelOffset = file.readUInt32LE(10);
  const width = file.readInt32LE(18);
  const height = file.readInt32LE(22);
  const bitsPerPixel = file.readUInt16LE(28);
  const compression = file.readUInt32LE(30);
  if (bitsPerPixel !== 24 || compression !== 0) {
    throw new Error(
      `expected an uncompressed 24-bit bmp, got ${bitsPerPixel}bpp compression ${compression}`,
    );
  }

  const stride = Math.ceil((width * 3) / 4) * 4;
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = pixelOffset + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const i = row + x * 3;
      // Rec. 601 luma, enough to tell ink from paper.
      pixels[y * width + x] = Math.round(
        0.114 * file[i] + 0.587 * file[i + 1] + 0.299 * file[i + 2],
      );
    }
  }
  return { pixels, width, height };
}

/** Every dark pixel, which on this fixture is the text and nothing else. */
function inkPoints({ pixels, width, height }: Greyscale): Point[] {
  const points: Point[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x] < 128) {
        points.push({ x, y });
      }
    }
  }
  return points;
}

function degrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

describe("a line of text set at 45 degrees", () => {
  const image = readBmp(
    fileURLToPath(new URL("./__fixtures__/diagonal-45.bmp", import.meta.url)),
  );
  const ink = inkPoints(image);
  // The box the detector arrives at for this line: the smallest rectangle round
  // the ink, which is what its post-processing computes from a text blob.
  const quad = minAreaRect(ink).corners as Quad;

  // What the engine does with that box, step for step.
  const padded = padQuad(quad, PADDING);
  const rotated = isRotatedForRecognition(padded);
  const line = orientedRectOfQuad(padded, rotated);
  const chars = charBoxes({
    chars: Array.from({ length: CHAR_COUNT }, (_, index) => ({
      char: "x",
      start: index * 2,
      end: index * 2 + 1,
    })),
    timeSteps: CHAR_COUNT * 2,
    quad: padQuad(quad, 0),
    padding: PADDING,
    angle: line.angle,
  });

  it("reads the fixture as one long thin line at 45 degrees", () => {
    expect(image.width).toBe(325);
    expect(image.height).toBe(317);
    expect(ink.length).toBeGreaterThan(500);
    const long = Math.max(line.rect.width, line.rect.height);
    const short = Math.min(line.rect.width, line.rect.height);
    expect(long).toBeGreaterThan(300);
    expect(short).toBeLessThan(60);
    expect(Math.abs(degrees(line.angle))).toBeCloseTo(45, 0);
  });

  // The overlay puts each character into the box element as a plain rect, and
  // the browser turns the whole box by the line's angle. That only lands the
  // character on its glyph if the character's box is squared to the same frame
  // the line's is — so the two angles have to agree.
  it("cuts every character in the same frame as its line", () => {
    const offBy = chars.map((char) =>
      Math.abs(degrees(char.oriented!.angle) - degrees(line.angle)),
    );
    expect(Math.max(...offBy)).toBeLessThan(0.5);
  });

  it("gives every character the line's full thickness", () => {
    // The line's box is padded, the characters are cut from the unpadded quad.
    const thickness = line.rect.height - PADDING * 2;
    for (const char of chars) {
      expect(char.oriented!.rect.height).toBeCloseTo(thickness, 0);
    }
  });

  it("tiles the line's length with the characters", () => {
    const length = line.rect.width - PADDING * 2;
    const tiled = chars.reduce((sum, char) => sum + char.oriented!.rect.width, 0);
    expect(tiled).toBeCloseTo(length, 0);
  });
});
