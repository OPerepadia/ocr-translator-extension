import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configureOrt: vi.fn(),
  createSession: vi.fn(),
  createRegionGrouper: vi.fn(),
  resolveBackend: vi.fn(),
}));

vi.mock("./ort-env", () => ({
  configureOrt: mocks.configureOrt,
  createSession: mocks.createSession,
  ort: {},
  resolveBackend: mocks.resolveBackend,
}));

vi.mock("./region-grouper", () => ({
  RegionGrouper: { create: mocks.createRegionGrouper },
}));

import { PaddleEngine } from "./engine";

const manifest = {
  detector: {
    modelPath: "det.onnx",
  },
  recognizer: {
    modelPath: "rec.onnx",
    dictPath: "dict.txt",
  },
};

describe("PaddleEngine.create", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mocks.configureOrt.mockReset();
    mocks.createSession.mockReset();
    mocks.createRegionGrouper.mockReset();
    mocks.resolveBackend.mockReset();
  });

  it("waits for the detector session before starting the recognizer and region grouper", async () => {
    let finishDetector!: () => void;
    const detectorSession = new Promise<void>((resolve) => {
      finishDetector = resolve;
    });
    mocks.resolveBackend.mockResolvedValue("webgpu");
    mocks.createSession
      .mockReturnValueOnce(detectorSession)
      .mockResolvedValueOnce({});
    mocks.createRegionGrouper.mockResolvedValue({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("model-manifest.json")
          ? new Response(JSON.stringify(manifest))
          : new Response("a\nb"),
      ),
    );

    const creating = PaddleEngine.create({
      model: {
        id: "general",
        modelBaseUrl: "models/",
        script: "general",
      },
      layoutModelBaseUrl: "layout/",
      wasmBaseUrl: "ort/",
      backend: "webgpu",
    });
    await vi.waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1));

    expect(mocks.createRegionGrouper).not.toHaveBeenCalled();
    finishDetector();
    await creating;

    expect(mocks.createSession).toHaveBeenNthCalledWith(
      2,
      "models/rec.onnx",
      "webgpu",
    );
    expect(mocks.createRegionGrouper).toHaveBeenCalledWith("layout/");
  });
});
