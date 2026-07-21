export function createKeepAlive(
  ping: () => Promise<unknown>,
  intervalMs: number,
): <T>(task: () => Promise<T>) => Promise<T> {
  let activeTasks = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const keepAlive = () => {
    void ping().catch(() => {});
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    activeTasks += 1;
    if (timer === undefined) {
      keepAlive();
      timer = setInterval(keepAlive, intervalMs);
    }

    try {
      return await task();
    } finally {
      activeTasks -= 1;
      if (activeTasks === 0 && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    }
  };
}
