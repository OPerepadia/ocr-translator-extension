import { describe, expect, it } from "vitest";
import { ctcGreedyDecode, reverseArabicCtcText } from "./ctc";

// Small synthetic vocabulary: index 0 = blank, 1 = "a", 2 = "b", 3 = "c", 4 = " ".
const C = 5;
const charAt = (i: number): string | null =>
  i === 0 ? null : ["", "a", "b", "c", " "][i] ?? null;

/** Build a [T, C] probability map where each row one-hots the given index. */
function rows(indices: number[]): Float32Array {
  const out = new Float32Array(indices.length * C);
  indices.forEach((idx, t) => {
    out[t * C + idx] = 1;
  });
  return out;
}

describe("ctcGreedyDecode", () => {
  it("collapses consecutive repeats", () => {
    const result = ctcGreedyDecode(rows([1, 1, 2]), 3, C, charAt, true);
    expect(result.text).toBe("ab");
  });

  it("reports the timestep run each character won", () => {
    // "a" wins steps 1-2 (collapsed), blank at 3, "b" at 4.
    const result = ctcGreedyDecode(rows([0, 1, 1, 0, 2]), 5, C, charAt, true);
    expect(result.chars).toEqual([
      { char: "a", start: 1, end: 3 },
      { char: "b", start: 4, end: 5 },
    ]);
  });

  it("keeps repeats separated by a blank", () => {
    const result = ctcGreedyDecode(rows([1, 0, 1]), 3, C, charAt, true);
    expect(result.text).toBe("aa");
  });

  it("decodes the space class", () => {
    const result = ctcGreedyDecode(rows([1, 4, 2]), 3, C, charAt, true);
    expect(result.text).toBe("a b");
  });

  it("returns empty text for an all-blank sequence", () => {
    const result = ctcGreedyDecode(rows([0, 0, 0]), 3, C, charAt, true);
    expect(result.text).toBe("");
    expect(result.confidence).toBe(0);
  });

  it("averages kept max-probabilities for confidence", () => {
    // Two kept timesteps with probability 1.0 each.
    const result = ctcGreedyDecode(rows([1, 2]), 2, C, charAt, true);
    expect(result.text).toBe("ab");
    expect(result.confidence).toBeCloseTo(1, 5);
  });

  it("softmaxes logits when outputs are not probabilities", () => {
    // Equal logits -> softmax probability of the winner is 1/C.
    const logits = new Float32Array(C).fill(0);
    logits[1] = 0; // still equal; argmax picks index 0 (blank) on ties? No: > comparison keeps first max.
    // Make index 1 strictly the max so a char is emitted.
    logits[1] = 1;
    const result = ctcGreedyDecode(logits, 1, C, charAt, false);
    expect(result.text).toBe("a");
    // Confidence is a softmax probability in (0,1).
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(1);
  });
});

describe("reverseArabicCtcText", () => {
  it("converts Arabic CTC output to logical order", () => {
    expect(reverseArabicCtcText("ةبرجت")).toBe("تجربة");
  });

  it("preserves the order of embedded Latin text and numbers", () => {
    expect(reverseArabicCtcText("ABC-12ةبرجت")).toBe("تجربةABC-12");
  });
});
