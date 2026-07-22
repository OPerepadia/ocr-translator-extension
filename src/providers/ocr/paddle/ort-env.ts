// ONNX Runtime Web setup. The default build ships the "jsep" WASM, which
// carries both WASM and WebGPU kernels, so both backends use the same hosted
// files.
import * as ort from "onnxruntime-web";

import { hasWebGpuAdapter } from "../../../shared/webgpu";

export type OrtBackend = "wasm" | "webgpu";

/** Point ORT at the locally bundled WASM and run single-threaded. Extension
 * pages are not cross-origin isolated, so SharedArrayBuffer / threads are out. */
export function configureOrt(wasmBaseUrl: string): void {
  ort.env.wasm.wasmPaths = wasmBaseUrl;
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = "error";
}

/** Resolve the backend to actually run: "webgpu" only when this context (the
 * worker) exposes a usable adapter, "wasm" otherwise. */
export async function resolveBackend(
  requested: OrtBackend,
): Promise<OrtBackend> {
  return requested === "webgpu" && (await hasWebGpuAdapter())
    ? "webgpu"
    : "wasm";
}

/** Fetch a model as bytes and create a session. Passing bytes (not a URL) keeps
 * the fetch inside the extension's CSP. */
export async function createSession(
  modelUrl: string,
  backend: OrtBackend,
): Promise<ort.InferenceSession> {
  const response = await fetch(modelUrl);
  if (!response.ok) {
    throw new Error(`Failed to load model ${modelUrl}: ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return ort.InferenceSession.create(bytes, {
    // With webgpu first, ORT still falls back to wasm if the EP fails to init.
    executionProviders: backend === "webgpu" ? ["webgpu", "wasm"] : ["wasm"],
    graphOptimizationLevel: "all",
    // silence warnings about unused initializers
    logSeverityLevel: 3,
  });
}

export { ort };
