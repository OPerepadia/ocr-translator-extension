import type {
  WorkerLike,
  WorkerRequest,
  WorkerResponse,
} from "../providers/ocr/paddle/protocol";
import { browser } from "wxt/browser";
import { t } from "../shared/i18n";
import { encodeRequest, OCR_RELAY_PORT } from "../shared/offscreen-relay";

type BrowserPort = ReturnType<typeof browser.runtime.connect>;

const OFFSCREEN_PAGE = "offscreen.html";
// Chrome offscreen API reference:
// https://developer.chrome.com/docs/extensions/reference/api/offscreen
const OFFSCREEN_REASONS: Parameters<
  typeof browser.offscreen.createDocument
>[0]["reasons"] = ["WORKERS"];
const OFFSCREEN_JUSTIFICATION =
  "Runs the dedicated OCR worker that the service worker cannot create.";

/** True where this context can spawn a worker itself — the Firefox event page
 * can, a Chrome service worker cannot. */
export function canHostWorker(): boolean {
  return typeof Worker !== "undefined";
}

let opening: Promise<void> | undefined;

function ensureDocument(): Promise<void> {
  opening ??= openDocumentIfNeeded().finally(() => {
    opening = undefined;
  });
  return opening;
}

async function openDocumentIfNeeded(): Promise<void> {
  const offscreen = browser.offscreen;
  if (!offscreen) {
    throw new Error("This browser has no offscreen documents.");
  }

  const getUrl = browser.runtime.getURL as (path: string) => string;
  const contexts = await browser.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [getUrl(OFFSCREEN_PAGE)],
  });
  if (contexts.length > 0) {
    return;
  }

  await offscreen.createDocument({
    url: OFFSCREEN_PAGE,
    reasons: OFFSCREEN_REASONS,
    justification: OFFSCREEN_JUSTIFICATION,
  });
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
    const connected = browser.runtime.connect({ name: OCR_RELAY_PORT });
    connected.onMessage.addListener((message) => {
      if (!closed) {
        relay.onmessage?.({ data: message as WorkerResponse });
      }
    });
    connected.onDisconnect.addListener(() => {
      port = undefined;
      if (!closed) {
        relay.onerror?.({ message: t("errorOcrHostStoppedResponding") });
      }
    });
    return connected;
  }

  return relay;
}
