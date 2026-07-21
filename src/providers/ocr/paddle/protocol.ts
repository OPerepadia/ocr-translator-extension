// Message protocol between the background-side provider (paddle.ts) and the
// inference worker (paddle.worker.ts).

import type { PipelineOcrResult, SerializedError } from "../../../shared/types";
import type { RecognizerScript } from "./auto-select";
import type { OrtBackend } from "./ort-env";

export interface WorkerModelConfig {
  id: string;
  modelBaseUrl: string;
  script: RecognizerScript;
}

export interface InitRequest {
  type: "init";
  id: number;
  model: WorkerModelConfig;
  autoModels?: WorkerModelConfig[];
  wasmBaseUrl: string;
  backend: OrtBackend;
  debug: boolean;
}

export interface RecognizeRequest {
  type: "recognize";
  id: number;
  image: Blob;
  sourceLang?: string;
}

export interface CancelRequest {
  type: "cancel";
  id: number;
}

export type WorkerRequest = InitRequest | RecognizeRequest | CancelRequest;

export interface ReadyResponse {
  type: "ready";
  id: number;
}

export interface ResultResponse {
  type: "result";
  id: number;
  result: PipelineOcrResult;
}

/** Recognition progress */
export interface ProgressResponse {
  type: "progress";
  id: number;
  line: number;
  lineCount: number;
}

export interface ErrorResponse {
  type: "error";
  id: number;
  error: SerializedError;
  /** The worker state may no longer be usable and must be recreated. */
  fatal?: boolean;
}

export type WorkerResponse =
  | ReadyResponse
  | ResultResponse
  | ProgressResponse
  | ErrorResponse;

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return { message: error.message, name: error.name, stack: error.stack };
  }
  return { message: String(error) };
}

export function deserializeError(error: SerializedError): Error {
  const reconstructed = new Error(error.message);
  if (error.name) {
    reconstructed.name = error.name;
  }
  if (error.stack) {
    reconstructed.stack = error.stack;
  }
  return reconstructed;
}
