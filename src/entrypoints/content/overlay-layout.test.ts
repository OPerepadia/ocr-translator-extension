import { describe, expect, it } from "vitest";
import type { OcrBlock, Rect } from "../../shared/types";
import {
  buildOverlayLayout,
  groupParagraphs,
  mapBboxToPage,
} from "./overlay-layout";

function block(
  paragraph: number,
  bbox: Rect,
  text = "x",
): OcrBlock {
  return { text, bbox, paragraph };
}

describe("groupParagraphs", () => {
  it("unions block bboxes that share a paragraph index", () => {
    const groups = groupParagraphs([
      block(0, { x: 0, y: 0, width: 10, height: 4 }, "a"),
      block(0, { x: 12, y: 1, width: 8, height: 5 }, "b"),
      block(1, { x: 0, y: 20, width: 30, height: 6 }, "c"),
    ]);

    expect(groups).toEqual([
      { paragraph: 0, bbox: { x: 0, y: 0, width: 20, height: 6 }, texts: ["a", "b"] },
      { paragraph: 1, bbox: { x: 0, y: 20, width: 30, height: 6 }, texts: ["c"] },
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
    expect(layout.paragraphs[0].translationRect).toEqual(
      layout.paragraphs[0].sourceRect,
    );
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

  it("uses the dominant detected background tone for each overlay box", () => {
    const layout = buildOverlayLayout({
      ...base,
      blocks: [
        { ...base.blocks[0], backgroundTone: "dark" },
        { ...base.blocks[1], backgroundTone: "light" },
      ],
      ocrText: "hello\nworld",
      translationText: "bonjour\nmonde",
    });

    expect(layout.paragraphs.map((p) => p.backgroundTone)).toEqual([
      "dark",
      "light",
    ]);
    expect(layout.combinedBackgroundTone).toBe("light");
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

  it("widens and centers translated boxes for narrow vertical source text", () => {
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
});
