import { describe, expect, it } from "vitest";
import { assembleResult, type RecognizedLine } from "./assemble";

function line(
  text: string,
  x: number,
  y: number,
  width = 40,
  height = 12,
  confidence = 1,
): RecognizedLine {
  return { text, bbox: { x, y, width, height }, confidence };
}

describe("assembleResult", () => {
  it("orders rows top-to-bottom and columns left-to-right", () => {
    const result = assembleResult([
      line("world", 60, 10),
      line("hello", 10, 10),
      line("second", 10, 40),
    ]);
    // Aligned lines with normal leading form one paragraph -> one sentence.
    expect(result.text).toBe("hello world second");
  });

  it("orders row fragments right-to-left for RTL text", () => {
    const result = assembleResult(
      [line("left", 10, 10), line("right", 60, 10)],
      { direction: "rtl" },
    );

    expect(result.text).toBe("right left");
  });

  it("groups boxes with overlapping vertical centers onto one row", () => {
    const result = assembleResult([
      line("a", 10, 10),
      line("b", 55, 12), // close center -> same row
    ]);
    expect(result.text).toBe("a b");
    expect(result.blocks).toHaveLength(2);
  });

  it("splits side-by-side columns instead of merging them into wide rows", () => {
    const result = assembleResult([
      line("Left one", 10, 10),
      line("Right one", 400, 10), // same row Y, but a wide gutter away
      line("Left two", 10, 30),
      line("Right two", 400, 30),
    ]);
    // Each column reads top-to-bottom as its own paragraph, columns left-to-right.
    expect(result.text).toBe("Left one Left two\nRight one Right two");
    expect(result.blocks?.map((b) => b.paragraph)).toEqual([0, 0, 1, 1]);
  });

  it("orders separated RTL columns right-to-left", () => {
    const result = assembleResult(
      [
        line("Left one", 10, 10),
        line("Right one", 400, 10),
        line("Left two", 10, 30),
        line("Right two", 400, 30),
      ],
      { direction: "rtl" },
    );

    expect(result.text).toBe("Right one Right two\nLeft one Left two");
  });

  it("keeps distant speech bubbles split when lower text overlaps both x-ranges", () => {
    const result = assembleResult([
      line("left bubble", 20, 20, 120, 20),
      line("right bubble", 230, 20, 120, 20),
      line("lower bridge", 110, 180, 150, 20),
    ]);

    expect(result.text).toBe("left bubble\nright bubble\nlower bridge");
    expect(result.blocks?.map((b) => b.paragraph)).toEqual([0, 1, 2]);
  });

  it("keeps a centered paragraph together despite shifting left edges", () => {
    // Centered lines narrow toward a shared centre, so each line's left edge
    // shifts right — but the centre stays, so it's one paragraph, not blocks.
    const result = assembleResult([
      line("the first widest line", 10, 10, 200), // center 110
      line("a shorter middle line", 40, 28, 140), // center 110
      line("short last", 70, 46, 80), // center 110
    ]);
    expect(result.text).toBe(
      "the first widest line a shorter middle line short last",
    );
    expect(new Set(result.blocks?.map((b) => b.paragraph)).size).toBe(1);
  });

  it("keeps a single column with ragged line widths unsplit", () => {
    const result = assembleResult([
      line("A longer first line here", 10, 10, 200),
      line("short", 10, 28, 60),
      line("another medium line", 10, 46, 150),
    ]);
    // Lines share horizontal space, so no gutter -> one column, one paragraph.
    expect(result.text).toBe(
      "A longer first line here short another medium line",
    );
    expect(new Set(result.blocks?.map((b) => b.paragraph)).size).toBe(1);
  });

  it("breaks a paragraph on a blank-line gap", () => {
    const result = assembleResult([
      line("first", 10, 10),
      line("second", 10, 80), // gap ~5.6x height -> new paragraph
    ]);
    expect(result.text).toBe("first\nsecond");
    expect(result.blocks?.map((b) => b.paragraph)).toEqual([0, 1]);
  });

  it("splits sparse callout labels even when all gaps are large", () => {
    const result = assembleResult([
      line("最初のラベル", 90, 90, 170, 20),
      line("次のラベルです", 115, 310, 240, 20),
      line("最後のラベル", 90, 455, 230, 20),
    ]);
    expect(result.text).toBe(
      "最初のラベル\n次のラベルです\n最後のラベル",
    );
    expect(result.blocks?.map((b) => b.paragraph)).toEqual([0, 1, 2]);
  });

  it("splits manga panels when padded OCR boxes make the panel gap look smaller", () => {
    const result = assembleResult([
      line("最初の行", 17, 372, 307, 64),
      line("続きの行です", 16, 439, 397, 64),
      line("次の段落", 34, 627, 176, 64),
      line("続きの文です", 32, 697, 318, 64),
      line("さらに続く", 29, 781, 176, 64),
      line("最後の行です", 29, 849, 399, 64),
    ]);
    expect(result.text).toBe(
      "最初の行続きの行です\n" +
        "次の段落続きの文ですさらに続く最後の行です",
    );
    expect(result.blocks?.map((b) => b.paragraph)).toEqual([
      0, 0, 1, 1, 1, 1,
    ]);
  });

  it("reassembles a word hyphenated across a line break", () => {
    const result = assembleResult([
      line("exam-", 10, 10),
      line("ple", 10, 28),
    ]);
    expect(result.text).toBe("example");
  });

  it("joins CJK lines without inserting spaces", () => {
    const result = assembleResult([
      line("日本", 10, 10),
      line("語の文", 10, 28),
    ]);
    expect(result.text).toBe("日本語の文");
  });

  it("breaks a short capitalized list item off the previous line", () => {
    const result = assembleResult([
      line("Coffee", 10, 10),
      line("Tea", 10, 32), // gap ~0.83x height + capital + short -> list item
    ]);
    expect(result.text).toBe("Coffee\nTea");
  });

  it("breaks each bullet into its own paragraph but keeps wrapped lines", () => {
    const result = assembleResult([
      line("• First generic bullet starts here", 10, 10),
      line("and continues on the next line", 10, 28), // wrapped continuation -> joins
      line("• Second generic bullet starts here", 10, 46),
      line("Another generic continuation follows.", 10, 64), // capital but long -> joins
    ]);
    expect(result.text).toBe(
      "• First generic bullet starts here and continues on the next line\n" +
        "• Second generic bullet starts here Another generic continuation follows.",
    );
    expect(result.blocks?.map((b) => b.paragraph)).toEqual([0, 0, 1, 1]);
  });

  it("breaks on enumerator markers like 1. and 2.", () => {
    const result = assembleResult([
      line("1. First item", 10, 10),
      line("2. Second item", 10, 28),
    ]);
    expect(result.text).toBe("1. First item\n2. Second item");
  });

  it("drops empty text and never reports a language", () => {
    const result = assembleResult([line("  ", 10, 10), line("kept", 10, 40)]);
    expect(result.text).toBe("kept");
    expect(result.lang).toBeUndefined();
  });

  it("drops low-confidence fragments", () => {
    const result = assembleResult([
      line("AL", 10, 10, 30, 12, 0.15),
      line("最初の行", 70, 10, 120, 24, 0.98),
      line("文", 210, 10, 24, 24, 0.65),
      line("次の行です", 70, 50, 200, 32, 1),
      line("字", 300, 50, 24, 24, 0.18),
      line("Sample label", 70, 100, 180, 24, 1),
      line("generic low-confidence text", 70, 140, 240, 24, 0.69),
    ]);

    expect(result.blocks?.map((block) => block.text)).toEqual([
      "最初の行",
      "次の行です",
      "Sample label",
    ]);
    expect(result.text).not.toContain("AL");
    expect(result.text).not.toContain("文");
    expect(result.text).not.toContain("字");
    expect(result.text).not.toContain("generic low-confidence text");
  });

  it("drops low-confidence text without checking surrounding text", () => {
    const result = assembleResult([line("文", 10, 10, 24, 24, 0.65)]);

    expect(result.text).toBe("");
  });

  it("chooses orientation after dropping low-confidence lines", () => {
    const result = assembleResult([
      line("left", 10, 10),
      line("right", 60, 10),
      line("artifact 1", 200, 0, 20, 200, 0.2),
      line("artifact 2", 230, 0, 20, 200, 0.2),
    ]);

    expect(result.text).toBe("left right");
    expect(result.orientation).toBe("horizontal");
    expect(result.providerMeta).toMatchObject({ orientation: "horizontal" });
  });

  it("averages block confidences", () => {
    const result = assembleResult([
      line("low", 10, 10, 40, 12, 0.7),
      line("high", 10, 40, 40, 12, 0.9),
    ]);
    expect(result.confidence).toBeCloseTo(0.8, 5);
  });

  it("handles no lines", () => {
    const result = assembleResult([]);
    expect(result.text).toBe("");
    expect(result.blocks).toEqual([]);
    expect(result.confidence).toBe(0);
  });
});

describe("assembleResult per-paragraph orientation", () => {
  it("marks a tall column vertical on a page that reads horizontally", () => {
    // A page of wide lines outvotes the one column, so the whole capture is
    // assembled horizontally — the column still has to read the way it is set.
    const result = assembleResult([
      line("wide one", 300, 10, 400, 30),
      line("wide two", 300, 60, 400, 30),
      line("wide three", 300, 110, 400, 30),
      { text: "column", bbox: { x: 40, y: 10, width: 40, height: 300 }, confidence: 1 },
    ]);

    expect(result.orientation).toBe("horizontal");
    const column = result.blocks?.find((block) => block.text === "column");
    expect(column?.orientation).toBe("vertical");
    expect(
      result.blocks
        ?.filter((block) => block.text.startsWith("wide"))
        .every((block) => block.orientation === "horizontal"),
    ).toBe(true);
  });

  it("keeps one orientation across a paragraph's lines", () => {
    const result = assembleResult([
      line("first", 10, 10, 200, 20),
      line("second", 10, 40, 200, 20),
    ]);
    const orientations = new Set(result.blocks?.map((b) => b.orientation));
    expect([...orientations]).toEqual(["horizontal"]);
  });

  it("falls back to horizontal when every line is too square to vote", () => {
    const result = assembleResult([line("a", 10, 10, 20, 18)]);
    expect(result.blocks?.[0].orientation).toBe("horizontal");
  });
});

describe("assembleResult tilted boxes", () => {
  const oriented = {
    rect: { x: 12, y: 11, width: 38, height: 10 },
    angle: 0.2,
  };

  it("carries a line's tilted box onto its block", () => {
    const result = assembleResult([{ ...line("hello", 10, 10), oriented }]);
    expect(result.blocks?.[0].oriented).toEqual(oriented);
  });

  it("carries it through the vertical path too", () => {
    const result = assembleResult([
      { ...vcol("最初", 709, 221), oriented },
      vcol("最後", 602, 257),
    ]);
    const tilted = result.blocks?.find((b) => b.text === "最初");
    expect(result.orientation).toBe("vertical");
    expect(tilted?.oriented).toEqual(oriented);
  });

  it("leaves the field off when the provider reports none", () => {
    const result = assembleResult([line("hello", 10, 10)]);
    expect(result.blocks?.[0]).not.toHaveProperty("oriented");
  });
});

// A vertical column box: centred at (cx, cy), narrow and tall.
function vcol(
  text: string,
  cx: number,
  cy: number,
  w = 80,
  h = 240,
  confidence = 1,
): RecognizedLine {
  return {
    text,
    bbox: { x: cx - w / 2, y: cy - h / 2, width: w, height: h },
    confidence,
  };
}

describe("assembleResult vertical CJK", () => {
  it("reads one block's columns right-to-left", () => {
    const result = assembleResult([
      vcol("最後", 602, 257),
      vcol("最初", 709, 221),
      vcol("中央の列", 655, 303),
    ]);
    expect(result.text).toBe("最初中央の列最後");
    expect(result.orientation).toBe("vertical");
    expect(result.providerMeta).toMatchObject({ orientation: "vertical" });
  });

  it("keeps separate bubbles from interleaving", () => {
    const result = assembleResult([
      vcol("最初", 709, 221),
      vcol("中央の列", 655, 303),
      vcol("最後", 602, 257),
      vcol("別の", 951, 442),
      vcol("段落です", 896, 493),
    ]);
    const lines = result.text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines).toContain("最初中央の列最後");
    expect(lines).toContain("別の段落です");
  });

  it("groups a full multi-bubble page", () => {
    const result = assembleResult([
      vcol("左", 182, 149, 82, 134),
      vcol("側の段落", 156, 197, 80, 389),
      vcol("です", 73, 97, 87, 135),
      vcol("単独", 1116, 160, 82, 236),
      vcol("最初", 709, 221, 77, 190),
      vcol("中央の列", 655, 303, 82, 337),
      vcol("最後", 602, 257, 84, 238),
      vcol("別の", 951, 442, 78, 287),
      vcol("段落です", 896, 493, 83, 396),
      vcol("です", 102, 726, 77, 231),
      vcol("最後の段落", 155, 753, 70, 282),
    ]);
    const lines = result.text.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines).toContain("左側の段落です");
    expect(lines).toContain("単独");
    expect(lines).toContain("最初中央の列最後");
    expect(lines).toContain("別の段落です");
    expect(lines).toContain("最後の段落です");
    // Every box keeps a block index, and there are exactly 5 blocks.
    expect(new Set(result.blocks?.map((b) => b.paragraph)).size).toBe(5);
  });

  it("orders a single split column top-to-bottom", () => {
    // One column recognized as two stacked boxes (same cx).
    const result = assembleResult([
      vcol("後半", 200, 400, 60, 180),
      vcol("前半", 200, 200, 60, 180),
    ]);
    expect(result.text).toBe("前半後半");
  });

  it("reads a horizontal run inside a vertical capture left-to-right", () => {
    // A vertical tagline with a horizontal copyright footer below (key visual
    // layout): the footer's boxes must not be ordered right-to-left as columns.
    const result = assembleResult([
      vcol("縦の", 300, 150),
      vcol("文章", 200, 150),
      line("Footer", 40, 600, 100, 24),
      line("text", 160, 600, 120, 24),
    ]);

    expect(result.text).toBe("縦の文章\nFooter text");
    expect(result.orientation).toBe("vertical");
    const byText = new Map(result.blocks?.map((b) => [b.text, b.orientation]));
    expect(byText.get("縦の")).toBe("vertical");
    expect(byText.get("Footer")).toBe("horizontal");
    expect(byText.get("text")).toBe("horizontal");
  });

  it("drops low-confidence vertical columns", () => {
    const result = assembleResult([
      vcol("左", 182, 149, 82, 134, 0.4),
      vcol("側の段落", 156, 197, 80, 389),
      vcol("です", 73, 97, 87, 135, 0.55),
    ]);

    expect(result.text).toBe("側の段落");
  });

  it("never merges boxes of different orientation into one block", () => {
    // A full-width horizontal banner touches two far-apart vertical columns.
    // It must not bridge them: a block never mixes vertical and horizontal
    // boxes, so the columns stay separate instead of forming one page-wide box.
    const result = assembleResult([
      vcol("たて", 130, 250, 60, 400), // left column
      vcol("たて", 910, 250, 60, 400), // right column, a page-width away
      line("よこながのバナーです", 0, 460, 1000, 120), // full-width banner
    ]);

    // Three boxes, three separate blocks — the banner glues nothing together.
    expect(new Set(result.blocks?.map((b) => b.paragraph)).size).toBe(3);
    // Only the banner spans the page; neither column grew page-wide.
    const pageWide = result.blocks?.filter((b) => b.bbox.width >= 1000) ?? [];
    expect(pageWide).toHaveLength(1);
  });

  it("keeps two vertical bubbles apart despite a horizontal bar between them", () => {
    // Vertical-dominant page (block clustering path): a horizontal bar touches
    // both bubbles from below. It must not bridge them into one block, and the
    // columns still read right-to-left.
    const result = assembleResult([
      vcol("みぎ", 600, 200, 80, 300), // right bubble
      vcol("ひだり", 200, 200, 80, 300), // left bubble
      line("よこ", 150, 360, 500, 60), // horizontal bar spanning under both
    ]);

    expect(result.orientation).toBe("vertical");
    const paragraphByText = new Map(
      result.blocks?.map((b) => [b.text, b.paragraph]),
    );
    // Three distinct blocks; the bar glued nothing together.
    expect(new Set(paragraphByText.values()).size).toBe(3);
    // The right bubble reads before the left one.
    expect(paragraphByText.get("みぎ") ?? 0).toBeLessThan(
      paragraphByText.get("ひだり") ?? 0,
    );
  });
});
