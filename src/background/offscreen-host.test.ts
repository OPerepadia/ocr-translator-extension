import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerResponse } from "../providers/ocr/paddle/protocol";
import { decodeRequest, type RelayedRequest } from "../shared/offscreen-relay";
import { canHostWorker, createOffscreenWorker } from "./offscreen-host";

class FakePort {
  name: string;
  sent: RelayedRequest[] = [];
  disconnected = false;
  private messageListeners: Array<(message: unknown) => void> = [];
  private disconnectListeners: Array<() => void> = [];

  constructor(name: string) {
    this.name = name;
  }

  postMessage(message: unknown): void {
    this.sent.push(message as RelayedRequest);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  onMessage = {
    addListener: (listener: (message: unknown) => void) => {
      this.messageListeners.push(listener);
    },
  };

  onDisconnect = {
    addListener: (listener: () => void) => {
      this.disconnectListeners.push(listener);
    },
  };

  /** Drive a reply from the offscreen document. */
  reply(response: WorkerResponse): void {
    for (const listener of this.messageListeners) {
      listener(response);
    }
  }

  drop(): void {
    for (const listener of this.disconnectListeners) {
      listener();
    }
  }
}

interface CreateDocumentParameters {
  url: string;
  reasons: string[];
  justification: string;
}

function installChrome(
  options: {
    createDocument?: (parameters: CreateDocumentParameters) => Promise<void>;
    /** Chrome below 116 has no hasDocument. */
    withHasDocument?: boolean;
  } = {},
) {
  const ports: FakePort[] = [];
  const createDocument = vi.fn<
    (parameters: CreateDocumentParameters) => Promise<void>
  >(options.createDocument ?? (async () => {}));
  const hasDocument = vi.fn(async () => createDocument.mock.calls.length > 0);

  vi.stubGlobal("browser", {
    runtime: {
      connect: vi.fn((info: { name: string }) => {
        const port = new FakePort(info.name);
        ports.push(port);
        return port;
      }),
    },
    offscreen: {
      createDocument,
      closeDocument: vi.fn(),
      ...(options.withHasDocument === false ? {} : { hasDocument }),
    },
  });

  return { ports, createDocument, hasDocument };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("canHostWorker", () => {
  it("is true where Worker exists", () => {
    vi.stubGlobal("Worker", class {});
    expect(canHostWorker()).toBe(true);
  });

  it("is false in a context without Worker, as in a Chrome service worker", () => {
    vi.stubGlobal("Worker", undefined);
    expect(canHostWorker()).toBe(false);
  });
});

describe("createOffscreenWorker", () => {
  it("opens the document once and relays init over the port", async () => {
    const { ports, createDocument } = installChrome();
    const relay = createOffscreenWorker();

    relay.postMessage({ type: "cancel", id: 1 });
    await settle();

    expect(createDocument).toHaveBeenCalledOnce();
    expect(createDocument.mock.calls[0][0]).toMatchObject({
      url: "offscreen.html",
      reasons: ["WORKERS"],
    });
    expect(ports).toHaveLength(1);
    expect(ports[0].sent).toEqual([{ type: "cancel", id: 1 }]);
  });

  it("encodes the capture so it survives the port", async () => {
    const { ports } = installChrome();
    const relay = createOffscreenWorker();

    relay.postMessage({
      type: "recognize",
      id: 2,
      image: new Blob(["pixels"], { type: "image/png" }),
      sourceLang: "ja",
    });
    await settle();

    const sent = ports[0].sent[0];
    expect(JSON.parse(JSON.stringify(sent))).toEqual(sent);
    const decoded = decodeRequest(sent) as { image: Blob };
    expect(await decoded.image.text()).toBe("pixels");
  });

  // The worker needs init before the recognitions, and encoding a capture takes
  // longer than encoding anything else, so sends cannot race.
  it("keeps sends in the order they were posted", async () => {
    const { ports } = installChrome();
    const relay = createOffscreenWorker();

    relay.postMessage({
      type: "init",
      id: 1,
      model: { id: "m", modelBaseUrl: "u", script: "general" },
      wasmBaseUrl: "w",
      backend: "wasm",
      debug: false,
    });
    relay.postMessage({
      type: "recognize",
      id: 2,
      image: new Blob(["pixels"]),
    });
    relay.postMessage({ type: "cancel", id: 2 });
    await settle();

    expect(ports[0].sent.map((message) => message.type)).toEqual([
      "init",
      "recognize",
      "cancel",
    ]);
  });

  it("hands worker responses back to the provider", async () => {
    const { ports } = installChrome();
    const relay = createOffscreenWorker();
    const seen: WorkerResponse[] = [];
    relay.onmessage = (event) => seen.push(event.data);

    relay.postMessage({ type: "cancel", id: 1 });
    await settle();
    ports[0].reply({ type: "ready", id: 1 });

    expect(seen).toEqual([{ type: "ready", id: 1 }]);
  });

  it("reports a document that cannot be opened", async () => {
    installChrome({
      createDocument: async () => {
        throw new Error("Extension context invalidated.");
      },
    });
    const relay = createOffscreenWorker();
    const errors: string[] = [];
    relay.onerror = (event) => errors.push(event.message ?? "");

    relay.postMessage({ type: "cancel", id: 1 });
    await settle();

    expect(errors).toEqual(["Extension context invalidated."]);
  });

  // Chrome below 116 has no hasDocument, so a document opened earlier is only
  // discoverable by being refused a second one.
  it("carries on when told a document already exists", async () => {
    const { ports } = installChrome({
      withHasDocument: false,
      createDocument: async () => {
        throw new Error("Only a single offscreen document may be created.");
      },
    });
    const relay = createOffscreenWorker();
    const errors: string[] = [];
    relay.onerror = (event) => errors.push(event.message ?? "");

    relay.postMessage({ type: "cancel", id: 1 });
    await settle();

    expect(errors).toEqual([]);
    expect(ports[0].sent).toEqual([{ type: "cancel", id: 1 }]);
  });

  it("reports the host going away", async () => {
    const { ports } = installChrome();
    const relay = createOffscreenWorker();
    const errors: string[] = [];
    relay.onerror = (event) => errors.push(event.message ?? "");

    relay.postMessage({ type: "cancel", id: 1 });
    await settle();
    ports[0].drop();

    expect(errors).toEqual(["The OCR host stopped responding."]);
  });

  it("goes quiet after terminate", async () => {
    const { ports } = installChrome();
    const relay = createOffscreenWorker();
    const seen: WorkerResponse[] = [];
    const errors: string[] = [];
    relay.onmessage = (event) => seen.push(event.data);
    relay.onerror = (event) => errors.push(event.message ?? "");

    relay.postMessage({ type: "cancel", id: 1 });
    await settle();
    relay.terminate();
    ports[0].reply({ type: "ready", id: 1 });
    ports[0].drop();
    relay.postMessage({ type: "cancel", id: 2 });
    await settle();

    expect(ports[0].disconnected).toBe(true);
    expect(seen).toEqual([]);
    expect(errors).toEqual([]);
    expect(ports[0].sent).toHaveLength(1);
  });

  it("reuses a document another provider already opened", async () => {
    const { createDocument } = installChrome();

    const first = createOffscreenWorker();
    first.postMessage({ type: "cancel", id: 1 });
    await settle();

    const second = createOffscreenWorker();
    second.postMessage({ type: "cancel", id: 2 });
    await settle();

    expect(createDocument).toHaveBeenCalledOnce();
  });
});
