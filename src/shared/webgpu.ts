// Dependency-free so the options page can import it without pulling
// onnxruntime-web (which the OCR worker's ort-env module loads) into its
// bundle.

export type WebGpuAdapterStatus = "available" | "software" | "unavailable";

interface WebGpuAdapterInfo {
  description?: string;
  isFallbackAdapter?: boolean;
}

interface WebGpuAdapter {
  info?: WebGpuAdapterInfo;
  isFallbackAdapter?: boolean;
  requestAdapterInfo?(): Promise<WebGpuAdapterInfo>;
}

export async function getWebGpuAdapterStatus(): Promise<WebGpuAdapterStatus> {
  const gpu = (
    globalThis.navigator as unknown as {
      gpu?: { requestAdapter(): Promise<WebGpuAdapter | null> };
    }
  )?.gpu;
  if (!gpu) {
    return "unavailable";
  }
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      return "unavailable";
    }
    let info = adapter.info;
    if (!info && adapter.requestAdapterInfo) {
      try {
        info = await adapter.requestAdapterInfo();
      } catch {
        // Adapter identity is optional; availability still has a useful answer.
      }
    }
    const fallback =
      info?.isFallbackAdapter === true ||
      adapter.isFallbackAdapter === true ||
      /swiftshader/i.test(info?.description ?? "");
    return fallback ? "software" : "available";
  } catch {
    return "unavailable";
  }
}

/** True when this context exposes a hardware-backed WebGPU adapter. */
export async function hasWebGpuAdapter(): Promise<boolean> {
  return (await getWebGpuAdapterStatus()) === "available";
}
