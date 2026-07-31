import { afterEach, describe, expect, it, vi } from "vitest";
import { startRouter, type RouterDependencies } from "./router";

type MessageListener = (
  message: unknown,
  sender: unknown,
) => Promise<unknown> | unknown;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("background router", () => {
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
      listener?.(
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
      settingsRepository: { get: async () => ({ ocr }) },
      createOcrProvider,
    } as unknown as RouterDependencies);
    await listener?.({ type: "PRELOAD_OCR" }, {});

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
    await listener?.({ type: "START_SELECTION" }, {
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

    await listener?.(
      {
        type: "OCR_TRANSLATE_REQUEST",
        requestId: "request-1",
        imageUrl: "https://example.com/sample.png",
      },
      { tab: { id: 7 }, frameId: 4 },
    );

    expect(loadImage).toHaveBeenCalledWith("https://example.com/sample.png");
    expect(captureVisibleArea).not.toHaveBeenCalled();
    expect(recognize).toHaveBeenCalledWith(
      { image, sourceLang: "auto" },
      undefined,
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
      listener?.({ type: "GET_CAPTURE_SNAPSHOT" }, {
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
    await listener?.(
      {
        type: "OCR_TRANSLATE_REQUEST",
        requestId: "snapshot-request",
        rect: { x: 0, y: 0, width: 10, height: 5 },
        viewport: { width: 100, height: 50 },
      },
      sender,
    );

    await expect(
      listener?.({ type: "GET_CAPTURE_SNAPSHOT" }, sender),
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
      listener?.(
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
    await listener?.(
      {
        type: "RERECOGNIZE_REQUEST",
        requestId: "frame-one-rerecognize",
        sourceLang: "ja",
      },
      { tab: { id: 11 }, frameId: 4 },
    );

    expect(recognize).toHaveBeenLastCalledWith(
      { image: frameOneImage, sourceLang: "ja" },
      undefined,
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

    await listener?.(
      {
        type: "RERECOGNIZE_REQUEST",
        requestId: "latest-rerecognize",
        sourceLang: "en",
      },
      { tab: { id: 11 }, frameId: 4 },
    );

    expect(recognize).toHaveBeenLastCalledWith(
      { image: fastImage, sourceLang: "en" },
      undefined,
      expect.any(Function),
    );
  });
});
