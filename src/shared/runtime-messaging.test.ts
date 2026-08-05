import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeMessage } from "./messages";
import { onRequest, sendRequest } from "./runtime-messaging";

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
});

function installListenerCapture(): () => Listener | undefined {
  let listener: Listener | undefined;
  vi.stubGlobal("browser", {
    runtime: {
      onMessage: {
        addListener: vi.fn((next: Listener) => {
          listener = next;
        }),
      },
    },
  });
  return () => listener;
}

function respond(
  listener: Listener | undefined,
  message: unknown,
): Promise<unknown> {
  return new Promise((resolve) => {
    listener?.(message, {}, resolve);
  });
}

describe("onRequest", () => {
  it("wraps a resolved handler result", async () => {
    const getListener = installListenerCapture();
    onRequest(async () => ({ items: ["one", "two"] }));

    await expect(respond(getListener(), { type: "ANY" })).resolves.toEqual({
      ok: true,
      value: { items: ["one", "two"] },
    });
  });

  it("wraps a rejection as a serialized error", async () => {
    const getListener = installListenerCapture();
    onRequest(async () => {
      throw new Error("Recognition stopped responding.");
    });

    const envelope = (await respond(getListener(), { type: "ANY" })) as {
      ok: boolean;
      error: { message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.message).toBe("Recognition stopped responding.");
  });

  // Must not leave the sender waiting on a channel nobody closes.
  it("wraps a synchronous throw", async () => {
    const getListener = installListenerCapture();
    onRequest(() => {
      throw new Error("Unsupported message.");
    });

    const envelope = (await respond(getListener(), { type: "ANY" })) as {
      ok: boolean;
      error: { message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.message).toBe("Unsupported message.");
  });

  it("answers even when the handler returns nothing", async () => {
    const getListener = installListenerCapture();
    onRequest(() => undefined);

    await expect(respond(getListener(), { type: "ANY" })).resolves.toEqual({
      ok: true,
      value: undefined,
    });
  });

  // Chrome closes the response channel unless the listener returns true.
  it("keeps the response channel open", () => {
    const getListener = installListenerCapture();
    onRequest(async () => "value");

    expect(getListener()?.({ type: "ANY" }, {}, () => {})).toBe(true);
  });
});

describe("sendRequest", () => {
  it("unwraps a successful envelope", async () => {
    vi.stubGlobal("browser", {
      runtime: {
        sendMessage: vi.fn(async () => ({ ok: true, value: ["uk", "en"] })),
      },
    });

    await expect(sendRequest({ type: "GET_TARGET_LANGUAGES" })).resolves.toEqual(
      ["uk", "en"],
    );
  });

  it("throws the handler's error, keeping its name", async () => {
    vi.stubGlobal("browser", {
      runtime: {
        sendMessage: vi.fn(async () => ({
          ok: false,
          error: { message: "Aborted", name: "AbortError" },
        })),
      },
    });

    await expect(
      sendRequest({ type: "GET_TARGET_LANGUAGES" }),
    ).rejects.toMatchObject({ message: "Aborted", name: "AbortError" });
  });

  // Not an error: the fire-and-forget messages expect no reply.
  it("resolves to undefined on an empty reply", async () => {
    vi.stubGlobal("browser", {
      runtime: { sendMessage: vi.fn(async () => undefined) },
    });

    await expect(sendRequest({ type: "OPEN_OPTIONS" })).resolves.toBeUndefined();
  });

  it("round-trips a request through onRequest", async () => {
    let listener: Listener | undefined;
    vi.stubGlobal("browser", {
      runtime: {
        onMessage: {
          addListener: vi.fn((next: Listener) => {
            listener = next;
          }),
        },
        sendMessage: (message: RuntimeMessage) => respond(listener, message),
      },
    });

    onRequest((message) => ({ echoed: (message as RuntimeMessage).type }));

    await expect(sendRequest({ type: "PRELOAD_OCR" })).resolves.toEqual({
      echoed: "PRELOAD_OCR",
    });
  });
});
