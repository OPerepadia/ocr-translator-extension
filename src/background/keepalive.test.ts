import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeepAlive } from "./keepalive";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createKeepAlive", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pings while a task is active and stops when it settles", async () => {
    vi.useFakeTimers();
    const ping = vi.fn(async () => {});
    const task = deferred<string>();
    const runWithKeepAlive = createKeepAlive(ping, 20_000);

    const result = runWithKeepAlive(() => task.promise);
    expect(ping).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(ping).toHaveBeenCalledTimes(2);

    task.resolve("done");
    await expect(result).resolves.toBe("done");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("stays active until every concurrent task settles", async () => {
    vi.useFakeTimers();
    const ping = vi.fn(async () => {});
    const first = deferred<void>();
    const second = deferred<void>();
    const runWithKeepAlive = createKeepAlive(ping, 20_000);

    const firstResult = runWithKeepAlive(() => first.promise);
    const secondResult = runWithKeepAlive(() => second.promise);

    first.resolve();
    await firstResult;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ping).toHaveBeenCalledTimes(2);

    second.resolve();
    await secondResult;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ping).toHaveBeenCalledTimes(2);
  });
});
