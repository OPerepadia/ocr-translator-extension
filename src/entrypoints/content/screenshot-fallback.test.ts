import { describe, expect, it } from "vitest";
import { IMAGE_LOAD_ERROR } from "../../shared/messages";
import { screenshotFallbackRect } from "./screenshot-fallback";

const viewport = { width: 800, height: 600 };

function loadError(): Error {
  const error = new Error("Could not load image (403).");
  error.name = IMAGE_LOAD_ERROR;
  return error;
}

describe("screenshotFallbackRect", () => {
  it("returns the image rect when the download failed", () => {
    const rect = { x: 10, y: 20, width: 300, height: 200 };
    expect(screenshotFallbackRect(loadError(), rect, viewport)).toEqual(rect);
  });

  it("clips the image rect to the viewport", () => {
    expect(
      screenshotFallbackRect(
        loadError(),
        { x: -50, y: 500, width: 300, height: 200 },
        viewport,
      ),
    ).toEqual({ x: 0, y: 500, width: 250, height: 100 });
  });

  it("skips images that are off screen", () => {
    expect(
      screenshotFallbackRect(
        loadError(),
        { x: 0, y: 700, width: 300, height: 200 },
        viewport,
      ),
    ).toBeUndefined();
  });

  it("skips images it could not find", () => {
    expect(screenshotFallbackRect(loadError(), undefined, viewport)).toBeUndefined();
  });

  it("skips other errors", () => {
    expect(
      screenshotFallbackRect(
        new Error("OCR failed"),
        { x: 0, y: 0, width: 100, height: 100 },
        viewport,
      ),
    ).toBeUndefined();
  });
});
