import { fetchJson } from "./utils";
import { cropQuadToImageData, type RgbaImage } from "./crop";
import type { DetectedBox } from "./db-postprocess";
import { createSession, ort, runSingleInput } from "./ort-env";
import type { RecognizerScript } from "./protocol";

const NULL_CLASS = 0;
const BLANK_CLASS = 2;
const MIN_EVIDENCE = 2;
const MIN_VOTE_RATIO = 0.7;
const MIN_MEAN_CONFIDENCE = 0.72;
const BACKGROUND_DARKER_DISTANCE_RATIO = 0.8;

const MAX_SCRIPT_PROBE_LINES = 3;
const SCRIPT_INPUT_HEIGHT = 48;

type ScriptCounts = Partial<Record<RecognizerScript, number>>;

export interface ScriptLineEvidence {
  counts: ScriptCounts;
  rawCounts: Record<string, number>;
  confidenceTotals: ScriptCounts;
  totalEmissions: number;
}

export interface ScriptPrediction {
  script?: RecognizerScript;
  decisive: boolean;
  probeCount: number;
  evidence: number;
  voteRatio: number;
  confidence: number;
  counts: ScriptCounts;
  rawCounts: Record<string, number>;
}

export class ScriptClassifier {
  private constructor(
    private readonly session: ort.InferenceSession,
    private readonly labels: string[],
  ) {}

  static async create(modelBaseUrl: string): Promise<ScriptClassifier> {
    const [session, labels] = await Promise.all([
      createSession(modelBaseUrl + "osd_lstm.onnx", "wasm"),
      fetchJson<string[]>(modelBaseUrl + "osd_labels.json"),
    ]);
    return new ScriptClassifier(session, labels);
  }

  async classify(image: RgbaImage): Promise<ScriptLineEvidence> {
    if (image.height !== SCRIPT_INPUT_HEIGHT || image.width < 3) {
      throw new Error(
        `Invalid script classifier input: ${image.width}x${image.height}`,
      );
    }
    const tensor = new ort.Tensor(
      "float32",
      scriptImageToNchw(image),
      [1, 1, image.height, image.width],
    );
    const output = await runSingleInput(this.session, tensor);
    const timeSteps = output.dims[0];
    const numClasses = output.dims[1];
    return decodeScriptScores(
      output.data as Float32Array,
      timeSteps,
      numClasses,
      this.labels,
    );
  }

  async detect(
    source: RgbaImage,
    boxes: DetectedBox[],
    maxImageWidth: number,
    isCancelled: () => boolean,
  ): Promise<ScriptPrediction> {
    const evidence: ScriptLineEvidence[] = [];
    const boxIndices = rankRepresentativeBoxes(
      boxes,
      source.width,
      source.height,
    );
    for (const boxIndex of boxIndices) {
      if (isCancelled()) {
        throw new DOMException("Aborted", "AbortError");
      }
      const crop = cropQuadToImageData(
        source,
        boxes[boxIndex].quad,
        SCRIPT_INPUT_HEIGHT,
        3,
        maxImageWidth,
      );
      evidence.push(await this.classify(crop));
    }
    return chooseScript(evidence);
  }

  dispose(): void {
    void this.session.release();
  }
}

export function scriptImageToNchw(image: RgbaImage): Float32Array {
  const plane = image.width * image.height;
  const gray = new Uint8Array(plane);
  for (let i = 0; i < plane; i++) {
    const offset = i * 4;
    const alpha = image.data[offset + 3] / 255;
    const inverseAlpha = 1 - alpha;
    const r = image.data[offset] * alpha + 255 * inverseAlpha;
    const g = image.data[offset + 1] * alpha + 255 * inverseAlpha;
    const b = image.data[offset + 2] * alpha + 255 * inverseAlpha;
    const value = Math.floor(0.3 * r + 0.5 * g + 0.2 * b + 0.5);
    gray[i] = value;
  }

  let { black, white } = blackWhite(gray, image.width, image.height);
  const background = borderMedian(gray, image.width, image.height);
  if (
    Math.abs(background - black) <
    Math.abs(background - white) * BACKGROUND_DARKER_DISTANCE_RATIO
  ) {
    for (let i = 0; i < gray.length; i++) {
      gray[i] = 255 - gray[i];
    }
    ({ black, white } = blackWhite(gray, image.width, image.height));
  }

  const contrast = Math.max(1, (white - black) / 2);
  const output = new Float32Array(plane);
  for (let i = 0; i < plane; i++) {
    output[i] = (gray[i] - black) / contrast - 1;
  }
  return output;
}

function borderMedian(
  gray: Uint8Array,
  width: number,
  height: number,
): number {
  const histogram = new Uint32Array(256);
  let count = 0;
  for (let x = 0; x < width; x++) {
    histogram[gray[x]]++;
    count++;
    if (height > 1) {
      histogram[gray[(height - 1) * width + x]]++;
      count++;
    }
  }
  for (let y = 1; y < height - 1; y++) {
    histogram[gray[y * width]]++;
    count++;
    if (width > 1) {
      histogram[gray[y * width + width - 1]]++;
      count++;
    }
  }
  return histogramMedian(histogram, count);
}

export function decodeScriptScores(
  scores: Float32Array,
  timeSteps: number,
  numClasses: number,
  labels: string[],
): ScriptLineEvidence {
  if (scores.length !== timeSteps * numClasses || labels.length !== numClasses) {
    throw new Error("Unexpected script classifier output shape.");
  }

  const counts: ScriptCounts = {};
  const rawCounts: Record<string, number> = {};
  const confidenceTotals: ScriptCounts = {};
  const labelScripts = labels.map(labelToScript);
  let totalEmissions = 0;
  let previous = BLANK_CLASS;

  for (let time = 0; time < timeSteps; time++) {
    const offset = time * numClasses;
    let bestClass = 0;
    let bestScore = scores[offset];
    for (let classIndex = 1; classIndex < numClasses; classIndex++) {
      const score = scores[offset + classIndex];
      if (score > bestScore) {
        bestClass = classIndex;
        bestScore = score;
      }
    }

    if (bestClass !== BLANK_CLASS && bestClass !== previous) {
      if (bestClass !== NULL_CLASS) {
        totalEmissions++;
        const label = labels[bestClass] ?? `class-${bestClass}`;
        rawCounts[label] = (rawCounts[label] ?? 0) + 1;
        const script = labelScripts[bestClass];
        if (script) {
          counts[script] = (counts[script] ?? 0) + 1;
          let familyConfidence = 0;
          for (let classIndex = 0; classIndex < numClasses; classIndex++) {
            if (labelScripts[classIndex] === script) {
              familyConfidence += scores[offset + classIndex];
            }
          }
          confidenceTotals[script] =
            (confidenceTotals[script] ?? 0) + familyConfidence;
        }
      }
    }
    previous = bestClass;
  }

  return { counts, rawCounts, confidenceTotals, totalEmissions };
}

export function chooseScript(lines: ScriptLineEvidence[]): ScriptPrediction {
  const counts: ScriptCounts = {};
  const rawCounts: Record<string, number> = {};
  const confidenceTotals: ScriptCounts = {};
  let totalEmissions = 0;
  for (const line of lines) {
    totalEmissions += line.totalEmissions;
    for (const [label, count] of Object.entries(line.rawCounts)) {
      rawCounts[label] = (rawCounts[label] ?? 0) + count;
    }
    for (const script of RECOGNIZER_SCRIPTS) {
      counts[script] = (counts[script] ?? 0) + (line.counts[script] ?? 0);
      confidenceTotals[script] =
        (confidenceTotals[script] ?? 0) +
        (line.confidenceTotals[script] ?? 0);
    }
  }

  const ranked = RECOGNIZER_SCRIPTS
    .map((script) => ({ script, count: counts[script] ?? 0 }))
    .sort((a, b) => b.count - a.count);
  const winner = ranked[0];
  const runnerUp = ranked[1];
  const evidence = winner.count;
  const voteRatio = evidence / Math.max(1, totalEmissions);
  const confidence =
    evidence === 0 ? 0 : (confidenceTotals[winner.script] ?? 0) / evidence;
  const decisive =
    evidence >= MIN_EVIDENCE &&
    evidence > runnerUp.count &&
    voteRatio >= MIN_VOTE_RATIO &&
    confidence >= MIN_MEAN_CONFIDENCE;

  return {
    ...(evidence > 0 ? { script: winner.script } : {}),
    decisive,
    probeCount: lines.length,
    evidence,
    voteRatio,
    confidence,
    counts,
    rawCounts,
  };
}

export function rankRepresentativeBoxes(
  boxes: DetectedBox[],
  imageWidth: number,
  imageHeight: number,
): number[] {
  const remaining = boxes.map((_, index) => index);
  const selected: number[] = [];
  const limit = Math.min(boxes.length, MAX_SCRIPT_PROBE_LINES);

  while (selected.length < limit) {
    let bestPosition = 0;
    let bestScore = -Infinity;
    for (let position = 0; position < remaining.length; position++) {
      const index = remaining[position];
      const box = boxes[index];
      let score = probeQuality(box);

      if (selected.length > 0) {
        score *=
          0.5 +
          0.5 *
            distanceFromSelection(
              box,
              selected.map((selectedIndex) => boxes[selectedIndex]),
              imageWidth,
              imageHeight,
            );
        if (
          selected.every(
            (selectedIndex) =>
              orientation(boxes[selectedIndex]) !== orientation(box),
          )
        ) {
          score *= 1.15;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestPosition = position;
      }
    }

    selected.push(remaining[bestPosition]);
    remaining.splice(bestPosition, 1);
  }

  return selected;
}

function probeQuality(box: DetectedBox): number {
  const longSide = Math.max(box.bbox.width, box.bbox.height);
  const shortSide = Math.max(1, Math.min(box.bbox.width, box.bbox.height));
  const estimatedCharacters = Math.max(1, Math.min(longSide / shortSide, 12));
  const resolution = Math.max(0.25, Math.min(shortSide / 24, 1));
  return box.score * estimatedCharacters * resolution;
}

function distanceFromSelection(
  box: DetectedBox,
  selected: DetectedBox[],
  imageWidth: number,
  imageHeight: number,
): number {
  const center = boxCenter(box);
  let closest = Infinity;
  for (const existing of selected) {
    const other = boxCenter(existing);
    const dx = (center.x - other.x) / Math.max(1, imageWidth);
    const dy = (center.y - other.y) / Math.max(1, imageHeight);
    closest = Math.min(closest, Math.hypot(dx, dy) / Math.SQRT2);
  }
  return Math.min(1, closest);
}

function boxCenter(box: DetectedBox): { x: number; y: number } {
  return {
    x: box.bbox.x + box.bbox.width / 2,
    y: box.bbox.y + box.bbox.height / 2,
  };
}

function orientation(box: DetectedBox): "horizontal" | "vertical" {
  return box.bbox.width >= box.bbox.height ? "horizontal" : "vertical";
}

function blackWhite(
  gray: Uint8Array,
  width: number,
  height: number,
): { black: number; white: number } {
  const mins = new Uint32Array(256);
  const maxes = new Uint32Array(256);
  if (width >= 3) {
    const rowOffset = Math.floor(height / 2) * width;
    let previous = gray[rowOffset];
    let current = gray[rowOffset + 1];
    for (let x = 1; x < width - 1; x++) {
      const next = gray[rowOffset + x + 1];
      if (
        (current < previous && current <= next) ||
        (current <= previous && current < next)
      ) {
        mins[current]++;
      }
      if (
        (current > previous && current >= next) ||
        (current >= previous && current > next)
      ) {
        maxes[current]++;
      }
      previous = current;
      current = next;
    }
  }
  if (bucketTotal(mins) === 0) {
    mins[0] = 1;
  }
  if (bucketTotal(maxes) === 0) {
    maxes[255] = 1;
  }
  return {
    black: percentile(mins, 0.25),
    white: percentile(maxes, 0.75),
  };
}

function percentile(buckets: Uint32Array, fraction: number): number {
  const total = bucketTotal(buckets);
  if (total === 0) {
    return 0;
  }
  const target = Math.min(total, Math.max(1, fraction * total));
  let sum = 0;
  for (let index = 0; index < buckets.length; index++) {
    sum += buckets[index];
    if (sum >= target) {
      return index + 1 - (sum - target) / buckets[index];
    }
  }
  return 0;
}

function histogramMedian(histogram: Uint32Array, count: number): number {
  const lower = Math.floor((count - 1) / 2);
  const upper = Math.floor(count / 2);
  let seen = 0;
  let lowerValue = 0;
  for (let value = 0; value < histogram.length; value++) {
    seen += histogram[value];
    if (seen > lower) {
      lowerValue = value;
      break;
    }
  }
  seen = 0;
  for (let value = 0; value < histogram.length; value++) {
    seen += histogram[value];
    if (seen > upper) {
      return (lowerValue + value) / 2;
    }
  }
  return lowerValue;
}

function bucketTotal(buckets: Uint32Array): number {
  let total = 0;
  for (const count of buckets) {
    total += count;
  }
  return total;
}

function labelToScript(label: string | undefined): RecognizerScript | undefined {
  const normalized = label?.replace(/-dn$/, "").replace(/_vert$/, "");
  switch (normalized) {
    case "Arabic":
      return "arabic";
    case "Cyrillic":
      return "cyrillic";
    case "Devanagari":
      return "devanagari";
    case "Hangul":
      return "hangul";
    case "Fraktur":
    case "HanS":
    case "HanT":
    case "Japanese":
    case "Latin":
    case "Vietnamese":
      return "general";
    default:
      return undefined;
  }
}

const RECOGNIZER_SCRIPTS: readonly RecognizerScript[] = [
  "general",
  "cyrillic",
  "hangul",
  "arabic",
  "devanagari",
];
