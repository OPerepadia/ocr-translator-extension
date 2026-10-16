// ONNX Runtime Web setup. The "webgpu" build ships the "asyncify" WASM, which
// carries both the WASM kernels and the native WebGPU execution provider, so
// both backends use the same hosted files. The default build uses the older
// JSEP WebGPU kernels, which ONNX Runtime deprecated in 1.29.
import * as ort from "onnxruntime-web/webgpu";

import { hasWebGpuAdapter } from "../../../shared/webgpu";

export type OrtBackend = "wasm" | "webgpu";

/** How often a WebGPU run nudges the GPU process; see `withGpuPolling`. */
const GPU_POLL_INTERVAL_MS = 4;

// WebGPU sessions whose runs get the nudge: Firefox only, since Chrome
// delivers completions without one.
const polledSessions = new WeakSet<ort.InferenceSession>();

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
  const session = await ort.InferenceSession.create(bytes, {
    // With webgpu first, ORT still falls back to wasm if the EP fails to init.
    executionProviders: backend === "webgpu" ? ["webgpu", "wasm"] : ["wasm"],
    graphOptimizationLevel: "all",
    // silence warnings about unused initializers
    logSeverityLevel: 3,
  });
  if (backend === "webgpu" && import.meta.env.BROWSER === "firefox") {
    polledSessions.add(session);
  }
  return session;
}

export async function runSingleInput(
  session: ort.InferenceSession,
  tensor: ort.Tensor,
): Promise<ort.Tensor> {
  const run = () => session.run({ [session.inputNames[0]]: tensor });
  const results = polledSessions.has(session)
    ? await withGpuPolling(run)
    : await run();
  return results[session.outputNames[0]];
}

/** Run a session once on a zero tensor, so a WebGPU session compiles its
 * shaders before the first real image. */
export async function warmUpSession(
  session: ort.InferenceSession,
  dims: readonly number[],
): Promise<void> {
  const size = dims.reduce((product, dim) => product * dim, 1);
  await runSingleInput(
    session,
    new ort.Tensor("float32", new Float32Array(size), dims),
  );
}

/**
 * Firefox delivers WebGPU completions, such as the output readback that ends
 * every run, only when its GPU process polls the device. That happens on a
 * ~100 ms timer, or when a queue submission arrives. Without a nudge, each run
 * waits for that timer: about 100 ms per recognized line, several times the
 * compute. An empty submit every few ms while a run is in flight cuts that
 * wait to a few ms.
 *
 * Firefox bug: https://bugzilla.mozilla.org/show_bug.cgi?id=1870699
 * ("Don't poll WebGPU from a timer"). Once it is fixed, this can go.
 */
async function withGpuPolling<T>(run: () => Promise<T>): Promise<T> {
  // Unset when ORT fell back to wasm for this session.
  const device = await Promise.resolve(ort.env.webgpu.device).catch(
    () => undefined,
  );
  if (!device) {
    return run();
  }
  const timer = setInterval(
    () => device.queue.submit([]),
    GPU_POLL_INTERVAL_MS,
  );
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}

export { ort };
