import { describe, expect, it } from "vitest";
import type { OcrBlock, Rect } from "../../shared/types";
import {
  buildOverlayLayout,
  getRenderedImageRect,
  groupParagraphs,
  mapAngleToPage,
  mapBboxToPage,
  moveOverlayLayout,
  paragraphAngle,
  rotatedBounds,
} from "./overlay-layout";

function block(
  paragraph: number,
  bbox: Rect,
  text = "x",
): OcrBlock {
  return { text, bbox, paragraph };
}

function degrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** A block whose text sits at `tilt` degrees, with `bbox` grown to hold it the
 * way the detector's axis-aligned box would be. */
function tiltedBlock(
  paragraph: number,
  rect: Rect,
  tilt: number,
  text = "x",
): OcrBlock {
  const angle = radians(tilt);
  return {
    text,
    bbox: rotatedBounds(rect, angle),
    oriented: { rect, angle },
    paragraph,
  };
}

describe("getRenderedImageRect", () => {
  it("excludes side gutters from a contained lightbox image", () => {
    expect(
      getRenderedImageRect({
        elementRect: { x: 0, y: 0, width: 2400, height: 1200 },
        naturalWidth: 1600,
        naturalHeight: 1200,
        objectFit: "contain",
        objectPosition: "50% 50%",
      }),
    ).toEqual({ x: 400, y: 0, width: 1600, height: 1200 });
  });

  it("keeps the element rect when its aspect ratio matches the image", () => {
    expect(
      getRenderedImageRect({
        elementRect: { x: 24, y: 16, width: 1200, height: 900 },
        naturalWidth: 1600,
        naturalHeight: 1200,
        objectFit: "contain",
        objectPosition: "50% 50%",
      }),
    ).toEqual({ x: 24, y: 16, width: 1200, height: 900 });
  });
});

describe("groupParagraphs", () => {
  it("unions block bboxes that share a paragraph index", () => {
    const groups = groupParagraphs([
      block(0, { x: 0, y: 0, width: 10, height: 4 }, "a"),
      block(0, { x: 12, y: 1, width: 8, height: 5 }, "b"),
      block(1, { x: 0, y: 20, width: 30, height: 6 }, "c"),
    ]);

    expect(groups).toMatchObject([
      { paragraph: 0, bbox: { x: 0, y: 0, width: 20, height: 6 }, texts: ["a", "b"] },
      { paragraph: 1, bbox: { x: 0, y: 20, width: 30, height: 6 }, texts: ["c"] },
    ]);
  });

  it("keeps each block's own bbox alongside the union", () => {
    const groups = groupParagraphs([
      block(0, { x: 0, y: 0, width: 10, height: 4 }, "a"),
      block(0, { x: 12, y: 1, width: 8, height: 5 }, "b"),
    ]);

    expect(groups[0]?.lineBboxes).toEqual([
      { x: 0, y: 0, width: 10, height: 4 },
      { x: 12, y: 1, width: 8, height: 5 },
    ]);
  });

  it("orders groups by paragraph index", () => {
    const groups = groupParagraphs([
      block(2, { x: 0, y: 40, width: 5, height: 5 }),
      block(0, { x: 0, y: 0, width: 5, height: 5 }),
      block(1, { x: 0, y: 20, width: 5, height: 5 }),
    ]);
    expect(groups.map((g) => g.paragraph)).toEqual([0, 1, 2]);
  });

  it("keeps blocks without a paragraph index as separate paragraphs", () => {
    const groups = groupParagraphs([
      { text: "a", bbox: { x: 0, y: 0, width: 5, height: 5 } },
      { text: "b", bbox: { x: 0, y: 10, width: 5, height: 5 } },
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe("mapBboxToPage", () => {
  it("maps a crop-pixel bbox onto the selection rect by fraction", () => {
    // Crop is 200x100 px; selection is 100x50 CSS px at (1000, 500) — i.e. a
    // 2x device-pixel ratio. A bbox at the crop's centre maps to the rect's.
    const rect: Rect = { x: 1000, y: 500, width: 100, height: 50 };
    const mapped = mapBboxToPage(
      { x: 100, y: 50, width: 40, height: 20 },
      200,
      100,
      rect,
    );
    expect(mapped).toEqual({ x: 1050, y: 525, width: 20, height: 10 });
  });
});

describe("buildOverlayLayout", () => {
  const base = {
    blocks: [
      block(0, { x: 0, y: 0, width: 100, height: 10 }),
      block(1, { x: 0, y: 50, width: 100, height: 10 }),
    ],
    imageWidth: 100,
    imageHeight: 100,
    rect: { x: 0, y: 0, width: 100, height: 100 } as Rect,
  };

  it("assigns a translated line per paragraph when line counts match", () => {
    const layout = buildOverlayLayout({
      ...base,
      ocrText: "hello\nworld",
      translationText: "bonjour\nmonde",
    });
    expect(layout.segmented).toBe(true);
    expect(layout.paragraphs.map((p) => p.original)).toEqual([
      "hello",
      "world",
    ]);
    expect(layout.paragraphs.map((p) => p.translated)).toEqual([
      "bonjour",
      "monde",
    ]);
    expect(layout.paragraphs[0].sourceRect).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 10,
    });
  });

  it("maps each detected line onto the page for the text layer", () => {
    const layout = buildOverlayLayout({
      ocrText: "hello world",
      translationText: "bonjour monde",
      // Two lines in one paragraph, crop pixels at 2x the page rect.
      blocks: [
        block(0, { x: 0, y: 0, width: 100, height: 10 }, "hello"),
        block(0, { x: 0, y: 20, width: 60, height: 10 }, "world"),
      ],
      imageWidth: 100,
      imageHeight: 100,
      rect: { x: 10, y: 20, width: 50, height: 50 },
    });

    // Blocks without a detected tilt fall back to their own bbox, untilted.
    expect(layout.paragraphs[0].lines).toEqual([
      {
        rect: { x: 10, y: 20, width: 50, height: 5 },
        oriented: { rect: { x: 10, y: 20, width: 50, height: 5 }, angle: 0 },
        text: "hello",
        vertical: false,
      },
      {
        rect: { x: 10, y: 30, width: 30, height: 5 },
        oriented: { rect: { x: 10, y: 30, width: 30, height: 5 }, angle: 0 },
        text: "world",
        vertical: false,
      },
    ]);
  });

  it("marks lines of a vertical paragraph, so mixed captures keep both", () => {
    const layout = buildOverlayLayout({
      ocrText: "\u7e26\u66f8\u304d\nhorizontal caption",
      translationText: "vertical\ncaption",
      blocks: [
        { text: "縦書き", bbox: { x: 0, y: 0, width: 10, height: 60 }, paragraph: 0, orientation: "vertical" },
        { text: "horizontal caption", bbox: { x: 0, y: 80, width: 90, height: 10 }, paragraph: 1, orientation: "horizontal" },
      ],
      imageWidth: 100,
      imageHeight: 100,
      rect: { x: 0, y: 0, width: 100, height: 100 },
    });

    expect(layout.paragraphs.map((p) => p.lines[0].vertical)).toEqual([
      true,
      false,
    ]);
  });

  it("falls back to the combined translation when line counts differ", () => {
    const layout = buildOverlayLayout({
      ...base,
      ocrText: "hello\nworld",
      translationText: "bonjour le monde",
    });
    expect(layout.segmented).toBe(false);
    expect(layout.paragraphs.every((p) => p.translated === null)).toBe(true);
    expect(layout.combinedTranslation).toBe("bonjour le monde");
    // Combined rect spans both paragraph rects.
    expect(layout.combinedRect).toEqual({ x: 0, y: 0, width: 100, height: 60 });
  });

  it("falls back when edited OCR text has fewer lines than OCR paragraph groups", () => {
    const layout = buildOverlayLayout({
      ...base,
      ocrText: "hello world",
      translationText: "bonjour le monde",
    });

    expect(layout.segmented).toBe(false);
    expect(layout.paragraphs.every((p) => p.translated === null)).toBe(true);
    expect(layout.combinedTranslation).toBe("bonjour le monde");
  });

  it("widens and centers painted boxes for narrow vertical source text", () => {
    const layout = buildOverlayLayout({
      blocks: [block(0, { x: 40, y: 0, width: 20, height: 100 })],
      imageWidth: 100,
      imageHeight: 100,
      rect: { x: 0, y: 0, width: 80, height: 100 },
      ocrText: "縦書きのサンプル文",
      translationText: "Generic translated phrase",
    });

    expect(layout.paragraphs[0].sourceRect).toEqual({
      x: 32,
      y: 0,
      width: 16,
      height: 100,
    });
    expect(layout.paragraphs[0].translationRect).toEqual({
      x: -20,
      y: 0,
      width: 120,
      height: 100,
    });
    expect(layout.combinedRect).toEqual({
      x: -20,
      y: 0,
      width: 120,
      height: 100,
    });
  });

  // The original view's frame and popover stay on the text they came from, even
  // where the painted box was widened away from it.
  it("keeps the combined source rect on the vertical source text", () => {
    const layout = buildOverlayLayout({
      blocks: [block(0, { x: 40, y: 0, width: 20, height: 100 })],
      imageWidth: 100,
      imageHeight: 100,
      rect: { x: 0, y: 0, width: 80, height: 100 },
      ocrText: "縦書きのサンプル文",
      translationText: "Generic translated phrase",
    });

    expect(layout.combinedSourceRect).toEqual({
      x: 32,
      y: 0,
      width: 16,
      height: 100,
    });
  });

  it("keeps vertical CJK translations on the source text box", () => {
    const layout = buildOverlayLayout({
      blocks: [block(0, { x: 50, y: 0, width: 20, height: 100 })],
      imageWidth: 100,
      imageHeight: 100,
      rect: { x: 0, y: 0, width: 100, height: 100 },
      ocrText: "縦書きのサンプル文",
      translationText: "翻訳の例文です",
    });

    expect(layout.paragraphs[0].translationRect).toEqual(
      layout.paragraphs[0].sourceRect,
    );
  });

  it("marks paragraphs vertical so the original view can match the layout", () => {
    const layout = buildOverlayLayout({
      ...base,
      ocrText: "hello\nworld",
      translationText: "bonjour\nmonde",
      orientation: "vertical",
    });
    expect(layout.paragraphs.map((p) => p.vertical)).toEqual([true, true]);
  });

  it("breaks vertical originals at the detected column boundaries", () => {
    const layout = buildOverlayLayout({
      blocks: [
        block(0, { x: 60, y: 0, width: 20, height: 60 }, "最初"),
        block(0, { x: 30, y: 0, width: 20, height: 100 }, "中央の列"),
        block(0, { x: 0, y: 0, width: 20, height: 60 }, "最後"),
      ],
      imageWidth: 100,
      imageHeight: 100,
      rect: { x: 0, y: 0, width: 100, height: 100 },
      ocrText: "最初中央の列最後",
      translationText: "Generic translated phrase",
      orientation: "vertical",
    });

    expect(layout.paragraphs[0].original).toBe("最初\n中央の列\n最後");
    // The translation input line stays joined; only the display text breaks.
    expect(layout.combinedTranslation).toBe("Generic translated phrase");
  });

  it("treats missing orientation as horizontal", () => {
    const layout = buildOverlayLayout({
      ...base,
      ocrText: "hello\nworld",
      translationText: "bonjour\nmonde",
    });
    expect(layout.paragraphs.map((p) => p.vertical)).toEqual([false, false]);
  });

  it("lets a horizontal block override the vertical layout", () => {
    const layout = buildOverlayLayout({
      blocks: [
        { text: "縦の", bbox: { x: 60, y: 0, width: 20, height: 60 }, paragraph: 0, orientation: "vertical" },
        { text: "文章", bbox: { x: 30, y: 0, width: 20, height: 80 }, paragraph: 0, orientation: "vertical" },
        { text: "Footer", bbox: { x: 0, y: 90, width: 50, height: 8 }, paragraph: 1, orientation: "horizontal" },
      ],
      imageWidth: 100,
      imageHeight: 100,
      rect: { x: 0, y: 0, width: 100, height: 100 },
      ocrText: "縦の文章\nFooter",
      translationText: "Translated phrase\nFooter",
      orientation: "vertical",
    });

    expect(layout.paragraphs.map((p) => p.vertical)).toEqual([true, false]);
    expect(layout.paragraphs[0].original).toBe("縦の\n文章");
    // The horizontal paragraph keeps the joined line, not newline-split columns.
    expect(layout.paragraphs[1].original).toBe("Footer");
  });
});

describe("rotatedBounds", () => {
  it("returns the rect itself when there is no tilt", () => {
    const rect = { x: 5, y: 6, width: 40, height: 10 };
    expect(rotatedBounds(rect, 0)).toEqual(rect);
  });

  it("grows around a tilt, keeping the centre", () => {
    const bounds = rotatedBounds(
      { x: 0, y: 0, width: 100, height: 20 },
      radians(30),
    );
    expect(bounds.width).toBeCloseTo(100 * Math.cos(radians(30)) + 20 * 0.5, 4);
    expect(bounds.height).toBeCloseTo(100 * 0.5 + 20 * Math.cos(radians(30)), 4);
    expect(bounds.x + bounds.width / 2).toBeCloseTo(50, 6);
    expect(bounds.y + bounds.height / 2).toBeCloseTo(10, 6);
  });
});

describe("mapAngleToPage", () => {
  it("keeps the tilt when both axes scale alike", () => {
    expect(mapAngleToPage(radians(20), 0.5, 0.5)).toBeCloseTo(radians(20), 9);
  });

  it("shears the tilt when the axes scale apart", () => {
    // Squashing the vertical axis flattens the line it runs along.
    expect(degrees(mapAngleToPage(radians(45), 1, 0.5))).toBeCloseTo(
      degrees(Math.atan(0.5)),
      6,
    );
  });
});

describe("paragraphAngle", () => {
  it("reports no tilt for upright lines", () => {
    expect(
      paragraphAngle([
        { rect: { x: 0, y: 0, width: 100, height: 10 }, angle: 0 },
      ]),
    ).toBe(0);
  });

  it("snaps away the degree or two a detector box wanders", () => {
    expect(
      paragraphAngle([
        { rect: { x: 0, y: 0, width: 100, height: 10 }, angle: radians(1.2) },
      ]),
    ).toBe(0);
  });

  it("weights each line by its length", () => {
    const angle = paragraphAngle([
      { rect: { x: 0, y: 0, width: 300, height: 10 }, angle: radians(10) },
      { rect: { x: 0, y: 0, width: 100, height: 10 }, angle: radians(14) },
    ]);
    // Averaged as directions rather than as raw numbers, so it lands a hair off
    // the arithmetic mean.
    expect(degrees(angle)).toBeCloseTo(11, 2);
  });

  it("lets near-square lines abstain, having no direction to report", () => {
    const angle = paragraphAngle([
      { rect: { x: 0, y: 0, width: 200, height: 20 }, angle: radians(12) },
      { rect: { x: 0, y: 0, width: 22, height: 20 }, angle: radians(-40) },
    ]);
    expect(degrees(angle)).toBeCloseTo(12, 6);
  });

  it("reports none when every line abstains", () => {
    expect(
      paragraphAngle([
        { rect: { x: 0, y: 0, width: 20, height: 18 }, angle: radians(30) },
      ]),
    ).toBe(0);
  });
});

describe("buildOverlayLayout tilted text", () => {
  it("wraps a tilted line in a box that follows it", () => {
    const layout = buildOverlayLayout({
      ocrText: "hello",
      translationText: "bonjour",
      blocks: [
        tiltedBlock(0, { x: 20, y: 40, width: 200, height: 20 }, 15, "hello"),
      ],
      imageWidth: 400,
      imageHeight: 200,
      rect: { x: 0, y: 0, width: 400, height: 200 },
    });

    const paragraph = layout.paragraphs[0];
    expect(degrees(paragraph.angle)).toBeCloseTo(15, 6);
    // The snug box, not the wider one the axis-aligned bbox had to grow to.
    expect(paragraph.sourceRect.width).toBeCloseTo(200, 6);
    expect(paragraph.sourceRect.height).toBeCloseTo(20, 6);
    expect(paragraph.sourceRect.x).toBeCloseTo(20, 6);
    expect(paragraph.sourceRect.y).toBeCloseTo(40, 6);
  });

  it("leaves upright paragraphs on the union of their bboxes", () => {
    const layout = buildOverlayLayout({
      ocrText: "hello\nworld",
      translationText: "bonjour\nmonde",
      blocks: [
        block(0, { x: 0, y: 0, width: 100, height: 10 }, "hello"),
        block(1, { x: 0, y: 50, width: 100, height: 10 }, "world"),
      ],
      imageWidth: 100,
      imageHeight: 100,
      rect: { x: 0, y: 0, width: 100, height: 100 },
    });

    expect(layout.paragraphs.map((p) => p.angle)).toEqual([0, 0]);
    expect(layout.paragraphs[0].sourceRect).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 10,
    });
  });

  it("boxes a tilted paragraph's lines together in their own frame", () => {
    // Two lines stacked along the same 20-degree tilt.
    const tilt = radians(20);
    const step = { x: -10 * Math.sin(tilt), y: 10 * Math.cos(tilt) };
    const layout = buildOverlayLayout({
      ocrText: "hello world",
      translationText: "bonjour monde",
      blocks: [
        tiltedBlock(0, { x: 100, y: 100, width: 120, height: 10 }, 20, "hello"),
        tiltedBlock(
          0,
          { x: 100 + step.x, y: 100 + step.y, width: 120, height: 10 },
          20,
          "world",
        ),
      ],
      imageWidth: 400,
      imageHeight: 400,
      rect: { x: 0, y: 0, width: 400, height: 400 },
    });

    const paragraph = layout.paragraphs[0];
    expect(degrees(paragraph.angle)).toBeCloseTo(20, 6);
    expect(paragraph.sourceRect.width).toBeCloseTo(120, 6);
    expect(paragraph.sourceRect.height).toBeCloseTo(20, 6);
  });

  it("maps a tilted line's character boxes onto the page", () => {
    const angle = radians(15);
    const layout = buildOverlayLayout({
      ocrText: "ab",
      translationText: "xy",
      blocks: [
        {
          ...tiltedBlock(0, { x: 20, y: 40, width: 200, height: 20 }, 15, "ab"),
          chars: [
            {
              text: "a",
              bbox: rotatedBounds({ x: 20, y: 40, width: 100, height: 20 }, angle),
              oriented: { rect: { x: 20, y: 40, width: 100, height: 20 }, angle },
            },
            {
              text: "b",
              bbox: rotatedBounds({ x: 120, y: 40, width: 100, height: 20 }, angle),
              oriented: { rect: { x: 120, y: 40, width: 100, height: 20 }, angle },
            },
          ],
        },
      ],
      imageWidth: 400,
      imageHeight: 200,
      rect: { x: 0, y: 0, width: 400, height: 200 },
    });

    const chars = layout.paragraphs[0].lines[0].chars!;
    expect(chars.map((char) => char.text)).toEqual(["a", "b"]);
    // The tilted box rides along beside the axis-aligned one, which the tilt
    // has grown; the text layer places spans from the tilted one.
    expect(chars[0].oriented!.rect.width).toBeCloseTo(100, 6);
    expect(degrees(chars[0].oriented!.angle)).toBeCloseTo(15, 6);
    expect(chars[0].rect.width).toBeGreaterThan(chars[0].oriented!.rect.width);
  });

  it("keeps the combined box upright around paragraphs tilted each way", () => {
    const layout = buildOverlayLayout({
      ocrText: "hello\nworld",
      // One line for two paragraphs, so the combined box is what gets used.
      translationText: "bonjour monde",
      blocks: [
        tiltedBlock(0, { x: 50, y: 20, width: 200, height: 20 }, 15, "hello"),
        tiltedBlock(1, { x: 50, y: 120, width: 200, height: 20 }, -15, "world"),
      ],
      imageWidth: 400,
      imageHeight: 200,
      rect: { x: 0, y: 0, width: 400, height: 200 },
    });

    expect(layout.segmented).toBe(false);
    const tiltedWidth =
      200 * Math.cos(radians(15)) + 20 * Math.sin(radians(15));
    expect(layout.combinedSourceRect.width).toBeCloseTo(tiltedWidth, 6);
    expect(layout.combinedSourceRect.x).toBeCloseTo(
      150 - tiltedWidth / 2,
      6,
    );
  });
});

describe("moveOverlayLayout", () => {
  const layout = buildOverlayLayout({
    ocrText: "hello\nworld",
    translationText: "one line for both",
    blocks: [
      {
        text: "hello",
        bbox: { x: 0, y: 0, width: 100, height: 10 },
        paragraph: 0,
        chars: [{ text: "h", bbox: { x: 0, y: 0, width: 20, height: 10 } }],
      },
      block(1, { x: 0, y: 50, width: 100, height: 10 }, "world"),
    ],
    imageWidth: 100,
    imageHeight: 100,
    rect: { x: 0, y: 0, width: 100, height: 100 },
  });

  it("shifts every rectangle a rebuild reads, not just the boxes on screen", () => {
    const moved = moveOverlayLayout(layout, 10, -5);
    const shifted = (before: Rect, after: Rect): boolean =>
      after.x === before.x + 10 &&
      after.y === before.y - 5 &&
      after.width === before.width &&
      after.height === before.height;

    expect(shifted(layout.combinedRect, moved.combinedRect)).toBe(true);
    expect(shifted(layout.combinedSourceRect, moved.combinedSourceRect)).toBe(
      true,
    );
    moved.paragraphs.forEach((paragraph, index) => {
      const before = layout.paragraphs[index];
      expect(shifted(before.sourceRect, paragraph.sourceRect)).toBe(true);
      expect(shifted(before.translationRect, paragraph.translationRect)).toBe(
        true,
      );
      paragraph.lines.forEach((line, lineIndex) => {
        expect(shifted(before.lines[lineIndex].rect, line.rect)).toBe(true);
        expect(
          shifted(
            before.lines[lineIndex].oriented!.rect,
            line.oriented!.rect,
          ),
        ).toBe(true);
      });
    });
    expect(moved.paragraphs[0].lines[0].chars?.[0].rect).toEqual({
      x: 10,
      y: -5,
      width: 20,
      height: 10,
    });
  });

  it("leaves the layout alone when nothing moved", () => {
    expect(moveOverlayLayout(layout, 0, 0)).toBe(layout);
  });
});
