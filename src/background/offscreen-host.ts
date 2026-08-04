import type {
  WorkerLike,
  WorkerRequest,
  WorkerResponse,
} from "../providers/ocr/paddle/protocol";
import { browserApi, type BrowserPort } from "../shared/browser";
import { encodeRequest, OCR_RELAY_PORT } from "../shared/offscreen-relay";

const OFFSCREEN_PAGE = "offscreen.html";
const OFFSCREEN_REASONS = ["WORKERS"];
const OFFSCREEN_JUSTIFICATION =
  "Runs the local OCR engine, which needs a worker and WebGPU.";

/** True where this context can spawn a worker itself — the Firefox event page
 * can, a Chrome service worker cannot. */
export function canHostWorker(): boolean {
  return typeof Worker !== "undefined";
}

let opening: Promise<void> | undefined;

async function ensureDocument(): Promise<void> {
  const offscreen = browserApi.offscreen;
  if (!offscreen) {
    throw new Error("This browser has no offscreen documents.");
  }
  if (await offscreen.hasDocument?.()) {
    return;
  }
  // Chrome allows exactly one and rejects a second createDocument, so
  // concurrent callers share the one attempt.
  opening ??= offscreen
    .createDocument({
      url: OFFSCREEN_PAGE,
      reasons: OFFSCREEN_REASONS,
      justification: OFFSCREEN_JUSTIFICATION,
    })
    .catch((error: unknown) => {
      // hasDocument only exists from Chrome 116, so on anything older the
      // check above cannot see a document that is already up. Being told one
      // exists is the answer we wanted.
      if (!isAlreadyOpen(error)) {
        throw error;
      }
    })
    .finally(() => {
      opening = undefined;
    });
  await opening;
}

function isAlreadyOpen(error: unknown): boolean {
  return /single offscreen document/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * A worker the background does not own: the real one lives in the offscreen
 * document, and this relays the provider's messages to it over a port.
 *
 * `postMessage` is synchronous by contract but encoding a capture is not, so
 * sends are chained rather than run in parallel — the worker relies on init
 * arriving before the recognitions that follow it.
 */
export function createOffscreenWorker(): WorkerLike {
  let port: BrowserPort | undefined;
  let closed = false;

  const relay: WorkerLike = {
    onmessage: null,
    onerror: null,

    postMessage(message: WorkerRequest) {
      queue(async () => {
        const encoded = await encodeRequest(message);
        (port ??= connect()).postMessage(encoded);
      });
    },

    terminate() {
      closed = true;
      port?.disconnect();
      port = undefined;
      // The document itself stays up. It is a shared single-instance host and
      // holds nothing once its worker is gone, so closing it would only make
      // the next recognition pay to build it again.
    },
  };

  // Opening the document is the first link of the send chain; every later send
  // waits on it. Failures land on the sender that follows, never unhandled.
  let sending = ensureDocument();

  function queue(send: () => Promise<void>): void {
    sending = sending
      .then(() => (closed ? undefined : send()))
      .catch((error: unknown) => {
        relay.onerror?.({
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  function connect(): BrowserPort {
    const connected = browserApi.runtime.connect({ name: OCR_RELAY_PORT });
    connected.onMessage.addListener((message) => {
      if (!closed) {
        relay.onmessage?.({ data: message as WorkerResponse });
      }
    });
    connected.onDisconnect.addListener(() => {
      port = undefined;
      if (!closed) {
        relay.onerror?.({ message: "The OCR host stopped responding." });
      }
    });
    return connected;
  }

  return relay;
}
