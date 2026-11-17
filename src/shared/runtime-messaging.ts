import { browser, type Browser } from "wxt/browser";
import {
  deserializeError,
  serializeError,
  type BackgroundRequest,
  type SendToContent,
} from "./messages";
import type { SerializedError } from "./types";

// Firefox lets a listener return a promise and forwards its rejection to the
// sender. Chrome ignores the returned promise unless the listener returns
// `true` and answers through sendResponse, which cannot signal failure at all.
// Hence the envelope: results and errors both travel as plain data.
type ResponseEnvelope =
  | { ok: true; value: unknown }
  | { ok: false; error: SerializedError };

export type RequestHandler = (
  message: unknown,
  sender: Browser.runtime.MessageSender,
) => Promise<unknown> | unknown;

/** Always answers, even with nothing to return, so no sender is left waiting
 * on a channel that closes empty. */
export function onRequest(handler: RequestHandler): void {
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void Promise.resolve()
      .then(() => handler(message, sender))
      .then(
        (value) => sendResponse({ ok: true, value }),
        (error: unknown) =>
          sendResponse({ ok: false, error: serializeError(error) }),
      );
    return true;
  });
}

export async function sendRequest<TResponse = unknown>(
  message: BackgroundRequest,
): Promise<TResponse> {
  const envelope = await browser.runtime.sendMessage<
    BackgroundRequest,
    ResponseEnvelope | undefined
  >(message);

  if (envelope && envelope.ok === false) {
    throw deserializeError(envelope.error);
  }

  return envelope?.value as TResponse;
}

// Spread keeps an omitted `options` omitted, not `undefined`.
export const sendToContent: SendToContent = (...args) =>
  browser.tabs.sendMessage(...args);
