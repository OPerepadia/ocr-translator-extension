import { describe, expect, it, vi } from "vitest";
import { LatestRequestRunner } from "./latest-request";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function idSequence(): () => string {
  let next = 0;
  return () => `request-${++next}`;
}

describe("LatestRequestRunner", () => {
  it("presents a successful current request and clears the slot", async () => {
    const onSuccess = vi.fn();
    const onSettled = vi.fn();
    const runner = new LatestRequestRunner(idSequence(), vi.fn());

    await runner.run({
      request: async () => "translated text",
      onSuccess,
      onError: vi.fn(),
      onSettled,
    });

    expect(onSuccess).toHaveBeenCalledWith("translated text");
    expect(onSettled).toHaveBeenCalledOnce();
    expect(runner.activeRequestId).toBeNull();
  });

  it("cancels and ignores a request superseded by a newer one", async () => {
    const first = deferred<string>();
    const cancel = vi.fn();
    const onSuccess = vi.fn();
    const onSettled = vi.fn();
    const runner = new LatestRequestRunner(idSequence(), cancel);

    const firstRun = runner.run({
      request: () => first.promise,
      onSuccess,
      onError: vi.fn(),
      onSettled,
    });
    const secondRun = runner.run({
      request: async () => "new result",
      onSuccess,
      onError: vi.fn(),
      onSettled,
    });
    first.resolve("stale result");
    await Promise.all([firstRun, secondRun]);

    expect(cancel).toHaveBeenCalledWith("request-1");
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith("new result");
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("reports errors only while their request is current", async () => {
    const onError = vi.fn();
    const runner = new LatestRequestRunner(idSequence(), vi.fn());

    await runner.run({
      request: async () => {
        throw new Error("Translation unavailable");
      },
      onSuccess: vi.fn(),
      onError,
    });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Translation unavailable" }),
    );
    expect(runner.activeRequestId).toBeNull();
  });

  it("notifies the background when explicitly cancelled", async () => {
    const pending = deferred<string>();
    const cancel = vi.fn();
    const runner = new LatestRequestRunner(idSequence(), cancel);
    const run = runner.run({
      request: () => pending.promise,
      onSuccess: vi.fn(),
      onError: vi.fn(),
    });

    runner.cancel();

    expect(cancel).toHaveBeenCalledWith("request-1");
    expect(runner.activeRequestId).toBeNull();
    pending.resolve("unused result");
    await run;
  });

  it("does not start requests after disposal", async () => {
    const request = vi.fn(async () => "unused result");
    const runner = new LatestRequestRunner(idSequence(), vi.fn());

    runner.dispose();
    await runner.run({
      request,
      onSuccess: vi.fn(),
      onError: vi.fn(),
    });

    expect(request).not.toHaveBeenCalled();
    expect(runner.activeRequestId).toBeNull();
  });
});
