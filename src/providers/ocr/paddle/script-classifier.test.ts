import { describe, expect, it } from "vitest";
import type { DetectedBox } from "./db-postprocess";
import {
  chooseScript,
  decodeScriptScores,
  rankRepresentativeBoxes,
  scriptImageToNchw,
  type ScriptLineEvidence,
} from "./script-classifier";

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

const labels = [
  "NULL",
  "Joined",
  "Broken",
  "Arabic",
  "Cyrillic",
  "Latin-dn",
  "HanS",
];

function scores(classes: number[]): Float32Array {
  const output = new Float32Array(classes.length * labels.length).fill(0.01);
  for (const [time, classIndex] of classes.entries()) {
    output[time * labels.length + classIndex] = 0.95;
  }
  return output;
}

function evidence(
  counts: ScriptLineEvidence["counts"],
  totalEmissions: number,
  confidence = 0.9,
): ScriptLineEvidence {
  return {
    counts,
    rawCounts: Object.fromEntries(Object.entries(counts)),
    confidenceTotals: Object.fromEntries(
      Object.entries(counts).map(([script, count]) => [
        script,
        count * confidence,
      ]),
    ),
    totalEmissions,
  };
}

describe("script classifier preprocessing", () => {
  it("normalizes a black and white line around -1 and 1", () => {
    const width = 4;
    const height = 48;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const value = i % width < 2 ? 0 : 255;
      rgba.set([value, value, value, 255], i * 4);
    }

    const output = scriptImageToNchw({ data: rgba, width, height });

    expect(output[0]).toBeLessThan(-0.99);
    expect(output[2]).toBeGreaterThan(0.99);
  });

  it("inverts predominantly dark lines", () => {
    const width = 4;
    const height = 48;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const value = i % width === 0 ? 255 : 0;
      rgba.set([value, value, value, 255], i * 4);
    }

    const output = scriptImageToNchw({ data: rgba, width, height });

    expect(output[0]).toBeLessThan(-0.99);
    expect(output[1]).toBeGreaterThan(0.99);
  });

  it("inverts white text on a red background", () => {
    const width = 8;
    const height = 48;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const x = i % width;
      rgba.set(
        x === 3 || x === 4 ? [255, 255, 255, 255] : [195, 24, 51, 255],
        i * 4,
      );
    }

    const output = scriptImageToNchw({ data: rgba, width, height });

    expect(output[3]).toBeLessThan(-0.99);
    expect(output[0]).toBeGreaterThan(0.99);
  });

  it("keeps black text on a red background", () => {
    const width = 8;
    const height = 48;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const x = i % width;
      rgba.set(
        x === 3 || x === 4 ? [0, 0, 0, 255] : [195, 24, 51, 255],
        i * 4,
      );
    }

    const output = scriptImageToNchw({ data: rgba, width, height });

    expect(output[3]).toBeLessThan(-0.99);
    expect(output[0]).toBeGreaterThan(0.95);
  });
});

describe("script classifier decoding", () => {
  it("collapses CTC repeats and merges label variants", () => {
    const output = scores([2, 5, 5, 2, 5, 2]);

    expect(
      decodeScriptScores(output, 6, labels.length, labels),
    ).toMatchObject({
      counts: { general: 2 },
      rawCounts: { "Latin-dn": 2 },
      totalEmissions: 2,
    });
  });

  it("keeps unsupported script emissions in the vote denominator", () => {
    const output = scores([3, 2, 1, 2]);

    expect(
      decodeScriptScores(output, 4, labels.length, labels),
    ).toMatchObject({
      counts: { arabic: 1 },
      rawCounts: { Arabic: 1, Joined: 1 },
      totalEmissions: 2,
    });
  });

  it("combines probabilities that route to the same recognizer", () => {
    const output = new Float32Array(labels.length);
    output[5] = 0.55;
    output[6] = 0.35;
    output[2] = 0.1;

    const decoded = decodeScriptScores(
      output,
      1,
      labels.length,
      labels,
    );

    expect(decoded.counts).toEqual({ general: 1 });
    expect(decoded.confidenceTotals.general).toBeCloseTo(0.9);
  });
});

describe("script classifier choice", () => {
  it("combines evidence from representative lines", () => {
    const prediction = chooseScript([
      evidence({ cyrillic: 2 }, 2),
      evidence({ cyrillic: 2, general: 1 }, 3),
    ]);

    expect(prediction).toMatchObject({
      script: "cyrillic",
      decisive: true,
      probeCount: 2,
      evidence: 4,
      voteRatio: 0.8,
      confidence: 0.9,
      rawCounts: { cyrillic: 4, general: 1 },
    });
  });

  it("returns the winner for short, mixed, and low-confidence evidence", () => {
    expect(chooseScript([evidence({ arabic: 1 }, 1)])).toMatchObject({
      script: "arabic",
      decisive: false,
    });
    expect(chooseScript([evidence({ hangul: 2 }, 2, 0.44)])).toMatchObject({
      script: "hangul",
      decisive: false,
      evidence: 2,
      voteRatio: 1,
      confidence: 0.44,
    });
    expect(chooseScript([evidence({ arabic: 2, general: 1 }, 3)])).toMatchObject(
      {
        script: "arabic",
        decisive: false,
      },
    );
    expect(chooseScript([evidence({ devanagari: 3 }, 3, 0.7)])).toMatchObject({
      script: "devanagari",
      decisive: false,
    });
  });
});

describe("representative script-classifier boxes", () => {
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
    expect(new Set(ranked)).toEqual(new Set([0, 1, 2]));
  });

  it("limits classification to three lines", () => {
    const boxes = Array.from({ length: 8 }, (_, index) =>
      box(index * 100, 20, 160, 20),
    );

    expect(rankRepresentativeBoxes(boxes, 1000, 400)).toHaveLength(3);
  });
});
