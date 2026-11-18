import { describe, expect, it } from "vitest";
import { estimateSurroundingTint } from "./overlay-background";
import type { OverlayLine } from "./overlay-layout";

function image(
  pixel: (x: number, y: number) => number[] = () => [248, 246, 240, 255],
) {
  const width = 240;
  const height = 120;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(pixel(x, y), (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

const capture = { x: 100, y: 200, width: 240, height: 120 };
const line: OverlayLine = {
  rect: { x: 120, y: 220, width: 160, height: 20 },
  text: "Sample text",
  vertical: false,
};

describe("estimateSurroundingTint", () => {
  const inside = (x: number, y: number): boolean => x >= 20 && x < 180 && y >= 20 && y < 40;

  it("matches a textured surround by its dominant color", () => {
    const pixels = image((x, y) => {
      if (inside(x, y)) return [20, 20, 20, 255];
      return (x + y) % 5 === 0 ? [120, 30, 30, 255] : [210, 190, 150, 255];
    });
    expect(estimateSurroundingTint(pixels, capture, [line])).toEqual({
      background: "rgb(210, 190, 150)",
      foreground: "#152034",
    });
  });

  it("uses light text on a dark surround", () => {
    const pixels = image((x, y) => inside(x, y) ? [240, 240, 240, 255] : [24, 32, 40, 255]);
    expect(estimateSurroundingTint(pixels, capture, [line])?.foreground).toBe("#ffffff");
  });

  it("ignores the block's own pixels", () => {
    const pixels = image((x, y) => inside(x, y) ? [200, 40, 40, 255] : [30, 90, 160, 255]);
    expect(estimateSurroundingTint(pixels, capture, [line])?.background).toBe("rgb(30, 90, 160)");
  });

  it("samples inside the block where it meets the capture edge", () => {
    const pixels = image((x, y) =>
      x < 30 || y < 30 || x >= 210 || y >= 90 ? [30, 90, 160, 255] : [200, 40, 40, 255]);
    expect(estimateSurroundingTint(pixels, capture, [{ ...line, rect: capture }])?.background)
      .toBe("rgb(30, 90, 160)");
  });

  it("matches a plate that ends at the box edge rather than the wall around it", () => {
    const plate = { ...line, rect: { x: 120, y: 220, width: 160, height: 60 } };
    const pixels = image((x, y) => {
      if (x < 20 || x >= 180 || y < 20 || y >= 80) return [214, 180, 144, 255];
      const glyph = x >= 40 && x < 160 && y >= 35 && y < 65 && x % 10 < 6;
      return glyph ? [20, 20, 20, 255] : [236, 236, 240, 255];
    });
    expect(estimateSurroundingTint(pixels, capture, [plate])?.background)
      .toBe("rgb(236, 236, 240)");
  });

  it("does not let outlined glyphs outvote a background split across bins", () => {
    const block = { ...line, rect: { x: 120, y: 220, width: 160, height: 60 } };
    const pixels = image((x, y) => {
      // Two shades of one gray on either side of a coarse bin edge.
      const gray = (x + y) % 2 ? [180, 190, 180, 255] : [180, 194, 180, 255];
      if (x < 20 || x >= 180 || y < 20 || y >= 80) return gray;
      const column = x % 20;
      if (column < 9) return [16, 16, 16, 255];
      return column < 15 ? [245, 245, 245, 255] : gray;
    });
    expect(estimateSurroundingTint(pixels, capture, [block])?.background)
      .toMatch(/^rgb\(180, 19[04], 180\)$/);
  });

  it("follows the tilt instead of the wider page-aligned bounds", () => {
    const angle = 0.4;
    const center = { x: 220, y: 260 };
    const tilted: OverlayLine = {
      rect: { x: 160.8, y: 227.4, width: 118.4, height: 65.2 },
      oriented: { rect: { x: 160, y: 250, width: 120, height: 20 }, angle },
      text: "Sample text",
      vertical: false,
    };
    // A sign tilted with its text; the page around it is another color.
    const pixels = image((x, y) => {
      const dx = x + capture.x - center.x;
      const dy = y + capture.y - center.y;
      const u = Math.abs(dx * Math.cos(angle) + dy * Math.sin(angle));
      const v = Math.abs(-dx * Math.sin(angle) + dy * Math.cos(angle));
      if (u < 60 && v < 10) return [20, 20, 20, 255];
      return u < 74 && v < 24 ? [180, 190, 170, 255] : [254, 254, 254, 255];
    });
    expect(estimateSurroundingTint(pixels, capture, [tilted])?.background)
      .toBe("rgb(180, 190, 170)");
  });

  it("uses the most common color even when no color dominates", () => {
    const palette = [
      [230, 40, 40], [230, 40, 40], [230, 40, 40],
      [40, 200, 60], [40, 200, 60], [40, 60, 220], [40, 60, 220], [20, 20, 20],
    ];
    const pixels = image((x, y) => [...palette[(x * 3 + y * 5) % palette.length], 255]);
    expect(estimateSurroundingTint(pixels, capture, [line])?.background).toBe("rgb(230, 40, 40)");
  });

  it("leaves transparent and empty input alone", () => {
    expect(estimateSurroundingTint(image(() => [0, 0, 0, 0]), capture, [line])).toBeUndefined();
    expect(estimateSurroundingTint(image(), capture, [])).toBeUndefined();
  });
});
