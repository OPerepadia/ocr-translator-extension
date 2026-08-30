import { describe, expect, it, vi } from "vitest";
import { createPaddleOcrProvider } from "./paddle";
import type {
  WorkerLike,
  WorkerRequest,
  WorkerResponse,
} from "./paddle/protocol";

/** Minimal Worker stand-in. Auto-replies "ready" to init; lets the test drive
 * recognize responses. */
class FakeWorker implements WorkerLike {
  messages: WorkerRequest[] = [];
  onmessage: ((event: { data: WorkerResponse }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  terminated = false;
  /** Hold back the "ready" reply so a test can observe init still in flight. */
  deferInit = false;
  private pendingInitId?: number;

  postMessage(message: WorkerRequest): void {
    this.messages.push(message);
    if (message.type === "init") {
      if (this.deferInit) {
        this.pendingInitId = message.id;
        return;
      }
      queueMicrotask(() =>
        this.onmessage?.({ data: { type: "ready", id: message.id } }),
      );
    }
  }

  /** Completes an init held back by deferInit. */
  finishInit(): void {
    const id = this.pendingInitId;
    if (id !== undefined) {
      this.pendingInitId = undefined;
      this.onmessage?.({ data: { type: "ready", id } });
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(response: WorkerResponse): void {
    this.onmessage?.({ data: response });
  }

  ofType<T extends WorkerRequest["type"]>(
    type: T,
  ): Array<Extract<WorkerRequest, { type: T }>> {
    return this.messages.filter(
      (m): m is Extract<WorkerRequest, { type: T }> => m.type === type,
    );
  }
}

function makeProvider(fake: FakeWorker) {
  return createPaddleOcrProvider({
    createWorker: () => fake,
    resolveUrl: (path: string) => path,
  });
}

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("createPaddleOcrProvider", () => {
  it("initializes once and resolves recognize with the worker result", async () => {
    const fake = new FakeWorker();
    const provider = makeProvider(fake);

    const promise = provider.recognize({ image: new Blob(["img"]) });
    await tick();

    const [recognize] = fake.ofType("recognize");
    expect(recognize).toBeDefined();
    expect(fake.ofType("init")).toHaveLength(1);

    fake.reply({
      type: "result",
      id: recognize.id,
      result: { text: "hello", confidence: 0.9 },
    });

    await expect(promise).resolves.toMatchObject({ text: "hello" });
  });

  it("reports initializing when recognize starts while preload is still loading", async () => {
    const fake = new FakeWorker();
    fake.deferInit = true;
    const provider = makeProvider(fake);

    // Preload begins during region selection and has not finished yet.
    void provider.preload?.();
    await tick();

    const stages: string[] = [];
    const promise = provider.recognize(
      { image: new Blob(["img"]) },
      undefined,
      (status) => stages.push(status.stage),
    );
    await tick();

    // Without a status here the loading UI stays hidden behind the selection
    // dim for the whole model load.
    expect(stages).toEqual(["initializing"]);

    fake.finishInit();
    await tick();
    expect(stages).toEqual(["initializing", "recognizing"]);

    const [recognize] = fake.ofType("recognize");
    fake.reply({
      type: "result",
      id: recognize.id,
      result: { text: "hello", confidence: 0.9 },
    });
    await expect(promise).resolves.toMatchObject({ text: "hello" });
    expect(fake.ofType("init")).toHaveLength(1);
  });

  it("passes Auto recognizer candidates to the worker", async () => {
    const fake = new FakeWorker();
    const provider = createPaddleOcrProvider({
      model: {
        id: "v6-multi",
        modelDir: "models/general/",
        script: "general",
      },
      additionalModels: [
        {
          id: "cyrillic-v5",
          modelDir: "models/cyrillic/",
          script: "cyrillic",
        },
      ],
      createWorker: () => fake,
      resolveUrl: (path: string) => `extension://${path}`,
    });

    await provider.preload?.();

    expect(fake.ofType("init")[0]).toMatchObject({
      layoutModelBaseUrl: "extension://assets/layout-grouping/",
      scriptModelBaseUrl: "extension://assets/script-identification/",
      model: {
        id: "v6-multi",
        modelBaseUrl: "extension://models/general/",
        script: "general",
      },
      additionalModels: [
        {
          id: "cyrillic-v5",
          modelBaseUrl: "extension://models/cyrillic/",
          script: "cyrillic",
        },
      ],
    });
  });

  it("rejects immediately on abort, posts cancel, and drops the late result", async () => {
    const fake = new FakeWorker();
    const provider = makeProvider(fake);
    const controller = new AbortController();

    const promise = provider.recognize(
      { image: new Blob(["img"]) },
      controller.signal,
    );
    await tick();
    const [recognize] = fake.ofType("recognize");

    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.ofType("cancel").some((m) => m.id === recognize.id)).toBe(true);

    // A late result for the aborted id must be ignored (no unhandled rejection,
    // no throw).
    expect(() =>
      fake.reply({
        type: "result",
        id: recognize.id,
        result: { text: "late", confidence: 1 },
      }),
    ).not.toThrow();
  });

  it("rejects an unsupported ImageData input", async () => {
    const fake = new FakeWorker();
    const provider = makeProvider(fake);
    const imageData = { width: 1, height: 1 } as unknown as ImageData;
    await expect(
      provider.recognize({ image: imageData }),
    ).rejects.toThrow(/Blob/);
  });

  it("rejects pending requests and terminates on dispose", async () => {
    const fake = new FakeWorker();
    const provider = makeProvider(fake);

    const promise = provider.recognize({ image: new Blob(["img"]) });
    await tick();

    await provider.dispose?.();

    await expect(promise).rejects.toThrow(/disposed/);
    expect(fake.terminated).toBe(true);
  });

  it("propagates a worker error response", async () => {
    const fake = new FakeWorker();
    const provider = makeProvider(fake);

    const promise = provider.recognize({ image: new Blob(["img"]) });
    await tick();
    const [recognize] = fake.ofType("recognize");

    fake.reply({
      type: "error",
      id: recognize.id,
      error: { message: "boom", name: "EngineError" },
    });

    await expect(promise).rejects.toThrow(/boom/);
  });

  it("restarts the worker after a fatal recognition error", async () => {
    const workers: FakeWorker[] = [];
    const provider = createPaddleOcrProvider({
      backend: "webgpu",
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
      resolveUrl: (path: string) => path,
    });

    const first = provider.recognize({ image: new Blob(["img"]) });
    await tick();
    const [recognize] = workers[0].ofType("recognize");

    workers[0].reply({
      type: "error",
      id: recognize.id,
      error: {
        message: "Mapping WebGPU buffer failed: Invalid buffer",
        name: "OperationError",
      },
      fatal: true,
    });

    await expect(first).rejects.toThrow(/Insufficient memory/);
    expect(workers[0].terminated).toBe(true);

    const retry = provider.recognize({ image: new Blob(["img"]) });
    await tick();
    expect(workers).toHaveLength(2);
    const [retryRequest] = workers[1].ofType("recognize");
    workers[1].reply({
      type: "result",
      id: retryRequest.id,
      result: { text: "retried" },
    });

    await expect(retry).resolves.toMatchObject({ text: "retried" });
  });

  it("times out a recognition that stops responding and resets the worker", async () => {
    vi.useFakeTimers();
    try {
      const workers: FakeWorker[] = [];
      const provider = createPaddleOcrProvider({
        createWorker: () => {
          const worker = new FakeWorker();
          workers.push(worker);
          return worker as unknown as Worker;
        },
        recognitionTimeoutMs: 10,
        resolveUrl: (path: string) => path,
      });

      const promise = provider.recognize({ image: new Blob(["img"]) });
      const rejection = expect(promise).rejects.toThrow(/stopped responding/);
      await vi.advanceTimersByTimeAsync(10);

      await rejection;
      expect(workers[0].terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes the recognition timeout when progress arrives", async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeWorker();
      const provider = createPaddleOcrProvider({
        createWorker: () => fake,
        recognitionTimeoutMs: 10,
        resolveUrl: (path: string) => path,
      });

      const promise = provider.recognize({ image: new Blob(["img"]) });
      await vi.advanceTimersByTimeAsync(9);
      const [recognize] = fake.ofType("recognize");
      fake.reply({
        type: "progress",
        id: recognize.id,
        line: 1,
        lineCount: 2,
      });

      await vi.advanceTimersByTimeAsync(9);
      expect(fake.terminated).toBe(false);
      fake.reply({
        type: "result",
        id: recognize.id,
        result: { text: "done" },
      });

      await expect(promise).resolves.toMatchObject({ text: "done" });
    } finally {
      vi.useRealTimers();
    }
  });
});
