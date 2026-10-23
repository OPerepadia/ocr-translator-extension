// PP-OCRv6 inference engine. Runs detector -> crop -> recognizer and assembles
// the result. Lives in the worker; uses ORT, OffscreenCanvas, and createImageBitmap.

import { assembleGroupedResult, type RecognizedLine } from "./assemble";
import { fetchJson, fetchText } from "./utils";
import { charBoxes } from "./char-boxes";
import {
  bitmapToImageData,
  cropQuadToImageData,
  cropRect,
  isRotatedForRecognition,
  padQuad,
  resizeToImageData,
  rotate90CounterClockwise,
  type RgbaImage,
} from "./crop";
import { ctcGreedyDecode, reverseArabicCtcText } from "./ctc";
import { extractBoxes, type DbConfig, type DetectedBox } from "./db-postprocess";
import { makeCharAt, parseDict } from "./dict";
import { orientedRectOfQuad } from "./geometry";
import {
  createSession,
  configureOrt,
  ort,
  resolveBackend,
  runSingleInput,
  type OrtBackend,
  warmUpSession,
} from "./ort-env";
import { computeDetSize, imageDataToNchw, type Rgb } from "./preprocess";
import type { InitRequest, WorkerModelConfig } from "./protocol";
import {
  findEnclosingRegions,
  groupAsSingleRegion,
  RegionGrouper,
  type TextRegion,
} from "./region-grouper";
import {
  readingScore,
  regionCrop,
  regionOf,
  toPageBox,
} from "./rotated-regions";
import { UNSUPPORTED_SCRIPT_ERROR } from "../types";
import {
  hasMajorityScript,
  ScriptClassifier,
  type ScriptPrediction,
} from "./script-classifier";
import type {
  OcrChar,
  OrientedRect,
  PipelineOcrResult,
  Rect,
} from "../../../shared/types";

interface Manifest {
  detector: {
    modelPath: string;
    maxSideLength: number;
    mean: Rgb;
    std: Rgb;
    threshold: number;
    boxThreshold: number;
    unclipRatio: number;
    minBoxSize: number;
    padding: number;
    splitThreshold?: number;
    /** Read each comic text region again, turned a quarter turn. */
    rotatedRegions?: boolean;
  };
  recognizer: {
    modelPath: string;
    dictPath: string;
    imageHeight: number;
    minImageWidth: number;
    maxImageWidth: number;
    mean: Rgb;
    std: Rgb;
  };
}

export type EngineOptions = Omit<InitRequest, "type" | "id" | "debug"> & {
  debug?: boolean;
};

export interface RecognizeOptions {
  modelId?: string;
  /** "single" reads the lines as one paragraph, without the layout model. */
  grouping?: "layout" | "single";
  /** Lines whose box is thinner than this, in image pixels, are not read. */
  minLineThickness?: number;
}

interface LoadedRecognizer {
  candidate: WorkerModelConfig;
  config: Manifest["recognizer"];
  session: ort.InferenceSession;
  charAt: (index: number) => string | null;
}

interface LineRecognition {
  text: string;
  confidence: number;
  chars?: OcrChar[];
}

interface AutoRecognition {
  lines: RecognizedLine[];
  modelId: string;
  autoSelection: {
    method: "script-classifier" | "default";
    decisive: boolean;
    scriptDetection?: ScriptPrediction;
  };
}

const LOG_PREFIX = "[PP-OCR]";

const RECOGNIZER_WARM_UP_WIDTHS = [48, 128];

/** How far a region is enlarged before detection. In a small speech bubble,
 * the detector merges lines whose gap is only a few pixels wide. */
const REGION_ENLARGEMENT = 2;

export class PaddleEngine {
  private constructor(
    private readonly detector: Manifest["detector"],
    private readonly detSession: ort.InferenceSession,
    private readonly primaryModelId: string,
    private readonly modelOptions: Map<string, WorkerModelConfig>,
    private readonly recognizers: Map<string, Promise<LoadedRecognizer>>,
    private readonly scriptClassifier: Promise<ScriptClassifier | undefined>,
    private readonly regionGrouper: RegionGrouper,
    private readonly backend: OrtBackend,
    private readonly debug: boolean,
    private readonly detectsScripts: boolean,
  ) {}

  static async create(options: EngineOptions): Promise<PaddleEngine> {
    const debug = options.debug ?? false;
    const startedAt = now();
    configureOrt(options.wasmBaseUrl);

    // Probe WebGPU while the manifest and dict load; only the sessions need it.
    const backendPromise = resolveBackend(options.backend);

    const manifest = await fetchJson<Manifest>(
      options.model.modelBaseUrl + "model-manifest.json",
    );
    const dictText = await fetchText(
      options.model.modelBaseUrl + manifest.recognizer.dictPath,
    );
    const dict = parseDict(dictText);

    const backend = await backendPromise;
    if (debug && backend !== options.backend) {
      console.log(
        `${LOG_PREFIX} WebGPU is not available in this context; using wasm`,
      );
    }

    // ORT's WebGPU and WASM providers share one runtime but initialize under
    // separate backend names. Finish one cold-start before mixing providers.
    const detSession = await createSession(
      options.model.modelBaseUrl + manifest.detector.modelPath,
      backend,
    );
    const [recSession, regionGrouper] = await Promise.all([
      createSession(
        options.model.modelBaseUrl + manifest.recognizer.modelPath,
        backend,
      ),
      RegionGrouper.create(options.layoutModelBaseUrl),
    ]);
    if (backend === "webgpu") {
      await warmUpWebGpu(detSession, recSession, manifest, debug);
    }
    const primaryRecognizer: LoadedRecognizer = {
      candidate: options.model,
      config: manifest.recognizer,
      session: recSession,
      charAt: makeCharAt(dict),
    };
    const modelOptions = new Map<string, WorkerModelConfig>();
    for (const model of [options.model, ...(options.additionalModels ?? [])]) {
      if (!modelOptions.has(model.id)) {
        modelOptions.set(model.id, model);
      }
    }
    const recognizers = new Map<string, Promise<LoadedRecognizer>>([
      [options.model.id, Promise.resolve(primaryRecognizer)],
    ]);
    const scriptClassifier = options.scriptModelBaseUrl
      ? ScriptClassifier.create(options.scriptModelBaseUrl).catch((error) => {
          if (debug) {
            console.warn(`${LOG_PREFIX} script classifier unavailable`, error);
          }
          return undefined;
        })
      : Promise.resolve(undefined);

    if (debug) {
      console.log(
          `${LOG_PREFIX} engine ready in ${elapsed(startedAt)} (backend=${backend}, model=${options.model.id}, grouping=${regionGrouper.metadata.id}/${regionGrouper.metadata.backend}, dict=${dict.length} chars, recMaxWidth=${manifest.recognizer.maxImageWidth})`,
      );
    }

    return new PaddleEngine(
      manifest.detector,
      detSession,
      options.model.id,
      modelOptions,
      recognizers,
      scriptClassifier,
      regionGrouper,
      backend,
      debug,
      Boolean(options.scriptModelBaseUrl),
    );
  }

  async recognize(
    blob: Blob,
    sourceLang: string | undefined,
    isCancelled: () => boolean,
    onProgress?: (line: number, lineCount: number) => void,
    options: RecognizeOptions = {},
  ): Promise<PipelineOcrResult> {
    const startedAt = now();
    const bitmap = await createImageBitmap(blob);
    try {
      if (this.debug) {
        console.log(
          `${LOG_PREFIX} recognize start: image ${bitmap.width}x${bitmap.height}, ${blob.size} bytes`,
        );
      }

      const detected = await this.detect(bitmap);
      // Dropped before recognition: it saves reading them, and keeps text that
      // does not matter from steering the script detection.
      const boxes = this.dropThinBoxes(detected, options.minLineThickness);
      throwIfCancelled(isCancelled);

      if (this.debug) {
        console.log(
          `${LOG_PREFIX} detector found ${detected.length} box(es)` +
            (boxes.length < detected.length
              ? `, ${detected.length - boxes.length} dropped as too small`
              : ""),
        );
      }

      const single = options.grouping === "single";
      // Live captures read a strip of subtitles, not comic text regions.
      const readsRegions =
        Boolean(this.detector.rotatedRegions) &&
        !single &&
        options.minLineThickness === undefined;
      const sourceImageData =
        boxes.length > 0 || readsRegions ? bitmapToImageData(bitmap) : null;
      // Found before recognition, so that progress can count the regions too.
      const regions =
        readsRegions && sourceImageData
          ? await this.regionGrouper.detectRegions(sourceImageData)
          : undefined;
      // A region around several others would read their text a second time.
      const enclosing = regions ? findEnclosingRegions(regions) : undefined;
      const readable = regions?.filter((_, index) => !enclosing?.has(index));
      // One bar for both passes: the page's lines, then the regions.
      const steps = boxes.length + (readable?.length ?? 0);
      const pageProgress =
        onProgress && readable
          ? (line: number) => onProgress(line, steps)
          : onProgress;
      const modelId = options.modelId ?? this.primaryModelId;
      const auto =
        sourceLang === "auto" && !options.modelId && this.detectsScripts;
      const autoRecognition = auto
        ? await this.recognizeAuto(
            sourceImageData,
            boxes,
            isCancelled,
            pageProgress,
          )
        : undefined;
      const recognized =
        autoRecognition ??
        {
          lines: await this.recognizeAllLines(
            sourceImageData,
            boxes,
            await this.getRecognizer(modelId),
            isCancelled,
            pageProgress,
          ),
          modelId,
      };

      const script = this.modelOptions.get(recognized.modelId)?.script;
      throwIfCancelled(isCancelled);
      const lines =
        readable && sourceImageData
          ? await this.readRotatedRegions(
              sourceImageData,
              readable,
              recognized.lines,
              await this.getRecognizer(recognized.modelId),
              isCancelled,
              (done) => onProgress?.(boxes.length + done, steps),
            )
          : recognized.lines;
      throwIfCancelled(isCancelled);
      const groupingStartedAt = now();
      const grouping = single
        ? groupAsSingleRegion(lines)
        : await this.regionGrouper.group(sourceImageData, lines, regions);
      throwIfCancelled(isCancelled);
      if (this.debug) {
        console.log(
          `${LOG_PREFIX} region grouping produced ${grouping.groups.length} group(s) from ${grouping.regionCount} region(s) in ${elapsed(groupingStartedAt)} (${single ? "single region" : `model=${this.regionGrouper.metadata.id}, threshold=${this.regionGrouper.metadata.confidenceThreshold}`}, matched=${grouping.matchedLineCount}/${lines.length})`,
        );
      }
      const result = assembleGroupedResult(grouping.groups, {
        backend: this.backend,
        direction: script === "arabic" ? "rtl" : "ltr",
      });
      result.providerMeta = {
        ...(result.providerMeta as Record<string, unknown>),
        modelId: recognized.modelId,
        grouping: {
          modelId: this.regionGrouper.metadata.id,
          backend: this.regionGrouper.metadata.backend,
          confidenceThreshold:
            this.regionGrouper.metadata.confidenceThreshold,
          nmsIouThreshold: this.regionGrouper.metadata.nmsIouThreshold,
          regionCount: grouping.regionCount,
          matchedLineCount: grouping.matchedLineCount,
          groupCount: grouping.groups.length,
        },
        ...(autoRecognition
          ? {
              autoSelection: autoRecognition.autoSelection,
            }
          : {}),
      };
      // Block bboxes are in this bitmap's pixel space; the overlay needs the
      // image size to map them onto the on-screen selection rect.
      result.imageWidth = bitmap.width;
      result.imageHeight = bitmap.height;
      if (this.debug) {
        const keptLineCount = result.blocks?.length ?? 0;
        const filteredLineCount = lines.length - keptLineCount;
        if (filteredLineCount > 0) {
          console.log(
            `${LOG_PREFIX} filtered ${filteredLineCount} low-confidence line(s)`,
          );
        }
        console.log(
          `${LOG_PREFIX} recognize done in ${elapsed(startedAt)}: ${keptLineCount} line(s), overall conf ${(result.confidence ?? 0).toFixed(3)}`,
        );
      }
      return result;
    } finally {
      bitmap.close();
    }
  }

  dispose(): void {
    void this.detSession.release();
    this.regionGrouper.dispose();
    for (const recognizer of this.recognizers.values()) {
      void recognizer
        .then(({ session }) => session.release())
        .catch(() => {});
    }
    void this.scriptClassifier
      .then((classifier) => classifier?.dispose())
      .catch(() => {});
  }

  /** Detector boxes in the bitmap's coordinates. With `enlargeUpTo`, the
   * bitmap is enlarged by up to that factor, within maxSideLength, and padded
   * rather than stretched to the detector's multiple of 32: on a small crop,
   * squeezing by a few pixels merges neighbouring lines. */
  private async detect(bitmap: ImageBitmap, enlargeUpTo?: number) {
    const det = this.detector;
    let width: number;
    let height: number;
    let inputW: number;
    let inputH: number;
    if (enlargeUpTo === undefined) {
      const { targetW, targetH } = computeDetSize(
        bitmap.width,
        bitmap.height,
        det.maxSideLength,
      );
      width = inputW = targetW;
      height = inputH = targetH;
    } else {
      const scale = Math.min(
        enlargeUpTo,
        det.maxSideLength / Math.max(bitmap.width, bitmap.height),
      );
      width = Math.max(1, Math.round(bitmap.width * scale));
      height = Math.max(1, Math.round(bitmap.height * scale));
      inputW = Math.ceil(width / 32) * 32;
      inputH = Math.ceil(height / 32) * 32;
    }

    const imageData = resizeToImageData(bitmap, width, height, inputW, inputH);
    const tensor = new ort.Tensor(
      "float32",
      imageDataToNchw(imageData.data, inputW, inputH, det.mean, det.std),
      [1, 3, inputH, inputW],
    );

    const output = await runSingleInput(this.detSession, tensor);
    const probMap = output.data as Float32Array;
    const mapH = output.dims[2];
    const mapW = output.dims[3];

    const cfg: DbConfig = {
      threshold: det.threshold,
      boxThreshold: det.boxThreshold,
      unclipRatio: det.unclipRatio,
      minBoxSize: det.minBoxSize,
      padding: det.padding,
      splitThreshold: det.splitThreshold,
    };
    // Map back to the original bitmap via the actual map size (robust to
    // rounding). Padding only extends the map past the bitmap.
    return extractBoxes(
      probMap,
      mapW,
      mapH,
      cfg,
      bitmap.width / (enlargeUpTo === undefined ? mapW : width),
      bitmap.height / (enlargeUpTo === undefined ? mapH : height),
      bitmap.width,
      bitmap.height,
    );
  }

  private async recognizeAuto(
    source: RgbaImage | null,
    boxes: DetectedBox[],
    isCancelled: () => boolean,
    onProgress?: (line: number, lineCount: number) => void,
  ): Promise<AutoRecognition> {
    if (boxes.length === 0) {
      return {
        lines: [],
        modelId: this.primaryModelId,
        autoSelection: { method: "default", decisive: false },
      };
    }

    const primaryRecognizer = await this.getRecognizer(this.primaryModelId);
    throwIfCancelled(isCancelled);

    const scriptDetection = await this.detectScript(
      source,
      boxes,
      primaryRecognizer.config.maxImageWidth,
      isCancelled,
    );
    const model = scriptDetection?.script
      ? [...this.modelOptions.values()].find(
          ({ script }) => script === scriptDetection.script,
        )
      : undefined;
    const modelId = model?.id ?? this.primaryModelId;
    // A recognizer without a dictionary for the script would only produce
    // look-alike characters.
    if (
      !model &&
      scriptDetection?.script &&
      hasMajorityScript(scriptDetection)
    ) {
      const error = new Error(scriptDetection.script);
      error.name = UNSUPPORTED_SCRIPT_ERROR;
      throw error;
    }

    if (this.debug) {
      if (model && scriptDetection) {
        console.log(
          `${LOG_PREFIX} script classifier selected ${modelId} from ${scriptDetection.probeCount} line(s)${scriptDetection.decisive ? "" : " (low confidence)"}`,
          scriptDetection,
        );
      } else {
        console.log(
          `${LOG_PREFIX} script classifier found no supported script; using ${this.primaryModelId}`,
          scriptDetection,
        );
      }
    }

    const recognizer =
      modelId === this.primaryModelId
        ? primaryRecognizer
        : await this.getRecognizer(modelId);
    throwIfCancelled(isCancelled);
    const lines = await this.recognizeAllLines(
      source,
      boxes,
      recognizer,
      isCancelled,
      onProgress,
    );

    return {
      lines,
      modelId,
      autoSelection: {
        method: model ? "script-classifier" : "default",
        decisive: scriptDetection?.decisive ?? false,
        ...(scriptDetection ? { scriptDetection } : {}),
      },
    };
  }

  private async detectScript(
    source: RgbaImage | null,
    boxes: DetectedBox[],
    maxImageWidth: number,
    isCancelled: () => boolean,
  ): Promise<ScriptPrediction | undefined> {
    if (!source) {
      return undefined;
    }
    const classifier = await this.scriptClassifier;
    if (!classifier) {
      return undefined;
    }

    try {
      return await classifier.detect(
        source,
        boxes,
        maxImageWidth,
        isCancelled,
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      if (this.debug) {
        console.warn(`${LOG_PREFIX} script classification failed`, error);
      }
      return undefined;
    }
  }

  /** Boxes whose short side, once padded like the line's own box, is at least
   * `minThickness`. That side is the text's height, whichever way it reads. */
  private dropThinBoxes(
    boxes: DetectedBox[],
    minThickness: number | undefined,
  ): DetectedBox[] {
    if (!minThickness) {
      return boxes;
    }
    return boxes.filter(
      (box) => this.lineFrame(box).oriented.rect.height >= minThickness,
    );
  }

  private async recognizeAllLines(
    source: RgbaImage | null,
    boxes: DetectedBox[],
    recognizer: LoadedRecognizer,
    isCancelled: () => boolean,
    onProgress?: (line: number, lineCount: number) => void,
  ): Promise<RecognizedLine[]> {
    const lines: RecognizedLine[] = [];
    for (const [index, box] of boxes.entries()) {
      throwIfCancelled(isCancelled);
      onProgress?.(index + 1, boxes.length);
      const recognized = await this.recognizeLine(source, box, recognizer);
      if (this.debug) {
        const { x, y, width, height } = box.bbox;
        console.log(
          `${LOG_PREFIX} box #${index} ${width}x${height} @(${x},${y}) (det score ${box.score.toFixed(2)}) -> ${JSON.stringify(recognized.text)} (rec conf ${recognized.confidence.toFixed(3)}, model=${recognizer.candidate.id})`,
        );
      }
      if (recognized.text.length > 0) {
        lines.push({
          bbox: box.bbox,
          // Padded like the bbox, so an upright line's box matches it. Unlike
          // the bbox it is not clamped to the image, so an edge line runs wider.
          oriented: this.lineFrame(box).oriented,
          text: recognized.text,
          confidence: recognized.confidence,
          ...(recognized.chars ? { chars: recognized.chars } : {}),
        });
      }
    }
    return lines;
  }

  /** The frame this line's boxes are squared to, and whether the recognizer had
   * to turn the crop upright to read it. Derived from the detector's quad alone,
   * so the line's own box and its characters' cannot disagree. */
  private lineFrame(box: DetectedBox): {
    oriented: OrientedRect;
    readsDown: boolean;
  } {
    const padded = padQuad(box.quad, this.detector.padding);
    const readsDown = box.readsDown ?? isRotatedForRecognition(padded);
    return { oriented: orientedRectOfQuad(padded, readsDown), readsDown };
  }

  /** Read each text region again, turned a quarter turn counter-clockwise so
   * its columns become rows. On a whole page, the detector often reads
   * closely set columns across, row by row; turned, it finds the columns. A
   * region keeps whichever reading has more confident text, so a horizontal
   * line stays as the page read it. Lines outside the regions are kept.
   * `onProgress` gets the number of regions read so far, with fractions for
   * the lines of the region being read. */
  private async readRotatedRegions(
    source: RgbaImage,
    readable: TextRegion[],
    pageLines: RecognizedLine[],
    recognizer: LoadedRecognizer,
    isCancelled: () => boolean,
    onProgress?: (regions: number) => void,
  ): Promise<RecognizedLine[]> {
    const regionOfLine = pageLines.map((line) => regionOf(line.bbox, readable));
    const lines = pageLines.filter((_, index) => regionOfLine[index] === -1);
    for (const [index, region] of readable.entries()) {
      throwIfCancelled(isCancelled);
      const page = pageLines.filter((_, line) => regionOfLine[line] === index);
      // The crop's margin can take in a neighbouring region, and regions can
      // overlap. A line belongs to the region its page reading would.
      const boxes = (await this.detectRotated(source, region.bbox)).filter(
        (box) => regionOf(box.bbox, readable) === index,
      );
      const rotated = await this.recognizeAllLines(
        source,
        boxes,
        recognizer,
        isCancelled,
        (line, lineCount) => onProgress?.(index + line / (lineCount + 1)),
      );
      const keepsRotated = readingScore(rotated) > readingScore(page);
      if (this.debug) {
        console.log(
          `${LOG_PREFIX} region #${index} kept the ${keepsRotated ? "rotated" : "page"} reading: ${JSON.stringify((keepsRotated ? rotated : page).map((line) => line.text))}`,
        );
      }
      lines.push(...(keepsRotated ? rotated : page));
      onProgress?.(index + 1);
    }
    return lines;
  }

  /** Detector boxes for one region read turned counter-clockwise, mapped back
   * onto the page. */
  private async detectRotated(
    source: RgbaImage,
    region: Rect,
  ): Promise<DetectedBox[]> {
    const crop = regionCrop(region, source);
    const turned = rotate90CounterClockwise(cropRect(source, crop));
    const bitmap = await createImageBitmap(
      new ImageData(
        turned.data as Uint8ClampedArray<ArrayBuffer>,
        turned.width,
        turned.height,
      ),
    );
    try {
      return (await this.detect(bitmap, REGION_ENLARGEMENT)).map((box) =>
        toPageBox(box, crop),
      );
    } finally {
      bitmap.close();
    }
  }

  private async getRecognizer(modelId: string): Promise<LoadedRecognizer> {
    const loaded = this.recognizers.get(modelId);
    if (loaded) {
      return loaded;
    }
    const model = this.modelOptions.get(modelId);
    if (!model) {
      throw new Error(`Unknown PP-OCR recognizer model: ${modelId}`);
    }

    const loading = loadRecognizer(model, this.backend);
    this.recognizers.set(modelId, loading);
    void loading.catch(() => {
      if (this.recognizers.get(modelId) === loading) {
        this.recognizers.delete(modelId);
      }
    });
    return loading;
  }

  private async recognizeLine(
    source: RgbaImage | null,
    box: DetectedBox,
    recognizer: LoadedRecognizer,
  ): Promise<LineRecognition> {
    if (!source) {
      throw new Error("PP-OCRv6 source image is not available.");
    }

    const rec = recognizer.config;
    const imageData = cropQuadToImageData(
      source,
      box.quad,
      rec.imageHeight,
      rec.minImageWidth,
      rec.maxImageWidth,
      this.detector.padding,
      box.readsDown,
    );
    if (this.debug && imageData.width >= rec.maxImageWidth) {
      console.warn(
        `${LOG_PREFIX} rec input hit maxImageWidth (${rec.maxImageWidth}px); a wide line may be horizontally squished`,
      );
    }
    const tensor = new ort.Tensor(
      "float32",
      imageDataToNchw(
        imageData.data,
        imageData.width,
        imageData.height,
        rec.mean,
        rec.std,
      ),
      [1, 3, imageData.height, imageData.width],
    );

    const output = await runSingleInput(recognizer.session, tensor);
    const timeSteps = output.dims[1];
    const numClasses = output.dims[2];
    // PP-OCRv6 rec exports with a final softmax -> output is already probabilities.
    const decoded = ctcGreedyDecode(
      output.data as Float32Array,
      timeSteps,
      numClasses,
      recognizer.charAt,
      true,
    );
    // Arabic is re-ordered after decoding, so the timesteps no longer line up
    // with the text; that script goes without character boxes.
    if (recognizer.candidate.script === "arabic") {
      return {
        text: reverseArabicCtcText(decoded.text),
        confidence: decoded.confidence,
      };
    }

    // Ordered but unpadded: character boxes hug the detected text, while the
    // frame and the rotation test follow the padded crop the recognizer saw.
    const quad = padQuad(box.quad, 0);
    const frame = this.lineFrame(box);
    return {
      text: decoded.text,
      confidence: decoded.confidence,
      chars: charBoxes({
        chars: decoded.chars,
        timeSteps,
        quad,
        padding: this.detector.padding,
        angle: frame.oriented.angle,
      }),
    };
  }
}

async function loadRecognizer(
  model: WorkerModelConfig,
  backend: OrtBackend,
): Promise<LoadedRecognizer> {
  const manifest = await fetchJson<Manifest>(
    model.modelBaseUrl + "model-manifest.json",
  );
  const [dictText, session] = await Promise.all([
    fetchText(model.modelBaseUrl + manifest.recognizer.dictPath),
    createSession(model.modelBaseUrl + manifest.recognizer.modelPath, backend),
  ]);
  return {
    candidate: model,
    config: manifest.recognizer,
    session,
    charAt: makeCharAt(parseDict(dictText)),
  };
}

/** Compile the WebGPU shaders on tiny inputs, while the engine initializes
 * (often during the user's selection) instead of on the first image. Shaders
 * compile slowly on some platforms: up to 15 s for both models on Firefox for
 * Windows. The detector's shaders do not depend on the input size, so one
 * small run covers it. The recognizer compiles a few more on its second width,
 * so it gets two. */
async function warmUpWebGpu(
  detSession: ort.InferenceSession,
  recSession: ort.InferenceSession,
  manifest: Manifest,
  debug: boolean,
): Promise<void> {
  const startedAt = now();
  const height = manifest.recognizer.imageHeight;
  await warmUpSession(detSession, [1, 3, 32, 32]);
  for (const width of RECOGNIZER_WARM_UP_WIDTHS) {
    await warmUpSession(recSession, [1, 3, height, width]);
  }
  if (debug) {
    console.log(`${LOG_PREFIX} WebGPU warm-up took ${elapsed(startedAt)}`);
  }
}

function throwIfCancelled(isCancelled: () => boolean): void {
  if (isCancelled()) {
    throw new DOMException("Aborted", "AbortError");
  }
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function elapsed(startedAt: number): string {
  return `${Math.round(now() - startedAt)}ms`;
}
