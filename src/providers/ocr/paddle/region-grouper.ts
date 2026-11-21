import type { OcrBlock, Rect } from "../../../shared/types";
import type { RecognizedLine } from "./assemble";
import { filterRecognizedLines } from "./assemble";
import { fetchJson } from "./utils";
import type { RgbaImage } from "./crop";
import { createSession, ort } from "./ort-env";

interface RegionManifest {
  version: number;
  id: string;
  modelPath: string;
  inputShape: [number, number, number];
  inputScale: number;
  origTargetSizeOrder: ["width", "height"];
  /** Class names by id. The class named "bubble" gives the speech-bubble
   * outlines, used to size the painted translations. */
  classes?: Record<string, string>;
  textClassIds: number[];
  confidenceThreshold: number;
  nmsIouThreshold: number;
}

export interface TextRegion {
  bbox: Rect;
  confidence: number;
}

/** One run of the layout model: the text regions that group lines, and the
 * speech bubbles around them. */
export interface RegionDetection {
  regions: TextRegion[];
  bubbles: TextRegion[];
}

interface RegionGroupingResult {
  groups: RecognizedLine[][];
  regionCount: number;
  matchedLineCount: number;
  /** Speech bubbles the layout model found. Empty when it did not run. */
  bubbles: TextRegion[];
}

const NESTED_REGION_CONTAINMENT_THRESHOLD = 0.9;
// Share of a paragraph's area a bubble must cover to count as its bubble.
const BUBBLE_MIN_CONTAINMENT = 0.7;
const NESTED_REGION_MIN_AREA_RATIO = 2;
const NESTED_REGION_COUNT_THRESHOLD = 2;

/** Treat every readable line as one region, without running the layout model.
 * For a strip that holds a single block of text, such as subtitles. */
export function groupAsSingleRegion(
  lines: RecognizedLine[],
): RegionGroupingResult {
  const eligible = filterRecognizedLines(lines);
  return {
    groups: eligible.length > 0 ? [eligible] : [],
    regionCount: 0,
    matchedLineCount: 0,
    bubbles: [],
  };
}

export class RegionGrouper {
  private constructor(
    private readonly manifest: RegionManifest,
    private readonly session: ort.InferenceSession,
  ) {}

  static async create(modelBaseUrl: string): Promise<RegionGrouper> {
    const manifest = await fetchJson<RegionManifest>(
      modelBaseUrl + "model-manifest.json",
    );
    validateManifest(manifest);
    const session = await createSession(
      modelBaseUrl + manifest.modelPath,
      "wasm",
    );
    return new RegionGrouper(manifest, session);
  }

  get metadata() {
    return {
      id: this.manifest.id,
      backend: "wasm" as const,
      confidenceThreshold: this.manifest.confidenceThreshold,
      nmsIouThreshold: this.manifest.nmsIouThreshold,
    };
  }

  /** The page's text regions (the text in speech bubbles and free text) and
   * its speech bubbles. */
  async detectRegions(source: RgbaImage): Promise<RegionDetection> {
    const [, height, width] = this.manifest.inputShape;
    const input = imageToNchw(
      source,
      width,
      height,
      this.manifest.inputScale,
    );
    const output = await this.session.run({
      images: new ort.Tensor("float32", input, [1, 3, height, width]),
      orig_target_sizes: new ort.Tensor(
        "int64",
        BigInt64Array.of(BigInt(source.width), BigInt(source.height)),
        [1, 2],
      ),
    });
    const decode = (classIds: number[]): TextRegion[] =>
      decodeTextRegions(
        output.labels.data as BigInt64Array,
        output.boxes.data as Float32Array,
        output.scores.data as Float32Array,
        source.width,
        source.height,
        classIds,
        this.manifest.confidenceThreshold,
        this.manifest.nmsIouThreshold,
      );
    const bubbleClassIds = Object.entries(this.manifest.classes ?? {})
      .filter(([, name]) => name === "bubble")
      .map(([id]) => Number(id));
    return {
      regions: decode(this.manifest.textClassIds),
      bubbles: bubbleClassIds.length > 0 ? decode(bubbleClassIds) : [],
    };
  }

  /** Group the lines by text region. Pass `detection` when it is already
   * known, to skip running the layout model again. */
  async group(
    source: RgbaImage | null,
    lines: RecognizedLine[],
    detection?: RegionDetection,
  ): Promise<RegionGroupingResult> {
    const eligible = filterRecognizedLines(lines);
    if (eligible.length <= 1) {
      return {
        ...groupAsSingleRegion(eligible),
        bubbles: detection?.bubbles ?? [],
      };
    }
    if (!source) {
      throw new Error("Text-region grouping requires source image pixels.");
    }

    const found = detection ?? (await this.detectRegions(source));
    const grouping = groupLinesByRegions(eligible, found.regions);
    return {
      ...grouping,
      regionCount: found.regions.length,
      bubbles: found.bubbles,
    };
  }

  dispose(): void {
    void this.session.release();
  }
}

export function imageToNchw(
  source: RgbaImage,
  targetWidth: number,
  targetHeight: number,
  scale = 1 / 255,
): Float32Array {
  const plane = targetWidth * targetHeight;
  const output = new Float32Array(plane * 3);
  const scaleX = source.width / targetWidth;
  const scaleY = source.height / targetHeight;
  for (let y = 0; y < targetHeight; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const pixel = y * targetWidth + x;
      const [r, g, b] = bilinearRgb(
        source,
        (x + 0.5) * scaleX - 0.5,
        (y + 0.5) * scaleY - 0.5,
      );
      output[pixel] = r * scale;
      output[plane + pixel] = g * scale;
      output[plane * 2 + pixel] = b * scale;
    }
  }
  return output;
}

export function decodeTextRegions(
  labels: ArrayLike<number | bigint>,
  boxes: ArrayLike<number>,
  scores: ArrayLike<number>,
  imageWidth: number,
  imageHeight: number,
  textClassIds: readonly number[],
  confidenceThreshold: number,
  nmsIouThreshold: number,
): TextRegion[] {
  if (labels.length !== scores.length || boxes.length !== scores.length * 4) {
    throw new Error("Text-region model returned incompatible output shapes.");
  }
  const allowed = new Set(textClassIds);
  const candidates: TextRegion[] = [];
  for (let index = 0; index < scores.length; index++) {
    const confidence = Number(scores[index]);
    const classId = Number(labels[index]);
    if (confidence < confidenceThreshold || !allowed.has(classId)) continue;
    const offset = index * 4;
    const left = clamp(Number(boxes[offset]), 0, imageWidth);
    const top = clamp(Number(boxes[offset + 1]), 0, imageHeight);
    const right = clamp(Number(boxes[offset + 2]), 0, imageWidth);
    const bottom = clamp(Number(boxes[offset + 3]), 0, imageHeight);
    if (right <= left || bottom <= top) continue;
    candidates.push({
      bbox: {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      },
      confidence,
    });
  }
  return suppressOverlaps(candidates, nmsIouThreshold);
}

export function suppressOverlaps(
  regions: TextRegion[],
  iouThreshold: number,
): TextRegion[] {
  const kept: TextRegion[] = [];
  for (const candidate of regions
    .slice()
    .sort((a, b) => b.confidence - a.confidence)) {
    if (
      kept.every(
        (region) => intersectionOverUnion(candidate.bbox, region.bbox) < iouThreshold,
      )
    ) {
      kept.push(candidate);
    }
  }
  return kept;
}

export function groupLinesByRegions(
  lines: RecognizedLine[],
  regions: TextRegion[],
): Omit<RegionGroupingResult, "regionCount" | "bubbles"> {
  const grouped = regions.map(() => [] as RecognizedLine[]);
  const unmatched: RecognizedLine[] = [];
  const enclosingRegions = findEnclosingRegions(regions);
  for (const line of lines) {
    const regionIndex = bestRegionIndex(line.bbox, regions, enclosingRegions);
    if (regionIndex === -1) unmatched.push(line);
    else grouped[regionIndex].push(line);
  }
  const matchedLineCount = grouped.reduce(
    (count, group) => count + group.length,
    0,
  );
  return {
    groups: [
      ...grouped.filter((group) => group.length > 0),
      ...unmatched.map((line) => [line]),
    ],
    matchedLineCount,
  };
}

/** Regions that hold several smaller ones, such as a panel-wide free-text box
 * around its speech bubbles. */
export function findEnclosingRegions(regions: TextRegion[]): Set<number> {
  const enclosing = new Set<number>();
  regions.forEach((candidate, candidateIndex) => {
    let nestedCount = 0;
    for (let index = 0; index < regions.length; index++) {
      if (index === candidateIndex) continue;
      const nested = regions[index];
      if (area(candidate.bbox) < area(nested.bbox) * NESTED_REGION_MIN_AREA_RATIO) {
        continue;
      }
      const containment =
        intersectionArea(candidate.bbox, nested.bbox) / area(nested.bbox);
      if (containment < NESTED_REGION_CONTAINMENT_THRESHOLD) continue;
      nestedCount++;
      if (nestedCount >= NESTED_REGION_COUNT_THRESHOLD) {
        enclosing.add(candidateIndex);
        break;
      }
    }
  });
  return enclosing;
}

function bestRegionIndex(
  line: Rect,
  regions: TextRegion[],
  ignoredRegions: ReadonlySet<number>,
): number {
  let bestIndex = -1;
  let bestContainment = -1;
  let bestArea = Number.POSITIVE_INFINITY;
  const centerX = line.x + line.width / 2;
  const centerY = line.y + line.height / 2;
  regions.forEach((region, index) => {
    if (ignoredRegions.has(index)) return;
    const containment = intersectionArea(line, region.bbox) / area(line);
    const containsCenter =
      centerX >= region.bbox.x &&
      centerX <= region.bbox.x + region.bbox.width &&
      centerY >= region.bbox.y &&
      centerY <= region.bbox.y + region.bbox.height;
    if (!containsCenter && containment < 0.5) return;
    const regionArea = area(region.bbox);
    if (
      containment > bestContainment ||
      (containment === bestContainment && regionArea < bestArea)
    ) {
      bestIndex = index;
      bestContainment = containment;
      bestArea = regionArea;
    }
  });
  return bestIndex;
}

function intersectionOverUnion(first: Rect, second: Rect): number {
  const intersection = intersectionArea(first, second);
  return intersection / Math.max(area(first) + area(second) - intersection, 1e-6);
}

function intersectionArea(first: Rect, second: Rect): number {
  const width = Math.max(
    0,
    Math.min(first.x + first.width, second.x + second.width) -
      Math.max(first.x, second.x),
  );
  const height = Math.max(
    0,
    Math.min(first.y + first.height, second.y + second.height) -
      Math.max(first.y, second.y),
  );
  return width * height;
}

function area(rect: Rect): number {
  return Math.max(rect.width * rect.height, 1e-6);
}

function bilinearRgb(
  source: RgbaImage,
  x: number,
  y: number,
): [number, number, number] {
  const x0 = clamp(Math.floor(x), 0, source.width - 1);
  const y0 = clamp(Math.floor(y), 0, source.height - 1);
  const x1 = Math.min(source.width - 1, x0 + 1);
  const y1 = Math.min(source.height - 1, y0 + 1);
  const fx = clamp(x - x0, 0, 1);
  const fy = clamp(y - y0, 0, 1);
  return [0, 1, 2].map((channel) => {
    const top =
      sample(source, x0, y0, channel) * (1 - fx) +
      sample(source, x1, y0, channel) * fx;
    const bottom =
      sample(source, x0, y1, channel) * (1 - fx) +
      sample(source, x1, y1, channel) * fx;
    return top * (1 - fy) + bottom * fy;
  }) as [number, number, number];
}

function sample(
  source: RgbaImage,
  x: number,
  y: number,
  channel: number,
): number {
  return source.data[(y * source.width + x) * 4 + channel];
}

function validateManifest(manifest: RegionManifest): void {
  if (
    manifest.inputShape.length !== 3 ||
    manifest.inputShape[0] !== 3 ||
    manifest.inputShape.some(
      (value) => !Number.isInteger(value) || value < 1,
    ) ||
    manifest.origTargetSizeOrder[0] !== "width" ||
    manifest.origTargetSizeOrder[1] !== "height" ||
    manifest.textClassIds.length === 0 ||
    !Number.isFinite(manifest.inputScale) ||
    !Number.isFinite(manifest.confidenceThreshold) ||
    !Number.isFinite(manifest.nmsIouThreshold)
  ) {
    throw new Error("Invalid text-region model manifest.");
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Give each paragraph the smallest speech bubble that holds the centre of its
 * lines and most of their area. Paragraphs outside any bubble, such as text
 * over the art, get none. */
export function attachBubbles(blocks: OcrBlock[], bubbles: TextRegion[]): void {
  if (bubbles.length === 0) {
    return;
  }
  const paragraphs = new Map<number, OcrBlock[]>();
  for (const block of blocks) {
    if (block.paragraph === undefined) continue;
    const group = paragraphs.get(block.paragraph) ?? [];
    group.push(block);
    paragraphs.set(block.paragraph, group);
  }
  for (const group of paragraphs.values()) {
    const bounds = unionRect(group.map((block) => block.bbox));
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    let best: Rect | undefined;
    for (const { bbox } of bubbles) {
      const holdsCenter =
        centerX >= bbox.x &&
        centerX <= bbox.x + bbox.width &&
        centerY >= bbox.y &&
        centerY <= bbox.y + bbox.height;
      if (
        !holdsCenter ||
        intersectionArea(bounds, bbox) / area(bounds) < BUBBLE_MIN_CONTAINMENT
      ) {
        continue;
      }
      if (!best || area(bbox) < area(best)) {
        best = bbox;
      }
    }
    if (best) {
      for (const block of group) {
        block.bubble = { ...best };
      }
    }
  }
}

function unionRect(rects: Rect[]): Rect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
