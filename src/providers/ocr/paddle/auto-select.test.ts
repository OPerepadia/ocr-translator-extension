import { describe, expect, it } from "vitest";
import type { DetectedBox } from "./db-postprocess";
import {
  chooseAutoRecognizer,
  initialAutoProbeCount,
  rankRepresentativeBoxes,
  tryChooseGeneralRecognizer,
  type RecognizerProbeResult,
} from "./auto-select";

function box(
  x: number,
  y: number,
  width: number,
  height: number,
  score = 0.9,
): DetectedBox {
  return {
    bbox: { x, y, width, height },
    quad: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
    score,
  };
}

function probes(
  general: { text: string; confidence: number },
  cyrillic: { text: string; confidence: number },
  korean: { text: string; confidence: number },
  arabic = { text: "", confidence: 0 },
  devanagari = { text: "", confidence: 0 },
): RecognizerProbeResult[] {
  return [
    {
      candidate: { id: "v6-multi", script: "general" },
      lines: [general],
    },
    {
      candidate: { id: "cyrillic-v5", script: "cyrillic" },
      lines: [cyrillic],
    },
    {
      candidate: { id: "korean-v5", script: "hangul" },
      lines: [korean],
    },
    {
      candidate: { id: "arabic-v5", script: "arabic" },
      lines: [arabic],
    },
    {
      candidate: { id: "devanagari-v5", script: "devanagari" },
      lines: [devanagari],
    },
  ];
}

describe("representative OCR boxes", () => {
  it("starts with one probe when text boxes are available", () => {
    expect(initialAutoProbeCount(0)).toBe(0);
    expect(initialAutoProbeCount(1)).toBe(1);
    expect(initialAutoProbeCount(3)).toBe(1);
    expect(initialAutoProbeCount(8)).toBe(1);
  });

  it("prefers substantial lines from different image regions", () => {
    const boxes = [
      box(20, 20, 240, 20),
      box(25, 55, 220, 20),
      box(700, 500, 200, 20),
      box(500, 250, 18, 18),
    ];

    const ranked = rankRepresentativeBoxes(boxes, 1000, 700);

    expect(ranked[0]).toBe(0);
    expect(ranked[1]).toBe(2);
    expect(new Set(ranked)).toEqual(new Set([0, 1, 2, 3]));
  });

  it("limits probing to five boxes", () => {
    const boxes = Array.from({ length: 8 }, (_, index) =>
      box(index * 100, 20, 160, 20),
    );

    expect(rankRepresentativeBoxes(boxes, 1000, 400)).toHaveLength(5);
  });
});

describe("automatic recognizer choice", () => {
  it("selects the Cyrillic recognizer when it produces Cyrillic text", () => {
    const choice = chooseAutoRecognizer(
      probes(
        { text: "Sample", confidence: 0.95 },
        { text: "Текст", confidence: 0.9 },
        { text: "Sample", confidence: 0.93 },
      ),
      "v6-multi",
    );

    expect(choice).toMatchObject({
      modelId: "cyrillic-v5",
      decisive: true,
    });
  });

  it("selects the Korean recognizer when it produces Hangul", () => {
    const choice = chooseAutoRecognizer(
      probes(
        { text: "EHLE", confidence: 0.96 },
        { text: "EHLE", confidence: 0.91 },
        { text: "안녕하세요", confidence: 0.88 },
      ),
      "v6-multi",
    );

    expect(choice).toMatchObject({
      modelId: "korean-v5",
      decisive: true,
    });
  });

  it("selects the Arabic recognizer when it produces Arabic text", () => {
    const choice = chooseAutoRecognizer(
      probes(
        { text: "Sample", confidence: 0.95 },
        { text: "Sample", confidence: 0.91 },
        { text: "Sample", confidence: 0.9 },
        { text: "تجربة", confidence: 0.88 },
      ),
      "v6-multi",
    );

    expect(choice).toMatchObject({
      modelId: "arabic-v5",
      decisive: true,
    });
  });

  it("selects the Devanagari recognizer when it produces Devanagari text", () => {
    const choice = chooseAutoRecognizer(
      probes(
        { text: "Sample", confidence: 0.95 },
        { text: "Sample", confidence: 0.91 },
        { text: "Sample", confidence: 0.9 },
        undefined,
        { text: "परीक्षण", confidence: 0.88 },
      ),
      "v6-multi",
    );

    expect(choice).toMatchObject({
      modelId: "devanagari-v5",
      decisive: true,
    });
  });

  it("keeps the default model for Latin text", () => {
    const choice = chooseAutoRecognizer(
      probes(
        { text: "Hello world", confidence: 0.9 },
        { text: "Hello world", confidence: 0.98 },
        { text: "Hello world", confidence: 0.99 },
      ),
      "v6-multi",
    );

    expect(choice).toMatchObject({ modelId: "v6-multi", decisive: true });
  });

  it("requests more evidence for script-neutral output", () => {
    const choice = chooseAutoRecognizer(
      probes(
        { text: "123", confidence: 0.99 },
        { text: "123", confidence: 0.99 },
        { text: "123", confidence: 0.99 },
      ),
      "v6-multi",
    );

    expect(choice).toMatchObject({ modelId: "v6-multi", decisive: false });
  });

  it("falls back to the default when a specialized lead is too small", () => {
    const choice = chooseAutoRecognizer(
      probes(
        { text: "D大E小", confidence: 0.34 },
        { text: "", confidence: 0 },
        { text: "그아스", confidence: 0.19 },
      ),
      "v6-multi",
    );

    expect(choice).toMatchObject({ modelId: "v6-multi", decisive: false });
  });

  it("ignores specialized evidence that the final result would filter out", () => {
    const choice = chooseAutoRecognizer(
      probes(
        { text: "Hello", confidence: 0.71 },
        { text: "", confidence: 0 },
        { text: "한글테", confidence: 0.69 },
      ),
      "v6-multi",
    );

    expect(choice).toMatchObject({ modelId: "v6-multi", decisive: true });
  });
});

describe("general recognizer fast path", () => {
  const generalCandidate = { id: "v6-multi", script: "general" } as const;

  it("accepts strong general-script evidence", () => {
    const choice = tryChooseGeneralRecognizer(
      {
        candidate: generalCandidate,
        lines: [{ text: "Sample text", confidence: 0.98 }],
      },
      "v6-multi",
    );

    expect(choice).toMatchObject({ modelId: "v6-multi", decisive: true });
  });

  it("requires enough supported characters", () => {
    const choice = tryChooseGeneralRecognizer(
      {
        candidate: generalCandidate,
        lines: [{ text: "Hello", confidence: 0.99 }],
      },
      "v6-multi",
    );

    expect(choice.decisive).toBe(false);
  });

  it("rejects weak confidence and script-neutral output", () => {
    const weak = tryChooseGeneralRecognizer(
      {
        candidate: generalCandidate,
        lines: [{ text: "Sample text", confidence: 0.94 }],
      },
      "v6-multi",
    );
    const neutral = tryChooseGeneralRecognizer(
      {
        candidate: generalCandidate,
        lines: [{ text: "1234567890", confidence: 0.99 }],
      },
      "v6-multi",
    );

    expect(weak.decisive).toBe(false);
    expect(neutral.decisive).toBe(false);
  });
});
