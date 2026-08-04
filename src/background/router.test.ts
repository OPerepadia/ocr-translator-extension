import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deserializeError } from "../shared/messages";
import type { SerializedError } from "../shared/types";
import { createMemoryCaptureStore, type CaptureStore } from "./capture-store";
import { startRouter, type RouterDependencies } from "./router";

type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

type ResponseEnvelope =
  | { ok: true; value: unknown }
  | { ok: false; error: SerializedError };

// Drives a listener the way the browser does, so assertions read against what
// a sender actually observes.
function invoke(
  listener: MessageListener | undefined,
  message: unknown,
  sender: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!listener) {
      reject(new Error("startRouter registered no message listener."));
      return;
    }
    listener(message, sender, (response) => {
      const envelope = response as ResponseEnvelope;
      if (envelope.ok) {
        resolve(envelope.value);
      } else {
        reject(deserializeError(envelope.error));
      }
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("background router", () => {
  let captureStore: CaptureStore;

  beforeEach(() => {
    captureStore = createMemoryCaptureStore();
  });

  it("routes speech requests to the TTS service", async () => {
    let listener: MessageListener | undefined;
    const getPlatformInfo = vi.fn(async () => ({}));
    vi.stubGlobal("browser", {
      runtime: {
        onMessage: {
          addListener: vi.fn((next: MessageListener) => {
            listener = next;
          }),
        },
        getPlatformInfo,
      },
    });
    const speakText = vi.fn(async () => ["AUDIO"]);

    startRouter({ speakText } as unknown as RouterDependencies);

    await expect(
      invoke(
        listener,
        { type: "SPEAK_REQUEST", text: "Hello", lang: "en" },
        {},
      ),
    ).resolves.toEqual({ audioChunks: ["AUDIO"] });
    expect(speakText).toHaveBeenCalledWith("Hello", "en");
    expect(getPlatformInfo).toHaveBeenCalledOnce();
  });

  // Preload must build the provider from the same settings a capture uses, so
  // createOcrProvider hands back the cached instance instead of a second one.
  it("preloads the OCR provider configured in settings", async () => {
    let listener: MessageListener | undefined;
    vi.stubGlobal("browser", {
      runtime: {
        onMessage: {
          addListener: vi.fn((next: MessageListener) => {
            listener = next;
          }),
        },
        getPlatformInfo: vi.fn(async () => ({})),
      },
    });
    const ocr = { providerId: "paddle", sourceLang: "auto" };
    const preload = vi.fn(async () => {});
    const createOcrProvider = vi.fn(() => ({ id: "paddle", preload }));

    startRouter({
      captureStore,
      settingsRepository: { get: async () => ({ ocr }) },
      createOcrProvider,
    } as unknown as RouterDependencies);
    await invoke(listener, { type: "PRELOAD_OCR" }, {});

    expect(createOcrProvider).toHaveBeenCalledWith(ocr);
    expect(preload).toHaveBeenCalledOnce();
  });

  it("relays iframe selection requests to the top frame", async () => {
    let listener: MessageListener | undefined;
    const sendMessage = vi.fn(async () => undefined);
    vi.stubGlobal("browser", {
      runtime: {
        onMessage: {
          addListener: vi.fn((next: MessageListener) => {
            listener = next;
          }),
        },
      },
      tabs: { sendMessage },
    });

    startRouter({} as RouterDependencies);
    await invoke(listener, { type: "START_SELECTION" }, {
      tab: { id: 7 },
      frameId: 4,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      7,
      { type: "START_SELECTION" },
      { frameId: 0 },
    );
  });

  it("loads a selected image instead of capturing the visible tab", async () => {
    let listener: MessageListener | undefined;
    const sendMessage = vi.fn(async () => undefined);
    vi.stubGlobal("browser", {
      runtime: {
        onMessage: {
          addListener: vi.fn((next: MessageListener) => {
            listener = next;
          }),
        },
        getPlatformInfo: vi.fn(async () => ({})),
      },
      tabs: {
        sendMessage,
      },
    });
    const image = new Blob(["image"]);
    const loadImage = vi.fn(async () => image);
    const captureVisibleArea = vi.fn();
    const recognize = vi.fn(async () => ({ text: "Hello", lang: "en" }));

    startRouter({
      captureStore,
      settingsRepository: {
        get: async () => ({
          ocr: { providerId: "test" },
          translation: { providerId: "test", targetLang: "uk" },
        }),
      },
      loadImage,
      captureVisibleArea,
      createOcrProvider: () => ({ id: "test", recognize }),
      createTranslationProvider: () => ({
        id: "test",
        translate: async (input: { targetLang: string }) => ({
          text: "Translated",
          targetLang: input.targetLang,
        }),
      }),
      detectLanguage: async () => undefined,
    } as unknown as RouterDependencies);

    const response = await invoke(
      listener,
      {
        type: "OCR_TRANSLATE_REQUEST",
        requestId: "request-1",
        imageUrl: "https://example.com/sample.png",
      },
      { tab: { id: 7 }, frameId: 4 },
    );

    expect(loadImage).toHaveBeenCalledWith("https://example.com/sample.png");
    expect(captureVisibleArea).not.toHaveBeenCalled();
    expect(response).toEqual(
      expect.objectContaining({ ocr: expect.any(Object) }),
    );
    await expect(captureStore.get("7:4")).resolves.toMatchObject({ image });
    expect(recognize).toHaveBeenCalledWith(
      { image, sourceLang: "auto" },
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "OCR_TRANSLATE_OCR_RESULT" }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: "OCR_TRANSLATE_STATUS" }),
    );
  });

  it("re-recognizes from the retained capture after a restart", async () => {
    let listener: MessageListener | undefined;
    vi.stubGlobal("browser", {
      runtime: {
        onMessage: {
          addListener: vi.fn((next: MessageListener) => {
            listener = next;
          }),
        },
        getPlatformInfo: vi.fn(async () => ({})),
      },
      tabs: { sendMessage: vi.fn(async () => undefined) },
    });
    const image = new Blob(["capture"]);
    const recognize = vi.fn(async () => ({ text: "Sample" }));
    const translate = vi.fn(async (input: { targetLang: string }) => ({
      text: "Translated",
      targetLang: input.targetLang,
    }));
    let settings = {
      ocr: { providerId: "test" },
      translation: { providerId: "test", targetLang: "uk" },
    };

    startRouter({
      captureStore,
      settingsRepository: {
        get: async () => settings,
        set: async (next: typeof settings) => {
          settings = next;
        },
      },
      createOcrProvider: () => ({ id: "test", recognize }),
      createTranslationProvider: () => ({
        id: "test",
        translate,
      }),
      detectLanguage: async () => undefined,
    } as unknown as RouterDependencies);

    const sender = { tab: { id: 31 }, frameId: 0 };
    await captureStore.update("31:0", () => ({
      requestId: "capture-before-restart",
      image,
      sourceLanguage: "auto",
    }));

    const response = await invoke(
      listener,
      {
        type: "RERECOGNIZE_REQUEST",
        requestId: "rerecognize-after-restart",
        sourceLang: "ja",
      },
      sender,
    );

    expect(recognize).toHaveBeenCalledWith(
      { image, sourceLang: "ja" },
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(response).toEqual({
      ocr: { text: "Sample", lang: "ja" },
      translation: { text: "Translated", targetLang: "uk" },
      translationStatus: { state: "ok" },
    });

    await invoke(
      listener,
      {
        type: "RETRANSLATE_REQUEST",
        requestId: "retranslate-after-restart",
        text: "Sample",
        targetLang: "fr",
      },
      sender,
    );
    expect(translate).toHaveBeenLastCalledWith(
      { text: "Sample", sourceLang: "ja", targetLang: "fr" },
      expect.any(AbortSignal),
    );

    await invoke(
      listener,
      {
        type: "SWITCH_PROVIDER_REQUEST",
        requestId: "switch-provider-after-restart",
        providerId: "alternate",
        text: "Sample",
      },
      sender,
    );
    expect(translate).toHaveBeenLastCalledWith(
      { text: "Sample", sourceLang: "ja", targetLang: "fr" },
      expect.any(AbortSignal),
    );
  });

  // Nothing else holds the pixels now that the content script does not.
  it("refuses to re-recognize once the capture is gone", async () => {
    let listener: MessageListener | undefined;
    vi.stubGlobal("browser", {
      runtime: {
        onMessage: {
          addListener: vi.fn((next: MessageListener) => {
            listener = next;
          }),
        },
        getPlatformInfo: vi.fn(async () => ({})),
      },
      tabs: { sendMessage: vi.fn(async () => undefined) },
    });
    const recognize = vi.fn();

    startRouter({
      captureStore,
      settingsRepository: {
        get: async () => ({
          ocr: { providerId: "test" },
          translation: { providerId: "test", targetLang: "uk" },
        }),
      },
      createOcrProvider: () => ({ id: "test", recognize }),
      createTranslationProvider: () => ({ id: "test", translate: vi.fn() }),
      detectLanguage: async () => undefined,
    } as unknown as RouterDependencies);

    await expect(
      invoke(
        listener,
        {
          type: "RERECOGNIZE_REQUEST",
          requestId: "rerecognize-without-capture",
          sourceLang: "ja",
        },
        { tab: { id: 44 }, frameId: 0 },
      ),
    ).rejects.toThrow(/no longer available/);
    expect(recognize).not.toHaveBeenCalled();
  });

  it("reports no snapshot when the frame has no retained capture", async () => {
    let listener: MessageListener | undefined;
    vi.stubGlobal("browser", {
      runtime: {
        onMessage: {
          addListener: vi.fn((next: MessageListener) => {
            listener = next;
          }),
        },
        getPlatformInfo: vi.fn(async () => ({})),
      },
    });

    startRouter({} as RouterDependencies);

    await expect(
      invoke(listener, { type: "GET_CAPTURE_SNAPSHOT" }, {
        tab: { id: 21 },
        frameId: 0,
      }),
    ).resolves.toEqual({});
  });

  // The snapshot is only ever displayed, at the region's CSS size, so it is
  // encoded at that size rather than at the capture's own device resolution.
  it("encodes the capture at the region's displayed size", async () => {
    let listener: MessageListener | undefined;
    vi.stubGlobal("browser", {
      runtime: {
        onMessage: {
          addListener: vi.fn((next: MessageListener) => {
            listener = next;
          }),
        },
        getPlatformInfo: vi.fn(async () => ({})),
      },
      tabs: { sendMessage: vi.fn(async () => undefined) },
    });
    const convertToBlob = vi.fn(
      async () => new Blob([new Uint8Array([7])], { type: "image/webp" }),
    );
    const canvasSizes: Array<{ width: number; height: number }> = [];
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 40, height: 20, close: vi.fn() })),
    );
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(width: number, height: number) {
          canvasSizes.push({ width, height });
        }

        getContext(): { drawImage: () => void } {
          return { drawImage: () => {} };
        }

        convertToBlob = convertToBlob;
      },
    );

    startRouter({
      captureStore,
      captureVisibleArea: async () => new Blob(["capture"]),
      settingsRepository: {
        get: async () => ({
          ocr: { providerId: "test" },
          translation: { providerId: "test", targetLang: "uk" },
        }),
      },
      loadImage: async () => new Blob(["image"]),
      createOcrProvider: () => ({
        id: "test",
        recognize: async () => ({ text: "Sample", lang: "en" }),
      }),
      createTranslationProvider: () => ({
        id: "test",
        translate: async (input: { targetLang: string }) => ({
          text: "Translated",
          targetLang: input.targetLang,
        }),
      }),
      detectLanguage: async () => undefined,
    } as unknown as RouterDependencies);

    const sender = { tab: { id: 22 }, frameId: 0 };
    await invoke(
      listener,
      {
        type: "OCR_TRANSLATE_REQUEST",
        requestId: "snapshot-request",
        rect: { x: 0, y: 0, width: 10, height: 5 },
        viewport: { width: 100, height: 50 },
      },
      sender,
    );

    await expect(
      invoke(listener, { type: "GET_CAPTURE_SNAPSHOT" }, sender),
    ).resolves.toEqual({
      snapshot: { data: "Bw==", mediaType: "image/webp" },
    });
    // A 40x20 capture of a 10x5 region is four times its displayed size; twice
    // is all the overlay can paint.
    expect(canvasSizes).toEqual([{ width: 20, height: 10 }]);
  });

  it("keeps capture state isolated by frame and ignores stale image loads", async () => {
    let listener: MessageListener | undefined;
    vi.stubGlobal("browser", {
      runtime: {
        onMessage: {
          addListener: vi.fn((next: MessageListener) => {
            listener = next;
          }),
        },
        getPlatformInfo: vi.fn(async () => ({})),
      },
      tabs: {
        sendMessage: vi.fn(async () => undefined),
      },
    });

    const frameOneImage = new Blob(["frame-one"]);
    const frameTwoImage = new Blob(["frame-two"]);
    const slowImage = new Blob(["slow"]);
    const fastImage = new Blob(["fast"]);
    let resolveSlowImage!: (image: Blob) => void;
    const slowImageLoad = new Promise<Blob>((resolve) => {
      resolveSlowImage = resolve;
    });
    const loadImage = vi.fn((url: string) => {
      if (url.endsWith("/frame-one.png")) {
        return Promise.resolve(frameOneImage);
      }
      if (url.endsWith("/frame-two.png")) {
        return Promise.resolve(frameTwoImage);
      }
      if (url.endsWith("/slow.png")) {
        return slowImageLoad;
      }
      return Promise.resolve(fastImage);
    });
    const recognize = vi.fn(async () => ({ text: "Sample", lang: "en" }));
    const settings = {
      ocr: { providerId: "test" },
      translation: { providerId: "test", targetLang: "uk" },
    };

    startRouter({
      captureStore,
      settingsRepository: {
        get: async () => settings,
      },
      loadImage,
      createOcrProvider: () => ({ id: "test", recognize }),
      createTranslationProvider: () => ({
        id: "test",
        translate: async (input: { targetLang: string }) => ({
          text: "Translated",
          targetLang: input.targetLang,
        }),
      }),
      detectLanguage: async () => undefined,
    } as unknown as RouterDependencies);

    const capture = (requestId: string, imageUrl: string, frameId: number) =>
      invoke(
        listener,
        { type: "OCR_TRANSLATE_REQUEST", requestId, imageUrl },
        { tab: { id: 11 }, frameId },
      );

    await capture(
      "frame-one-request",
      "https://example.com/frame-one.png",
      4,
    );
    await capture(
      "frame-two-request",
      "https://example.com/frame-two.png",
      5,
    );
    await invoke(
      listener,
      {
        type: "RERECOGNIZE_REQUEST",
        requestId: "frame-one-rerecognize",
        sourceLang: "ja",
      },
      { tab: { id: 11 }, frameId: 4 },
    );

    expect(recognize).toHaveBeenLastCalledWith(
      { image: frameOneImage, sourceLang: "ja" },
      expect.any(AbortSignal),
      expect.any(Function),
    );

    const slowRequest = capture(
      "slow-request",
      "https://example.com/slow.png",
      4,
    );
    await vi.waitFor(() =>
      expect(loadImage).toHaveBeenCalledWith("https://example.com/slow.png"),
    );
    await capture("fast-request", "https://example.com/fast.png", 4);
    resolveSlowImage(slowImage);
    await slowRequest;

    await invoke(
      listener,
      {
        type: "RERECOGNIZE_REQUEST",
        requestId: "latest-rerecognize",
        sourceLang: "en",
      },
      { tab: { id: 11 }, frameId: 4 },
    );

    expect(recognize).toHaveBeenLastCalledWith(
      { image: fastImage, sourceLang: "en" },
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });

  // A closed panel (or a superseding capture) must free the OCR worker instead
  // of letting the abandoned recognition run to completion.
  it("aborts an in-flight pipeline when the content script cancels it", async () => {
    let listener: MessageListener | undefined;
    vi.stubGlobal("browser", {
      runtime: {
        onMessage: {
          addListener: vi.fn((next: MessageListener) => {
            listener = next;
          }),
        },
        getPlatformInfo: vi.fn(async () => ({})),
      },
      tabs: { sendMessage: vi.fn(async () => undefined) },
    });

    let recognizeSignal: AbortSignal | undefined;
    const recognize = vi.fn(
      (_input: unknown, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          recognizeSignal = signal;
          signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const translate = vi.fn();

    startRouter({
      captureStore,
      settingsRepository: {
        get: async () => ({
          ocr: { providerId: "test" },
          translation: { providerId: "test", targetLang: "uk" },
        }),
      },
      loadImage: async () => new Blob(["image"]),
      createOcrProvider: () => ({ id: "test", recognize }),
      createTranslationProvider: () => ({ id: "test", translate }),
      detectLanguage: async () => undefined,
    } as unknown as RouterDependencies);

    // Keep the rejection handled from the start; the cancel below arrives while
    // this request is still open.
    const settled = invoke(
      listener,
      {
        type: "OCR_TRANSLATE_REQUEST",
        requestId: "cancel-me",
        imageUrl: "https://example.com/sample.png",
      },
      { tab: { id: 7 }, frameId: 4 },
    ).catch((error: unknown) => error);

    await vi.waitFor(() => expect(recognize).toHaveBeenCalled());
    await invoke(
      listener,
      { type: "CANCEL_REQUEST", requestId: "cancel-me" },
      { tab: { id: 7 }, frameId: 4 },
    );

    expect(recognizeSignal?.aborted).toBe(true);
    expect((await settled) as Error).toHaveProperty("name", "AbortError");
    expect(translate).not.toHaveBeenCalled();
  });

  it("cancels only the named request", async () => {
    let listener: MessageListener | undefined;
    vi.stubGlobal("browser", {
      runtime: {
        onMessage: {
          addListener: vi.fn((next: MessageListener) => {
            listener = next;
          }),
        },
        getPlatformInfo: vi.fn(async () => ({})),
      },
      tabs: { sendMessage: vi.fn(async () => undefined) },
    });

    const signals: AbortSignal[] = [];
    const recognize = vi.fn(
      (_input: unknown, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signals.push(signal);
          signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );

    startRouter({
      captureStore,
      settingsRepository: {
        get: async () => ({
          ocr: { providerId: "test" },
          translation: { providerId: "test", targetLang: "uk" },
        }),
      },
      loadImage: async () => new Blob(["image"]),
      createOcrProvider: () => ({ id: "test", recognize }),
      createTranslationProvider: () => ({ id: "test", translate: vi.fn() }),
      detectLanguage: async () => undefined,
    } as unknown as RouterDependencies);

    const capture = (requestId: string, frameId: number) =>
      invoke(
        listener,
        {
          type: "OCR_TRANSLATE_REQUEST",
          requestId,
          imageUrl: "https://example.com/sample.png",
        },
        { tab: { id: 7 }, frameId },
      ).catch((error: unknown) => error);

    const first = capture("first", 4);
    const second = capture("second", 5);
    try {
      await vi.waitFor(() => expect(signals).toHaveLength(2));

      await invoke(listener, { type: "CANCEL_REQUEST", requestId: "first" }, {});

      expect((await first) as Error).toHaveProperty("name", "AbortError");
      expect(signals[1].aborted).toBe(false);
    } finally {
      await invoke(listener, { type: "CANCEL_REQUEST", requestId: "first" }, {});
      await invoke(listener, { type: "CANCEL_REQUEST", requestId: "second" }, {});
      await Promise.all([first, second]);
    }
  });
});
