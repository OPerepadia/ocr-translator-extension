import { describe, expect, it } from "vitest";
import { createFrameSignature, framesMatch } from "./frame-signature";

function solid(width: number, height: number, value: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  }
  return { width, height, data };
}

function paint(
  image: ReturnType<typeof solid>,
  x: number,
  y: number,
  size: number,
  value: number,
): void {
  for (let row = y; row < y + size; row += 1) {
    for (let column = x; column < x + size; column += 1) {
      const offset = (row * image.width + column) * 4;
      image.data[offset] = value;
      image.data[offset + 1] = value;
      image.data[offset + 2] = value;
    }
  }
}

describe("frame signature", () => {
  it("matches a frame against an identical one", () => {
    const first = createFrameSignature(solid(900, 120, 90));
    const second = createFrameSignature(solid(900, 120, 90));

    expect(framesMatch(first, second)).toBe(true);
  });

  it("tolerates a small brightness drift", () => {
    const first = createFrameSignature(solid(300, 60, 90));
    const second = createFrameSignature(solid(300, 60, 98));

    expect(framesMatch(first, second)).toBe(true);
  });

  it("notices a small mark appearing in the frame", () => {
    const before = solid(900, 120, 40);
    const after = solid(900, 120, 40);
    paint(after, 500, 50, 6, 255);

    expect(
      framesMatch(createFrameSignature(before), createFrameSignature(after)),
    ).toBe(false);
  });

  it("notices a uniform change in brightness", () => {
    const first = createFrameSignature(solid(300, 60, 40));
    const second = createFrameSignature(solid(300, 60, 140));

    expect(framesMatch(first, second)).toBe(false);
  });

  it("never matches frames of different sizes", () => {
    const first = createFrameSignature(solid(900, 120, 90));
    const second = createFrameSignature(solid(800, 120, 90));

    expect(framesMatch(first, second)).toBe(false);
  });

  it("averages a region that does not divide into whole cells", () => {
    const signature = createFrameSignature(solid(301, 7, 200));

    expect(signature.luma.every((value) => value === 200)).toBe(true);
    expect(signature.luma).toHaveLength(signature.columns * signature.rows);
  });
});
