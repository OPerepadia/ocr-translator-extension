import { describe, expect, it } from "vitest";
import {
  cropQuad,
  detectBackgroundTone,
  orientCropForRecognition,
  padQuad,
  type RgbaImage,
} from "./crop";
import type { Quad } from "./geometry";

function image(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = i;
    data[i * 4 + 1] = i;
    data[i * 4 + 2] = i;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

describe("cropQuad", () => {
  it("keeps a horizontal quad horizontal", () => {
    const quad: Quad = [
      { x: 2, y: 1 },
      { x: 6, y: 1 },
      { x: 6, y: 3 },
      { x: 2, y: 3 },
    ];

    const crop = cropQuad(image(10, 8), quad);

    expect(crop.width).toBe(4);
    expect(crop.height).toBe(2);
  });

  it("uses the rotated quad size instead of the axis-aligned bounds", () => {
    const quad: Quad = [
      { x: 2, y: 1 },
      { x: 7, y: 3 },
      { x: 6, y: 6 },
      { x: 1, y: 4 },
    ];

    const crop = cropQuad(image(10, 8), quad);

    expect(crop.width).toBe(5);
    expect(crop.height).toBe(3);
  });

  it("orders diamond-shaped quads without duplicating tied corners", () => {
    const quad: Quad = [
      { x: 5, y: 1 },
      { x: 9, y: 5 },
      { x: 5, y: 9 },
      { x: 1, y: 5 },
    ];

    const crop = cropQuad(image(12, 12), quad);

    expect(crop.width).toBe(6);
    expect(crop.height).toBe(6);
  });
});

describe("detectBackgroundTone", () => {
  it("uses the dominant lightness inside the detected text box", () => {
    const source = image(4, 2);
    source.data.fill(255);
    source.data[0] = 0;
    source.data[1] = 0;
    source.data[2] = 0;

    expect(
      detectBackgroundTone(source, { x: 0, y: 0, width: 4, height: 2 }),
    ).toBe("light");

    source.data.fill(0);
    source.data[3] = 255;
    source.data[7] = 255;
    expect(
      detectBackgroundTone(source, { x: 0, y: 0, width: 4, height: 2 }),
    ).toBe("dark");
  });

  it("keeps medium backgrounds light", () => {
    const source = image(2, 2);
    source.data.fill(112);

    expect(
      detectBackgroundTone(source, { x: 0, y: 0, width: 2, height: 2 }),
    ).toBe("light");
  });
});

describe("padQuad", () => {
  it("expands the quad outward by the requested pixels", () => {
    const padded = padQuad(
      [
        { x: 2, y: 2 },
        { x: 6, y: 2 },
        { x: 6, y: 4 },
        { x: 2, y: 4 },
      ],
      1,
    );
    const xs = padded.map((point) => point.x);
    const ys = padded.map((point) => point.y);

    expect(Math.min(...xs)).toBeCloseTo(1, 5);
    expect(Math.max(...xs)).toBeCloseTo(7, 5);
    expect(Math.min(...ys)).toBeCloseTo(1, 5);
    expect(Math.max(...ys)).toBeCloseTo(5, 5);
  });
});

describe("orientCropForRecognition", () => {
  it("rotates tall vertical crops before recognition", () => {
    const crop = orientCropForRecognition(image(2, 5));

    expect(crop.width).toBe(5);
    expect(crop.height).toBe(2);
  });

  it("leaves horizontal crops unchanged", () => {
    const source = image(5, 2);
    const crop = orientCropForRecognition(source);

    expect(crop).toBe(source);
  });
});
