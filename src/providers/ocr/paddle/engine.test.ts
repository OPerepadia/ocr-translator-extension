import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configureOrt: vi.fn(),
  createSession: vi.fn(),
  createRegionGrouper: vi.fn(),
  resolveBackend: vi.fn(),
  runSingleInput: vi.fn(),
  warmUpSession: vi.fn(),
}));

vi.mock("./ort-env", () => ({
  configureOrt: mocks.configureOrt,
  createSession: mocks.createSession,
  ort: {},
  resolveBackend: mocks.resolveBackend,
  runSingleInput: mocks.runSingleInput,
  warmUpSession: mocks.warmUpSession,
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
    imageHeight: 48,
  },
};

const engineOptions = {
  model: {
    id: "general",
    modelBaseUrl: "models/",
    script: "general" as const,
  },
  layoutModelBaseUrl: "layout/",
  wasmBaseUrl: "ort/",
};

function stubModelFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("model-manifest.json")
        ? new Response(JSON.stringify(manifest))
        : new Response("a\nb"),
    ),
  );
}

describe("PaddleEngine.create", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mocks.configureOrt.mockReset();
    mocks.createSession.mockReset();
    mocks.createRegionGrouper.mockReset();
    mocks.resolveBackend.mockReset();
    mocks.warmUpSession.mockReset();
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
    stubModelFetch();

    const creating = PaddleEngine.create({
      ...engineOptions,
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

  it("warms up the WebGPU sessions before reporting ready", async () => {
    const detSession = { name: "det" };
    const recSession = { name: "rec" };
    mocks.resolveBackend.mockResolvedValue("webgpu");
    mocks.createSession
      .mockResolvedValueOnce(detSession)
      .mockResolvedValueOnce(recSession);
    mocks.createRegionGrouper.mockResolvedValue({});
    stubModelFetch();

    await PaddleEngine.create({ ...engineOptions, backend: "webgpu" });

    expect(mocks.warmUpSession.mock.calls).toEqual([
      [detSession, [1, 3, 32, 32]],
      [recSession, [1, 3, 48, 48]],
      [recSession, [1, 3, 48, 128]],
    ]);
  });

  it("skips the warm-up on wasm", async () => {
    mocks.resolveBackend.mockResolvedValue("wasm");
    mocks.createSession.mockResolvedValue({});
    mocks.createRegionGrouper.mockResolvedValue({});
    stubModelFetch();

    await PaddleEngine.create({ ...engineOptions, backend: "webgpu" });

    expect(mocks.warmUpSession).not.toHaveBeenCalled();
  });
});
