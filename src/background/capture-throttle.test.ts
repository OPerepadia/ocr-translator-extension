import { describe, expect, it } from "vitest";
import { createThrottle } from "./capture-throttle";

function clock() {
  const state = { time: 1_000, slept: [] as number[] };
  return {
    state,
    now: () => state.time,
    // Time moves once the sleep ends, as it would for a real timer.
    sleep: async (ms: number) => {
      state.slept.push(ms);
      await Promise.resolve();
      state.time += ms;
    },
  };
}

describe("createThrottle", () => {
  it("lets the first call through at once", async () => {
    const { state, now, sleep } = clock();
    const wait = createThrottle(600, now, sleep);

    await wait();

    expect(state.slept).toEqual([]);
  });

  it("holds a call that comes too soon until the gap has passed", async () => {
    const { state, now, sleep } = clock();
    const wait = createThrottle(600, now, sleep);

    await wait();
    state.time += 200;
    await wait();

    expect(state.slept).toEqual([400]);
  });

  it("does not delay a call that comes after the gap", async () => {
    const { state, now, sleep } = clock();
    const wait = createThrottle(600, now, sleep);

    await wait();
    state.time += 900;
    await wait();

    expect(state.slept).toEqual([]);
  });

  it("queues concurrent calls one gap apart", async () => {
    const { state, now, sleep } = clock();
    const wait = createThrottle(600, now, sleep);

    await Promise.all([wait(), wait(), wait()]);

    expect(state.slept).toEqual([600, 1200]);
  });
});
