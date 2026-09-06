import { describe, expect, it } from "vitest";
import { assembleGroupedResult, type RecognizedLine } from "./assemble";

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

function vcol(
  text: string,
  cx: number,
  cy: number,
  width = 60,
  height = 180,
  confidence = 1,
): RecognizedLine {
  return {
    text,
    bbox: {
      x: cx - width / 2,
      y: cy - height / 2,
      width,
      height,
    },
    confidence,
  };
}

describe("assembleGroupedResult", () => {
  it("uses the supplied groups even when geometry suggests another split", () => {
    const first = line("first", 10, 10);
    const distant = line("continuation", 10, 200);
    const nearby = line("separate", 10, 28);

    const result = assembleGroupedResult([[first, distant], [nearby]]);

    expect(result.text).toBe("first continuation\nseparate");
    expect(result.blocks?.map((block) => block.paragraph)).toEqual([0, 0, 1]);
  });

  it("orders horizontal rows and row fragments", () => {
    const result = assembleGroupedResult([[
      line("world", 60, 10),
      line("hello", 10, 10),
      line("second", 10, 40),
    ]]);

    expect(result.text).toBe("hello world second");
  });

  it("orders horizontal row fragments right-to-left", () => {
    const result = assembleGroupedResult(
      [[line("left", 10, 10), line("right", 60, 10)]],
      { direction: "rtl" },
    );

    expect(result.text).toBe("right left");
  });

  it("orders separate horizontal groups in reading direction", () => {
    const left = [line("left", 10, 10)];
    const right = [line("right", 100, 10)];

    expect(assembleGroupedResult([right, left]).text).toBe("left\nright");
    expect(
      assembleGroupedResult([left, right], { direction: "rtl" }).text,
    ).toBe("right\nleft");
  });

  it("reassembles hyphenated words across lines", () => {
    const result = assembleGroupedResult([[
      line("exam-", 10, 10),
      line("ple", 10, 28),
    ]]);

    expect(result.text).toBe("example");
  });

  it("joins CJK rows without spaces", () => {
    const result = assembleGroupedResult([[
      line("日本", 10, 10),
      line("語の文", 10, 28),
    ]]);

    expect(result.text).toBe("日本語の文");
  });

  it("filters empty and low-confidence lines before assembly", () => {
    const result = assembleGroupedResult([[
      line("", 10, 10),
      line("artifact", 10, 30, 80, 12, 0.69),
      line("kept", 10, 50, 80, 12, 0.7),
    ]]);

    expect(result.text).toBe("kept");
    expect(result.blocks?.map((block) => block.text)).toEqual(["kept"]);
  });

  it("chooses page orientation after filtering", () => {
    const result = assembleGroupedResult([[
      line("left", 10, 10),
      line("right", 60, 10),
      line("artifact", 200, 0, 20, 200, 0.2),
    ]]);

    expect(result.orientation).toBe("horizontal");
    expect(result.providerMeta).toMatchObject({ orientation: "horizontal" });
  });

  it("reports confidence and backend metadata", () => {
    const result = assembleGroupedResult(
      [[
        line("low", 10, 10, 40, 12, 0.7),
        line("high", 10, 40, 40, 12, 0.9),
      ]],
      { backend: "wasm" },
    );

    expect(result.confidence).toBeCloseTo(0.8, 5);
    expect(result.lang).toBeUndefined();
    expect(result.providerMeta).toMatchObject({ backend: "wasm", boxes: 2 });
  });

  it("handles no groups", () => {
    const result = assembleGroupedResult([]);

    expect(result.text).toBe("");
    expect(result.blocks).toEqual([]);
    expect(result.confidence).toBe(0);
    expect(result.orientation).toBe("horizontal");
  });

  it("sets orientation independently for each learned group", () => {
    const horizontal = [
      line("wide one", 300, 10, 400, 30),
      line("wide two", 300, 60, 400, 30),
    ];
    const vertical = [vcol("column", 60, 150, 40, 280)];

    const result = assembleGroupedResult([horizontal, vertical]);

    expect(result.orientation).toBe("horizontal");
    expect(
      result.blocks
        ?.filter((block) => block.text.startsWith("wide"))
        .every((block) => block.orientation === "horizontal"),
    ).toBe(true);
    expect(
      result.blocks?.find((block) => block.text === "column")?.orientation,
    ).toBe("vertical");
  });

  it("falls back to horizontal when every line is too square to vote", () => {
    const result = assembleGroupedResult([[line("square", 10, 10, 20, 18)]]);

    expect(result.blocks?.[0].orientation).toBe("horizontal");
  });

  it("uses a tilted column's reading angle on a horizontal page", () => {
    const result = assembleGroupedResult([
      [line("heading", 0, 0, 600, 40)],
      [{
        ...line("column", 100, 100, 109, 157),
        oriented: {
          rect: { x: 100, y: 100, width: 150, height: 50 },
          angle: 65 * Math.PI / 180,
        },
      }],
    ]);

    expect(result.orientation).toBe("horizontal");
    expect(result.blocks?.find((block) => block.text === "column")?.orientation).toBe("vertical");
  });

  it("lets square oriented boxes inherit the page orientation", () => {
    const result = assembleGroupedResult([
      [vcol("column", 300, 300, 40, 600)],
      [{
        ...line("mark", 100, 100, 30, 30),
        oriented: {
          rect: { x: 100, y: 100, width: 20, height: 18 },
          angle: 0.4,
        },
      }],
    ]);

    expect(result.blocks?.find((block) => block.text === "mark")?.orientation).toBe("vertical");
  });

  it("orders vertical columns right-to-left and split columns top-to-bottom", () => {
    const result = assembleGroupedResult([[
      vcol("左", 100, 200),
      vcol("後", 200, 300),
      vcol("前", 200, 100),
    ]]);

    expect(result.text).toBe("前後左");
    expect(result.orientation).toBe("vertical");
  });

  it("orders separate vertical groups right-to-left within a band", () => {
    const left = [vcol("左", 100, 200)];
    const right = [vcol("右", 300, 200)];

    const result = assembleGroupedResult([left, right]);

    expect(result.text).toBe("右\n左");
    expect(result.blocks?.map((block) => block.paragraph)).toEqual([0, 1]);
  });

  it("preserves optional oriented boxes and character data", () => {
    const oriented = {
      rect: { x: 12, y: 11, width: 38, height: 10 },
      angle: 0.2,
    };
    const result = assembleGroupedResult([[
      { ...line("with metadata", 10, 10), oriented, chars: [] },
      line("without metadata", 10, 30),
    ]]);

    expect(result.blocks?.[0]).toMatchObject({ oriented, chars: [] });
    expect(result.blocks?.[1]).not.toHaveProperty("oriented");
    expect(result.blocks?.[1]).not.toHaveProperty("chars");
  });
});
