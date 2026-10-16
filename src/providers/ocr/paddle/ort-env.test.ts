import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  submit: vi.fn(),
  webgpu: {} as { device?: Promise<unknown> },
}));

vi.mock("onnxruntime-web/webgpu", () => ({
  InferenceSession: { create: mocks.create },
  Tensor: class {
    constructor(
      readonly type: string,
      readonly data: unknown,
      readonly dims: readonly number[],
    ) {}
  },
  env: { wasm: {}, webgpu: mocks.webgpu },
}));

import { createSession, runSingleInput } from "./ort-env";

function fakeSession(run: () => Promise<unknown>) {
  return { inputNames: ["x"], outputNames: ["y"], run: vi.fn(run) };
}

describe("runSingleInput", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("BROWSER", "firefox");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1]))),
    );
    mocks.webgpu.device = Promise.resolve({
      queue: { submit: mocks.submit },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    mocks.create.mockReset();
    mocks.submit.mockReset();
  });

  it("nudges the GPU queue while a webgpu run is in flight", async () => {
    let finish!: (value: unknown) => void;
    const session = fakeSession(
      () => new Promise((resolve) => (finish = resolve)),
    );
    mocks.create.mockResolvedValue(session);
    await createSession("det.onnx", "webgpu");

    const running = runSingleInput(session as never, {} as never);
    await vi.advanceTimersByTimeAsync(20);
    const nudges = mocks.submit.mock.calls.length;
    expect(nudges).toBeGreaterThan(0);
    expect(mocks.submit).toHaveBeenCalledWith([]);

    finish({ y: "output" });
    await expect(running).resolves.toBe("output");
    await vi.advanceTimersByTimeAsync(20);
    expect(mocks.submit).toHaveBeenCalledTimes(nudges);
  });

  it("does not nudge the GPU queue outside Firefox", async () => {
    vi.stubEnv("BROWSER", "chrome");
    const session = fakeSession(async () => ({ y: "output" }));
    mocks.create.mockResolvedValue(session);
    await createSession("det.onnx", "webgpu");

    await expect(runSingleInput(session as never, {} as never)).resolves.toBe(
      "output",
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("does not touch the GPU for a wasm session", async () => {
    const session = fakeSession(async () => ({ y: "output" }));
    mocks.create.mockResolvedValue(session);
    await createSession("det.onnx", "wasm");

    await expect(runSingleInput(session as never, {} as never)).resolves.toBe(
      "output",
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("runs without nudges when ORT has no WebGPU device", async () => {
    mocks.webgpu.device = Promise.reject(new Error("no device"));
    const session = fakeSession(async () => ({ y: "output" }));
    mocks.create.mockResolvedValue(session);
    await createSession("det.onnx", "webgpu");

    await expect(runSingleInput(session as never, {} as never)).resolves.toBe(
      "output",
    );
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});
