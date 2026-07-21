// Dependency-free so the options page can import it without pulling
// onnxruntime-web (which the OCR worker's ort-env module loads) into its
// bundle.

/** True when this context (page or worker) exposes a usable WebGPU adapter.
 * The API can exist while requestAdapter resolves to null (e.g. blocklisted
 * hardware). */
export async function hasWebGpuAdapter(): Promise<boolean> {
  const gpu = (
    globalThis.navigator as Navigator & {
      gpu?: { requestAdapter(): Promise<unknown> };
    }
  )?.gpu;
  if (!gpu) {
    return false;
  }
  try {
    return Boolean(await gpu.requestAdapter());
  } catch {
    return false;
  }
}
