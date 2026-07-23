// PP-OCRv6 inference engine. Runs detector -> crop -> recognizer and assembles
// the result. Lives in the worker; uses ORT, OffscreenCanvas, and createImageBitmap.

import { assembleResult, type RecognizedLine } from "./assemble";
import {
  chooseAutoRecognizer,
  initialAutoProbeCount,
  rankRepresentativeBoxes,
  tryChooseGeneralRecognizer,
  type AutoRecognizerCandidate,
  type ProbeRecognition,
  type RecognizerProbeResult,
  type RecognizerScore,
} from "./auto-select";
import {
  bitmapToImageData,
  cropQuadToImageData,
  detectBackgroundTone,
  resizeToImageData,
  type RgbaImage,
} from "./crop";
import { ctcGreedyDecode, reverseArabicCtcText } from "./ctc";
import { extractBoxes, type DbConfig, type DetectedBox } from "./db-postprocess";
import { makeCharAt, parseDict } from "./dict";
import {
  createSession,
  configureOrt,
  ort,
  resolveBackend,
  type OrtBackend,
} from "./ort-env";
import { computeDetSize, imageDataToNchw, type Rgb } from "./preprocess";
import type { PipelineOcrResult } from "../../../shared/types";

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
  autoModels?: EngineModelOptions[];
  wasmBaseUrl: string;
  backend: OrtBackend;
  debug?: boolean;
}

export interface EngineModelOptions extends AutoRecognizerCandidate {
  modelBaseUrl: string;
}

interface LoadedRecognizer {
  candidate: AutoRecognizerCandidate;
  config: Manifest["recognizer"];
  session: ort.InferenceSession;
  charAt: (index: number) => string | null;
}

interface AutoRecognition {
  lines: RecognizedLine[];
  modelId: string;
  probeCount: number;
  decisive: boolean;
  scores: RecognizerScore[];
}

const LOG_PREFIX = "[PP-OCR]";

export class PaddleEngine {
  private constructor(
    private readonly detector: Manifest["detector"],
    private readonly detSession: ort.InferenceSession,
    private readonly primaryModelId: string,
    private readonly modelOptions: Map<string, EngineModelOptions>,
    private readonly recognizers: Map<string, Promise<LoadedRecognizer>>,
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
      options.model.modelBaseUrl + "manifest.json",
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

    const [detSession, recSession] = await Promise.all([
      createSession(
        options.model.modelBaseUrl + manifest.detector.modelPath,
        backend,
      ),
      createSession(
        options.model.modelBaseUrl + manifest.recognizer.modelPath,
        backend,
      ),
    ]);
    const primaryRecognizer: LoadedRecognizer = {
      candidate: options.model,
      config: manifest.recognizer,
      session: recSession,
      charAt: makeCharAt(dict),
    };
    const modelOptions = new Map<string, EngineModelOptions>();
    for (const model of [options.model, ...(options.autoModels ?? [])]) {
      if (!modelOptions.has(model.id)) {
        modelOptions.set(model.id, model);
      }
    }
    const recognizers = new Map<string, Promise<LoadedRecognizer>>([
      [options.model.id, Promise.resolve(primaryRecognizer)],
    ]);

    if (debug) {
      console.log(
        `${LOG_PREFIX} engine ready in ${elapsed(startedAt)} (backend=${backend}, model=${options.model.id}, dict=${dict.length} chars, recMaxWidth=${manifest.recognizer.maxImageWidth})`,
      );
    }

    return new PaddleEngine(
      manifest.detector,
      detSession,
      options.model.id,
      modelOptions,
      recognizers,
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
      const result = assembleResult(recognized.lines, {
        backend: this.backend,
        direction: script === "arabic" ? "rtl" : "ltr",
      });
      for (const block of result.blocks ?? []) {
        if (sourceImageData) {
          block.backgroundTone = detectBackgroundTone(sourceImageData, block.bbox);
        }
      }
      result.providerMeta = {
        ...(result.providerMeta as Record<string, unknown>),
        modelId: recognized.modelId,
        ...(autoRecognition
          ? {
              autoSelection: {
                probeCount: autoRecognition.probeCount,
                decisive: autoRecognition.decisive,
                scores: autoRecognition.scores,
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
    for (const recognizer of this.recognizers.values()) {
      void recognizer
        .then(({ session }) => session.release())
        .catch(() => {});
    }
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
        probeCount: 0,
        decisive: false,
        scores: [],
      };
    }

    const primaryRecognizer = await this.getRecognizer(this.primaryModelId);
    let recognizers = [primaryRecognizer];
    throwIfCancelled(isCancelled);

    const rankedBoxes = rankRepresentativeBoxes(
      boxes,
      imageWidth,
      imageHeight,
    );
    const probeResults = new Map<string, Map<number, ProbeRecognition>>();
    for (const modelId of this.modelOptions.keys()) {
      probeResults.set(modelId, new Map());
    }
    const recognizeProbe = async (
      recognizer: LoadedRecognizer,
      boxIndex: number,
    ) => {
      throwIfCancelled(isCancelled);
      probeResults.get(recognizer.candidate.id)!.set(
        boxIndex,
        await this.recognizeLine(source, boxes[boxIndex], recognizer),
      );
    };

    let probeCount = initialAutoProbeCount(boxes.length);
    const firstBoxIndex = rankedBoxes[0];
    await recognizeProbe(primaryRecognizer, firstBoxIndex);
    let choice = tryChooseGeneralRecognizer(
      this.buildProbeResults(
        [primaryRecognizer],
        rankedBoxes,
        probeCount,
        probeResults,
      )[0],
      this.primaryModelId,
    );

    if (!choice.decisive) {
      const specialists = await Promise.all(
        [...this.modelOptions.keys()]
          .filter((modelId) => modelId !== this.primaryModelId)
          .map((modelId) => this.getRecognizer(modelId)),
      );
      recognizers = [primaryRecognizer, ...specialists];
      throwIfCancelled(isCancelled);

      for (const recognizer of specialists) {
        await recognizeProbe(recognizer, firstBoxIndex);
      }
      choice = chooseAutoRecognizer(
        this.buildProbeResults(
          recognizers,
          rankedBoxes,
          probeCount,
          probeResults,
        ),
        this.primaryModelId,
      );

      while (!choice.decisive && probeCount < rankedBoxes.length) {
        const boxIndex = rankedBoxes[probeCount];
        probeCount++;
        for (const recognizer of recognizers) {
          await recognizeProbe(recognizer, boxIndex);
        }
        choice = chooseAutoRecognizer(
          this.buildProbeResults(
            recognizers,
            rankedBoxes,
            probeCount,
            probeResults,
          ),
          this.primaryModelId,
        );
      }
    }

    const modelId = choice.modelId;
    const recognizer = recognizers.find(
      ({ candidate }) => candidate.id === modelId,
    )!;
    const lines = await this.recognizeAllLines(
      source,
      boxes,
      recognizer,
      isCancelled,
      onProgress,
      probeResults.get(modelId),
    );

    if (this.debug) {
      console.log(
        `${LOG_PREFIX} auto selected ${modelId} from ${probeCount} probe(s)${choice.decisive ? "" : " (default fallback)"}`,
        choice.scores,
      );
    }

    return {
      lines,
      modelId,
      probeCount,
      decisive: choice.decisive,
      scores: choice.scores,
    };
  }

  private buildProbeResults(
    recognizers: LoadedRecognizer[],
    rankedBoxes: number[],
    probeCount: number,
    results: Map<string, Map<number, ProbeRecognition>>,
  ): RecognizerProbeResult[] {
    const boxIndices = rankedBoxes.slice(0, probeCount);
    return recognizers.map((recognizer) => ({
      candidate: recognizer.candidate,
      lines: boxIndices.map(
        (boxIndex) => results.get(recognizer.candidate.id)!.get(boxIndex)!,
      ),
    }));
  }

  private async recognizeAllLines(
    source: RgbaImage | null,
    boxes: DetectedBox[],
    recognizer: LoadedRecognizer,
    isCancelled: () => boolean,
    onProgress?: (line: number, lineCount: number) => void,
    cached?: Map<number, ProbeRecognition>,
  ): Promise<RecognizedLine[]> {
    const lines: RecognizedLine[] = [];
    for (const [index, box] of boxes.entries()) {
      throwIfCancelled(isCancelled);
      onProgress?.(index + 1, boxes.length);
      const recognized =
        cached?.get(index) ??
        (await this.recognizeLine(source, box, recognizer));
      if (this.debug) {
        const { x, y, width, height } = box.bbox;
        console.log(
          `${LOG_PREFIX} box #${index} ${width}x${height} @(${x},${y}) (det score ${box.score.toFixed(2)}) -> ${JSON.stringify(recognized.text)} (rec conf ${recognized.confidence.toFixed(3)}, model=${recognizer.candidate.id})`,
        );
      }
      if (recognized.text.length > 0) {
        lines.push({
          bbox: box.bbox,
          text: recognized.text,
          confidence: recognized.confidence,
        });
      }
    }
    return lines;
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
  ): Promise<ProbeRecognition> {
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
    return recognizer.candidate.script === "arabic"
      ? { ...decoded, text: reverseArabicCtcText(decoded.text) }
      : decoded;
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
    model.modelBaseUrl + "manifest.json",
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
