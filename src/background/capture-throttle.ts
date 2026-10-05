/**
 * Spaces calls at least `minGapMs` apart. `tabs.captureVisibleTab` allows two
 * calls a second and Chrome counts a refused call against that, so a loop that
 * retries too early never recovers.
 *
 * Each caller gets its own slot, so concurrent callers queue behind each other.
 */
export function createThrottle(
  minGapMs: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): () => Promise<void> {
  let nextSlotAt = 0;

  return async () => {
    const current = now();
    const slotAt = Math.max(current, nextSlotAt);
    nextSlotAt = slotAt + minGapMs;
    if (slotAt > current) {
      await sleep(slotAt - current);
    }
  };
}
