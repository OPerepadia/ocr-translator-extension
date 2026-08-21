import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getWebGpuAdapterStatus,
  hasWebGpuAdapter,
} from "./webgpu";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WebGPU adapter detection", () => {
  it("reports a hardware adapter as available", async () => {
    stubAdapter({ info: { isFallbackAdapter: false } });

    await expect(getWebGpuAdapterStatus()).resolves.toBe("available");
    await expect(hasWebGpuAdapter()).resolves.toBe(true);
  });

  it("reports a fallback adapter as software-only", async () => {
    stubAdapter({ info: { isFallbackAdapter: true } });

    await expect(getWebGpuAdapterStatus()).resolves.toBe("software");
    await expect(hasWebGpuAdapter()).resolves.toBe(false);
  });

  it("recognizes legacy and named SwiftShader adapters", async () => {
    stubAdapter({ isFallbackAdapter: true });
    await expect(getWebGpuAdapterStatus()).resolves.toBe("software");

    stubAdapter({ info: { description: "Google SwiftShader" } });
    await expect(getWebGpuAdapterStatus()).resolves.toBe("software");
  });

  it("reads adapter info through the legacy method", async () => {
    stubAdapter({
      requestAdapterInfo: async () => ({ isFallbackAdapter: true }),
    });

    await expect(getWebGpuAdapterStatus()).resolves.toBe("software");
  });

  it("reports missing and rejected adapters as unavailable", async () => {
    stubAdapter(null);
    await expect(getWebGpuAdapterStatus()).resolves.toBe("unavailable");

    vi.stubGlobal("navigator", {
      gpu: { requestAdapter: () => Promise.reject(new Error("blocked")) },
    });
    await expect(getWebGpuAdapterStatus()).resolves.toBe("unavailable");
  });
});

function stubAdapter(adapter: unknown): void {
  vi.stubGlobal("navigator", {
    gpu: { requestAdapter: () => Promise.resolve(adapter) },
  });
}
