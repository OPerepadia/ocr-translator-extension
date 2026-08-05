import type { WorkerLike } from "./protocol";

/** Spawn the inference worker. Called from whichever context can host one: the
 * event page on Firefox, the offscreen document on Chrome. Both go through here
 * so Vite emits a single worker chunk. */
export function createInferenceWorker(): WorkerLike {
  // The DOM Worker types its handler properties against DOM events; the
  // provider only ever reads `data` and `message` off them.
  return new Worker(new URL("../paddle.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as WorkerLike;
}
