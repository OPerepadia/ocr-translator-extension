// Greedy CTC decoding for the PP-OCRv6 recognizer output. Pure TypeScript.

/** One decoded character and the timesteps whose argmax produced it. The
 * recognizer's timesteps map evenly across the width of the line crop, so this
 * run locates the character along the line. */
export interface CtcChar {
  char: string;
  /** First timestep of the run, inclusive. */
  start: number;
  /** Last timestep of the run, exclusive. */
  end: number;
}

export interface CtcResult {
  text: string;
  confidence: number;
  chars: CtcChar[];
}

/**
 * Decode a recognizer output of shape [T, C] (flattened row-major).
 *
 * @param logits  T*C values. Either raw logits or softmax probabilities.
 * @param timeSteps  T.
 * @param numClasses C (18710 for PP-OCRv6: blank + dict + space).
 * @param charAt  Maps a class index to its character, or null for blank.
 * @param outputsAreProbabilities  When false, applies a per-timestep softmax for
 *   the confidence estimate. Decoded text is identical either way.
 */
export function ctcGreedyDecode(
  logits: Float32Array,
  timeSteps: number,
  numClasses: number,
  charAt: (classIndex: number) => string | null,
  outputsAreProbabilities = false,
): CtcResult {
  const chars: CtcChar[] = [];
  const probs: number[] = [];
  let prevIndex = -1;

  for (let t = 0; t < timeSteps; t++) {
    const base = t * numClasses;

    let maxIndex = 0;
    let maxValue = logits[base];
    for (let c = 1; c < numClasses; c++) {
      const value = logits[base + c];
      if (value > maxValue) {
        maxValue = value;
        maxIndex = c;
      }
    }

    const isRepeat = maxIndex === prevIndex;
    prevIndex = maxIndex;

    // Blank (index 0) and CTC repeat collapse: skip but keep prevIndex updated.
    // A repeat still belongs to the character it repeats, so it widens its run.
    if (maxIndex === 0 || isRepeat) {
      if (isRepeat && maxIndex !== 0 && chars.length > 0) {
        chars[chars.length - 1].end = t + 1;
      }
      continue;
    }

    const char = charAt(maxIndex);
    if (char === null) {
      continue;
    }

    chars.push({ char, start: t, end: t + 1 });
    probs.push(
      outputsAreProbabilities
        ? maxValue
        : softmaxProbability(logits, base, numClasses, maxValue),
    );
  }

  const confidence =
    probs.length === 0
      ? 0
      : probs.reduce((sum, p) => sum + p, 0) / probs.length;

  return {
    text: chars.map((entry) => entry.char).join(""),
    confidence,
    chars,
  };
}

export function reverseArabicCtcText(text: string): string {
  const parts: string[] = [];
  let leftToRight = "";

  for (const char of text) {
    if (/[a-zA-Z0-9 :*./%+-]/.test(char)) {
      leftToRight += char;
      continue;
    }
    if (leftToRight) {
      parts.push(leftToRight);
      leftToRight = "";
    }
    parts.push(char);
  }
  if (leftToRight) {
    parts.push(leftToRight);
  }

  return parts.reverse().join("");
}

/** Probability of the winning class within one timestep's logit row. */
function softmaxProbability(
  logits: Float32Array,
  base: number,
  numClasses: number,
  maxValue: number,
): number {
  let sum = 0;
  for (let c = 0; c < numClasses; c++) {
    sum += Math.exp(logits[base + c] - maxValue);
  }
  return sum === 0 ? 0 : 1 / sum;
}
