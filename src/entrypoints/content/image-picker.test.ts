import { describe, expect, it } from "vitest";
import { findImageAtPoint } from "./image-picker";

function imageAt(
  x: number,
  y: number,
  width: number,
  height: number,
  src = "https://example.com/image.png",
): HTMLImageElement {
  return {
    currentSrc: src,
    src,
    getBoundingClientRect: () => ({ x, y, width, height }),
  } as HTMLImageElement;
}

describe("findImageAtPoint", () => {
  it("finds an image from its rendered bounds", () => {
    const image = imageAt(10, 20, 100, 80);

    expect(findImageAtPoint([image], 50, 50)).toBe(image);
  });

  it("ignores images outside the pointer coordinates", () => {
    const image = imageAt(10, 20, 100, 80);

    expect(findImageAtPoint([image], 120, 50)).toBeUndefined();
  });

  it("ignores images without a source or rendered area", () => {
    const noSource = imageAt(10, 20, 100, 80, "");
    const noArea = imageAt(10, 20, 0, 80);

    expect(findImageAtPoint([noSource, noArea], 10, 20)).toBeUndefined();
  });

  it("prefers the last rendered image when image bounds overlap", () => {
    const first = imageAt(10, 20, 100, 80);
    const last = imageAt(10, 20, 100, 80);

    expect(findImageAtPoint([first, last], 50, 50)).toBe(last);
  });
});
