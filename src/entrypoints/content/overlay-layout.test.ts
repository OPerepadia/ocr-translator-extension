import { describe, expect, it } from "vitest";
import type { OcrBlock, Rect } from "../../shared/types";
import {
  buildOverlayLayout,
  getRenderedImageRect,
  groupParagraphs,
  mapBboxToPage,
  moveOverlayLayout,
} from "./overlay-layout";

function block(
  paragraph: number,
  bbox: Rect,
  text = "x",
): OcrBlock {
  return { text, bbox, paragraph };
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

    expect(layout.paragraphs[0].lines).toEqual([
      { rect: { x: 10, y: 20, width: 50, height: 5 }, text: "hello", vertical: false },
      { rect: { x: 10, y: 30, width: 30, height: 5 }, text: "world", vertical: false },
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
