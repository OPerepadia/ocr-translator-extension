import type { PipelineOcrResult } from "../../shared/types";
import { t } from "../../shared/i18n";
import {
  deserializeError,
  type RecognizerScript,
  type WorkerLike,
  type WorkerModelConfig,
  type WorkerResponse,
} from "./paddle/protocol";
import { createInferenceWorker } from "./paddle/worker-factory";
import type { OrtBackend } from "./paddle/ort-env";
import type { OcrProvider, OcrStatus } from "./types";

const WASM_DIR = "ort/";
const LAYOUT_MODEL_DIR = "assets/layout-grouping/";
const SCRIPT_MODEL_DIR = "assets/script-identification/";
const DEFAULT_RECOGNITION_TIMEOUT_MS = 60_000;

const DEBUG_PPOCR = true;

export interface PaddleModelConfig {
  id: string;
  modelDir: string;
  script: RecognizerScript;
}

const DEFAULT_MODEL: PaddleModelConfig = {
  id: "v6-multi",
  modelDir: "assets/ocr/ppocrv6-small/",
  script: "general",
};

export interface PaddleProviderConfig {
  model?: PaddleModelConfig;
  additionalModels?: readonly PaddleModelConfig[];
  backend?: OrtBackend;
  /** Log detection/recognition diagnostics to the worker console. */
  debug?: boolean;
  /** Resolve an extension-relative path to a full URL (background supplies
   * browser.runtime.getURL; keeps the provider browser-API free). */
  resolveUrl?: (path: string) => string;
  /** Create the inference worker. Overridable for tests, and for Chrome, where
   * the service worker cannot spawn one itself. */
  createWorker?: () => WorkerLike;
  /** Maximum time without recognition progress. Overridable for tests. */
  recognitionTimeoutMs?: number;
}

interface PendingEntry {
  resolve: (value?: PipelineOcrResult) => void;
  reject: (error: Error) => void;
  /** Receives recognition progress while this request runs (recognize only). */
  onStatus?: (status: OcrStatus) => void;
  refreshTimeout?: () => void;
}

export function createPaddleOcrProvider(rawConfig?: unknown): OcrProvider {
  // Registry passes the raw settings object; accept unknown, ignore extra fields.
  const config = (rawConfig ?? {}) as PaddleProviderConfig;
  const model = config.model ?? DEFAULT_MODEL;
  const backend = config.backend ?? "wasm";
  const debug = config.debug ?? DEBUG_PPOCR;
  const resolveUrl = config.resolveUrl;
  const recognitionTimeoutMs =
    config.recognitionTimeoutMs ?? DEFAULT_RECOGNITION_TIMEOUT_MS;
  const createWorker = config.createWorker ?? createInferenceWorker;

  let worker: WorkerLike | null = null;
  let initPromise: Promise<void> | null = null;
  let initialized = false;
  let nextId = 1;
  const pending = new Map<number, PendingEntry>();

  function routeResponse(response: WorkerResponse): void {
    if (response.type === "error" && response.fatal) {
      failAll(
        userFacingRecognitionError(
          deserializeError(response.error),
          backend,
        ),
      );
      return;
    }
    const entry = pending.get(response.id);
    if (!entry) {
      // Late response for a request that was aborted or disposed; ignore.
      return;
    }
    if (response.type === "progress") {
      // Progress keeps the request open; only result/error/ready settle it.
      entry.refreshTimeout?.();
      entry.onStatus?.({
        stage: "recognizing",
        line: response.line,
        lineCount: response.lineCount,
      });
      return;
    }
    pending.delete(response.id);
    if (response.type === "error") {
      entry.reject(deserializeError(response.error));
    } else if (response.type === "result") {
      entry.resolve(response.result);
    } else {
      entry.resolve();
    }
  }

  function failAll(error: Error): void {
    worker?.terminate();
    worker = null;
    initPromise = null;
    initialized = false;
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
  }

  function ensureWorker(): WorkerLike {
    if (!worker) {
      worker = createWorker();
      worker.onmessage = (event) => routeResponse(event.data);
      worker.onerror = (event) =>
        failAll(new Error(event.message || t("errorOcrWorkerCrashed")));
    }
    return worker;
  }

  function ensureInit(): Promise<void> {
    if (!resolveUrl) {
      return Promise.reject(
        new Error(
          "PP-OCRv6 provider requires config.resolveUrl to locate model and wasm assets.",
        ),
      );
    }

    if (!initPromise) {
      const resolve = resolveUrl;
      const resolveModel = (model: PaddleModelConfig): WorkerModelConfig => ({
        id: model.id,
        modelBaseUrl: resolve(model.modelDir),
        script: model.script,
      });
      const activeWorker = ensureWorker();
      const id = nextId++;
      initPromise = new Promise<void>((resolvePromise, reject) => {
        pending.set(id, {
          resolve: () => {
            initialized = true;
            resolvePromise();
          },
          reject,
        });
        activeWorker.postMessage({
          type: "init",
          id,
          model: resolveModel(model),
          additionalModels: config.additionalModels?.map(resolveModel),
          ...(config.additionalModels?.length
            ? { scriptModelBaseUrl: resolve(SCRIPT_MODEL_DIR) }
            : {}),
          layoutModelBaseUrl: resolve(LAYOUT_MODEL_DIR),
          wasmBaseUrl: resolve(WASM_DIR),
          backend,
          debug,
        });
      }).catch((error: Error) => {
        // Allow a later call to retry initialization.
        initPromise = null;
        throw error;
      });
    }
    return initPromise;
  }

  return {
    id: "paddle",

    async preload(signal) {
      signal?.throwIfAborted();
      await ensureInit();
    },

    async recognize(input, signal, onStatus) {
      signal?.throwIfAborted();

      if (!(input.image instanceof Blob)) {
        throw new Error("PP-OCRv6 provider requires a Blob image.");
      }
      const image = input.image;

      if (!initialized) {
        onStatus?.({ stage: "initializing" });
      }
      await ensureInit();
      signal?.throwIfAborted();
      onStatus?.({ stage: "recognizing" });
      const activeWorker = ensureWorker();

      const id = nextId++;
      return new Promise<PipelineOcrResult>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const clearRecognitionTimeout = (): void => clearTimeout(timeout);
        const refreshTimeout = (): void => {
          clearRecognitionTimeout();
          timeout = setTimeout(() => {
            failAll(
              userFacingRecognitionError(
                new Error(t("errorRecognitionStoppedResponding")),
                backend,
              ),
            );
          }, recognitionTimeoutMs);
        };
        const onAbort = (): void => {
          pending.delete(id);
          clearRecognitionTimeout();
          // Cooperative cancel; the caller is rejected immediately regardless.
          activeWorker.postMessage({ type: "cancel", id });
          reject(toAbortError(signal));
        };

        pending.set(id, {
          resolve: (value) => {
            clearRecognitionTimeout();
            signal?.removeEventListener("abort", onAbort);
            resolve(value as PipelineOcrResult);
          },
          reject: (error) => {
            clearRecognitionTimeout();
            signal?.removeEventListener("abort", onAbort);
            reject(error);
          },
          onStatus,
          refreshTimeout,
        });

        if (signal) {
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        }

        refreshTimeout();
        activeWorker.postMessage({
          type: "recognize",
          id,
          image,
          sourceLang: input.sourceLang,
        });
      });
    },

    async dispose() {
      if (worker) {
        worker.terminate();
        worker = null;
      }
      initPromise = null;
      initialized = false;
      const error = new Error("PP-OCRv6 provider disposed.");
      for (const entry of pending.values()) {
        entry.reject(error);
      }
      pending.clear();
    },
  };
}

function userFacingRecognitionError(
  error: Error,
  backend: OrtBackend,
): Error {
  if (
    backend === "webgpu" &&
    (/webgpu|gpu buffer|invalid buffer|mapping.*buffer|stopped responding/i.test(
      error.message,
    ) ||
      error.name === "OperationError")
  ) {
    return new Error(
      t("errorOcrInsufficientMemory"),
    );
  }
  if (/OCR host stopped responding/i.test(error.message)) {
    return new Error(t("errorOcrHostStoppedResponding"));
  }
  return error;
}

function toAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return new DOMException("Aborted", "AbortError");
}
