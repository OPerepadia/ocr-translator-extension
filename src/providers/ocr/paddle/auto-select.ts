import type { DetectedBox } from "./db-postprocess";
import { LOW_CONFIDENCE_FILTER_THRESHOLD } from "./assemble";

export type RecognizerScript =
  | "general"
  | "cyrillic"
  | "hangul"
  | "arabic"
  | "devanagari";

export interface AutoRecognizerCandidate {
  id: string;
  script: RecognizerScript;
}

export interface ProbeRecognition {
  text: string;
  confidence: number;
}

export interface RecognizerProbeResult {
  candidate: AutoRecognizerCandidate;
  lines: ProbeRecognition[];
}

export interface RecognizerScore {
  modelId: string;
  score: number;
  confidence: number;
  meaningfulCharacters: number;
  scriptCharacters: number;
  eligible: boolean;
}

export interface AutoRecognizerChoice {
  modelId: string;
  decisive: boolean;
  scores: RecognizerScore[];
}

export const MAX_AUTO_PROBE_LINES = 5;

const MIN_SCRIPT_CHARACTERS = 2;
const MIN_SCORE_MARGIN = 0.05;
// Skip specialist models only with strong evidence from the general probe.
const GENERAL_RECOGNIZER_MIN_CONFIDENCE = 0.95;
const GENERAL_RECOGNIZER_MIN_SCRIPT_CHARACTERS = 8;
const GENERAL_RECOGNIZER_MIN_SCRIPT_RATIO = 0.8;
const MEANINGFUL_RE = /[\p{L}\p{N}]/gu;
const LETTER_RE = /\p{L}/gu;
const SCRIPT_RE: Record<RecognizerScript, RegExp> = {
  general: /[\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu,
  cyrillic: /\p{Script=Cyrillic}/gu,
  hangul: /\p{Script=Hangul}/gu,
  arabic: /\p{Script=Arabic}/gu,
  devanagari: /\p{Script=Devanagari}/gu,
};

export function initialAutoProbeCount(boxCount: number): number {
  return Math.min(boxCount, 1);
}

export function rankRepresentativeBoxes(
  boxes: DetectedBox[],
  imageWidth: number,
  imageHeight: number,
): number[] {
  const remaining = boxes.map((_, index) => index);
  const selected: number[] = [];
  const limit = Math.min(boxes.length, MAX_AUTO_PROBE_LINES);

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

export function chooseAutoRecognizer(
  results: RecognizerProbeResult[],
  defaultModelId: string,
): AutoRecognizerChoice {
  const summaries = results.map(summarizeProbeResult);
  const maxCoverage = Math.max(
    1,
    ...summaries.map(({ meaningfulCharacters }) => meaningfulCharacters),
  );

  const scores = summaries.map(
    ({
      candidate,
      confidence,
      meaningfulCharacters,
      letters,
      scriptCharacters,
    }) => {
      const scriptRatio = scriptCharacters / Math.max(1, letters);
      const specialized = candidate.script !== "general";
      // Specialized dictionaries also contain Latin characters. Require evidence
      // from their own script so good English output cannot displace v6.
      const eligible = !specialized || scriptCharacters >= MIN_SCRIPT_CHARACTERS;
      // Confidence scales differ between recognizers, so combine confidence with
      // output coverage and script consistency instead of comparing it directly.
      const score =
        0.8 * confidence +
        0.1 * (meaningfulCharacters / maxCoverage) +
        (specialized ? 0.24 : 0.04) * scriptRatio +
        (candidate.id === defaultModelId ? 0.02 : 0);

      return {
        modelId: candidate.id,
        score,
        confidence,
        meaningfulCharacters,
        scriptCharacters,
        eligible,
      };
    },
  );

  const ranked = scores
    .filter(({ eligible }) => eligible)
    .sort((a, b) => b.score - a.score);
  const winner =
    ranked[0] ?? scores.find(({ modelId }) => modelId === defaultModelId);
  const runnerUp = ranked[1];
  const usefulEvidence =
    (winner?.scriptCharacters ?? 0) >= MIN_SCRIPT_CHARACTERS;
  const margin = winner
    ? winner.score - (runnerUp?.score ?? -Infinity)
    : -Infinity;
  const decisive = Boolean(winner && usefulEvidence && margin >= MIN_SCORE_MARGIN);

  return {
    modelId: decisive ? winner!.modelId : defaultModelId,
    decisive,
    scores,
  };
}

export function tryChooseGeneralRecognizer(
  result: RecognizerProbeResult,
  defaultModelId: string,
): AutoRecognizerChoice {
  const choice = chooseAutoRecognizer([result], defaultModelId);
  const score = choice.scores[0];
  const scriptRatio =
    score.scriptCharacters / Math.max(1, score.meaningfulCharacters);
  return {
    ...choice,
    decisive:
      result.candidate.script === "general" &&
      score.confidence >= GENERAL_RECOGNIZER_MIN_CONFIDENCE &&
      score.scriptCharacters >= GENERAL_RECOGNIZER_MIN_SCRIPT_CHARACTERS &&
      scriptRatio >= GENERAL_RECOGNIZER_MIN_SCRIPT_RATIO,
  };
}

function summarizeProbeResult({
  candidate,
  lines,
}: RecognizerProbeResult) {
  let confidenceTotal = 0;
  let confidenceWeight = 0;
  let meaningfulCharacters = 0;
  let letters = 0;
  let scriptCharacters = 0;

  for (const line of lines) {
    if (line.confidence < LOW_CONFIDENCE_FILTER_THRESHOLD) {
      continue;
    }
    const meaningful = countMatches(line.text, MEANINGFUL_RE);
    const weight = Math.max(1, Math.min(meaningful, 20));
    confidenceTotal += line.confidence * weight;
    confidenceWeight += weight;
    meaningfulCharacters += meaningful;
    letters += countMatches(line.text, LETTER_RE);
    scriptCharacters += countMatches(line.text, SCRIPT_RE[candidate.script]);
  }

  return {
    candidate,
    confidence:
      confidenceWeight === 0 ? 0 : confidenceTotal / confidenceWeight,
    meaningfulCharacters,
    letters,
    scriptCharacters,
  };
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

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}
