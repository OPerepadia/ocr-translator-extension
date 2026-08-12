import { describe, expect, it, vi } from "vitest";
import {
  cleanupImagePickerOnNavigation,
  findImageAtPoint,
} from "./image-picker";

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

describe("cleanupImagePickerOnNavigation", () => {
  it("ends the global session when the top frame navigates", () => {
    const cancelLocal = vi.fn();
    const endGlobal = vi.fn();

    cleanupImagePickerOnNavigation(true, cancelLocal, endGlobal);

    expect(endGlobal).toHaveBeenCalledOnce();
    expect(cancelLocal).not.toHaveBeenCalled();
  });

  it("only cancels the local picker when a child frame navigates", () => {
    const cancelLocal = vi.fn();
    const endGlobal = vi.fn();

    cleanupImagePickerOnNavigation(false, cancelLocal, endGlobal);

    expect(cancelLocal).toHaveBeenCalledOnce();
    expect(endGlobal).not.toHaveBeenCalled();
  });
});
