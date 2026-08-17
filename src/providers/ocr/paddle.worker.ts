// PP-OCRv6 inference worker. Owns the ORT sessions and runs detection +
// recognition off the background thread.

import { PaddleEngine } from "./paddle/engine";
import {
  serializeError,
  type WorkerRequest,
  type WorkerResponse,
} from "./paddle/protocol";

let engine: PaddleEngine | null = null;
let initId: number | null = null;

// Ids the provider asked us to cancel. ORT cannot be interrupted mid-run(), so
// the engine checks this set at safe checkpoints between sub-steps.
const cancelled = new Set<number>();
const activeRecognitions = new Set<number>();

function post(message: WorkerResponse): void {
  self.postMessage(message);
}

self.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  if (activeRecognitions.size === 0) {
    return;
  }
  event.preventDefault();
  for (const id of activeRecognitions) {
    post({
      type: "error",
      id,
      error: serializeError(event.reason),
      fatal: true,
    });
  }
  activeRecognitions.clear();
});

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  if (message.type === "cancel") {
    cancelled.add(message.id);
    return;
  }

  try {
    if (message.type === "init") {
      // Guard against duplicate init messages (the provider already memoizes init).
      if (!engine || initId !== message.id) {
        engine = await PaddleEngine.create({
          model: message.model,
          autoModels: message.autoModels,
          layoutModelBaseUrl: message.layoutModelBaseUrl,
          wasmBaseUrl: message.wasmBaseUrl,
          backend: message.backend,
          debug: message.debug,
        });
        initId = message.id;
      }
      post({ type: "ready", id: message.id });
      return;
    }

    if (message.type === "recognize") {
      if (!engine) {
        throw new Error("PP-OCRv6 engine is not initialized.");
      }
      activeRecognitions.add(message.id);
      const result = await engine.recognize(
        message.image,
        message.sourceLang,
        () => cancelled.has(message.id),
        (line, lineCount) =>
          post({ type: "progress", id: message.id, line, lineCount }),
      );
      activeRecognitions.delete(message.id);
      cancelled.delete(message.id);
      post({ type: "result", id: message.id, result });
    }
  } catch (error) {
    activeRecognitions.delete(message.id);
    cancelled.delete(message.id);
    post({
      type: "error",
      id: message.id,
      error: serializeError(error),
      fatal: message.type === "recognize",
    });
  }
};
