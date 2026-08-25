// Chrome's service worker cannot create the dedicated OCR worker, so the engine
// runs here and the background talks to it over a port. Firefox never loads this
// page — its event page hosts the worker directly.

import type {
  WorkerLike,
  WorkerResponse,
} from "@/providers/ocr/paddle/protocol";
import { createInferenceWorker } from "@/providers/ocr/paddle/worker-factory";
import { browser } from "wxt/browser";
import {
  decodeRequest,
  OCR_RELAY_PORT,
  type RelayedRequest,
} from "@/shared/offscreen-relay";

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== OCR_RELAY_PORT) {
    return;
  }

  // One worker per connection: the provider that owns it lives in the service
  // worker, so a reconnect means that provider is gone and its models with it.
  let worker: WorkerLike | undefined = createInferenceWorker();

  worker.onmessage = (event) => port.postMessage(event.data);
  worker.onerror = (event) =>
    port.postMessage({
      type: "error",
      id: -1,
      error: { message: event.message ?? "The OCR worker crashed." },
      fatal: true,
    } satisfies WorkerResponse);

  port.onMessage.addListener((message) => {
    worker?.postMessage(decodeRequest(message as RelayedRequest));
  });

  port.onDisconnect.addListener(() => {
    worker?.terminate();
    worker = undefined;
  });
});
