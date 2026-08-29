// PP-OCRv6 inference engine. Runs detector -> crop -> recognizer and assembles
// the result. Lives in the worker; uses ORT, OffscreenCanvas, and createImageBitmap.

import { assembleGroupedResult, type RecognizedLine } from "./assemble";
import { charBoxes } from "./char-boxes";
import {
  bitmapToImageData,
  cropQuadToImageData,
  isRotatedForRecognition,
  padQuad,
  resizeToImageData,
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
  type OrtBackend,
} from "./ort-env";
import { computeDetSize, imageDataToNchw, type Rgb } from "./preprocess";
import type { RecognizerScript } from "./protocol";
import { RegionGrouper } from "./region-grouper";
import {
  chooseScript,
  MAX_SCRIPT_PROBE_LINES,
  rankRepresentativeBoxes,
  SCRIPT_INPUT_HEIGHT,
  ScriptClassifier,
  type ScriptPrediction,
} from "./script-classifier";
import type {
  OcrChar,
  OrientedRect,
  PipelineOcrResult,
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

export interface EngineOptions {
  model: EngineModelOptions;
  additionalModels?: EngineModelOptions[];
  scriptModelBaseUrl?: string;
  layoutModelBaseUrl: string;
  wasmBaseUrl: string;
  backend: OrtBackend;
  debug?: boolean;
}

export interface EngineModelOptions {
  id: string;
  script: RecognizerScript;
  modelBaseUrl: string;
}

interface LoadedRecognizer {
  candidate: EngineModelOptions;
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
  method: "script-classifier" | "default";
  scriptDetection?: ScriptPrediction & { probeCount: number };
}

const LOG_PREFIX = "[PP-OCR]";

export class PaddleEngine {
  private constructor(
    private readonly detector: Manifest["detector"],
    private readonly detSession: ort.InferenceSession,
    private readonly primaryModelId: string,
    private readonly modelOptions: Map<string, EngineModelOptions>,
    private readonly recognizers: Map<string, Promise<LoadedRecognizer>>,
    private readonly scriptClassifier: Promise<ScriptClassifier | undefined>,
    private readonly regionGrouper: RegionGrouper,
    private readonly backend: OrtBackend,
    private readonly debug: boolean,
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
    const primaryRecognizer: LoadedRecognizer = {
      candidate: options.model,
      config: manifest.recognizer,
      session: recSession,
      charAt: makeCharAt(dict),
    };
    const modelOptions = new Map<string, EngineModelOptions>();
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
    );
  }

  async recognize(
    blob: Blob,
    sourceLang: string | undefined,
    isCancelled: () => boolean,
    onProgress?: (line: number, lineCount: number) => void,
  ): Promise<PipelineOcrResult> {
    const startedAt = now();
    const bitmap = await createImageBitmap(blob);
    try {
      if (this.debug) {
        console.log(
          `${LOG_PREFIX} recognize start: image ${bitmap.width}x${bitmap.height}, ${blob.size} bytes`,
        );
      }

      const boxes = await this.detect(bitmap);
      throwIfCancelled(isCancelled);

      if (this.debug) {
        console.log(`${LOG_PREFIX} detector found ${boxes.length} box(es)`);
      }

      const sourceImageData = boxes.length > 0 ? bitmapToImageData(bitmap) : null;
      const auto = sourceLang === "auto" && this.modelOptions.size > 1;
      const autoRecognition = auto
        ? await this.recognizeAuto(
            sourceImageData,
            boxes,
            bitmap.width,
            bitmap.height,
            isCancelled,
            onProgress,
          )
        : undefined;
      const recognized =
        autoRecognition ??
        {
          lines: await this.recognizeAllLines(
            sourceImageData,
            boxes,
            await this.getRecognizer(this.primaryModelId),
            isCancelled,
            onProgress,
          ),
          modelId: this.primaryModelId,
      };

      const script = this.modelOptions.get(recognized.modelId)?.script;
      throwIfCancelled(isCancelled);
      const groupingStartedAt = now();
      const grouping = await this.regionGrouper.group(
        sourceImageData,
        recognized.lines,
      );
      throwIfCancelled(isCancelled);
      if (this.debug) {
        console.log(
          `${LOG_PREFIX} region grouping produced ${grouping.groups.length} group(s) from ${grouping.regionCount} region(s) in ${elapsed(groupingStartedAt)} (model=${this.regionGrouper.metadata.id}, threshold=${this.regionGrouper.metadata.confidenceThreshold}, matched=${grouping.matchedLineCount}/${recognized.lines.length})`,
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
              autoSelection: {
                method: autoRecognition.method,
                decisive:
                  autoRecognition.scriptDetection?.decisive ?? false,
                ...(autoRecognition.scriptDetection
                  ? { scriptDetection: autoRecognition.scriptDetection }
                  : {}),
              },
            }
          : {}),
      };
      // Block bboxes are in this bitmap's pixel space; the overlay needs the
      // image size to map them onto the on-screen selection rect.
      result.imageWidth = bitmap.width;
      result.imageHeight = bitmap.height;
      if (this.debug) {
        const keptLineCount = result.blocks?.length ?? 0;
        const filteredLineCount = recognized.lines.length - keptLineCount;
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

  private async detect(bitmap: ImageBitmap) {
    const det = this.detector;
    const { targetW, targetH } = computeDetSize(
      bitmap.width,
      bitmap.height,
      det.maxSideLength,
    );

    const imageData = resizeToImageData(bitmap, targetW, targetH);
    const tensor = new ort.Tensor(
      "float32",
      imageDataToNchw(imageData.data, targetW, targetH, det.mean, det.std),
      [1, 3, targetH, targetW],
    );

    const output = await this.run(this.detSession, tensor);
    const probMap = output.data as Float32Array;
    const mapH = output.dims[2];
    const mapW = output.dims[3];

    const cfg: DbConfig = {
      threshold: det.threshold,
      boxThreshold: det.boxThreshold,
      unclipRatio: det.unclipRatio,
      minBoxSize: det.minBoxSize,
      padding: det.padding,
    };
    // Map back to the original bitmap via the actual map size (robust to rounding).
    return extractBoxes(
      probMap,
      mapW,
      mapH,
      cfg,
      bitmap.width / mapW,
      bitmap.height / mapH,
      bitmap.width,
      bitmap.height,
    );
  }

  private async recognizeAuto(
    source: RgbaImage | null,
    boxes: DetectedBox[],
    imageWidth: number,
    imageHeight: number,
    isCancelled: () => boolean,
    onProgress?: (line: number, lineCount: number) => void,
  ): Promise<AutoRecognition> {
    if (boxes.length === 0) {
      return {
        lines: [],
        modelId: this.primaryModelId,
        method: "default",
      };
    }

    const primaryRecognizer = await this.getRecognizer(this.primaryModelId);
    throwIfCancelled(isCancelled);

    const rankedBoxes = rankRepresentativeBoxes(
      boxes,
      imageWidth,
      imageHeight,
      MAX_SCRIPT_PROBE_LINES,
    );
    const scriptDetection = await this.detectScript(
      source,
      boxes,
      rankedBoxes,
      primaryRecognizer.config.maxImageWidth,
      isCancelled,
    );
    const model = scriptDetection?.script
      ? [...this.modelOptions.values()].find(
          ({ script }) => script === scriptDetection.script,
        )
      : undefined;
    const modelId = model?.id ?? this.primaryModelId;

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
      method: model ? "script-classifier" : "default",
      ...(scriptDetection ? { scriptDetection } : {}),
    };
  }

  private async detectScript(
    source: RgbaImage | null,
    boxes: DetectedBox[],
    rankedBoxes: number[],
    maxImageWidth: number,
    isCancelled: () => boolean,
  ): Promise<(ScriptPrediction & { probeCount: number }) | undefined> {
    if (!source) {
      return undefined;
    }
    const classifier = await this.scriptClassifier;
    if (!classifier) {
      return undefined;
    }

    try {
      const evidence = [];
      const boxIndices = rankedBoxes.slice(0, MAX_SCRIPT_PROBE_LINES);
      for (const boxIndex of boxIndices) {
        throwIfCancelled(isCancelled);
        const crop = cropQuadToImageData(
          source,
          boxes[boxIndex].quad,
          SCRIPT_INPUT_HEIGHT,
          3,
          maxImageWidth,
        );
        evidence.push(await classifier.classify(crop));
      }
      return { ...chooseScript(evidence), probeCount: evidence.length };
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
    const readsDown = isRotatedForRecognition(padded);
    return { oriented: orientedRectOfQuad(padded, readsDown), readsDown };
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

    const output = await this.run(recognizer.session, tensor);
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

  private async run(
    session: ort.InferenceSession,
    tensor: ort.Tensor,
  ): Promise<ort.Tensor> {
    const feeds = { [session.inputNames[0]]: tensor };
    const results = await session.run(feeds);
    return results[session.outputNames[0]];
  }
}

async function loadRecognizer(
  model: EngineModelOptions,
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

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  return response.text();
}
