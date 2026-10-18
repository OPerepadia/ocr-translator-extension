import { describe, expect, it, vi } from "vitest";
import type { OcrProvider } from "../providers/ocr/types";
import type { TranslationProvider } from "../providers/translation/types";
import type { RuntimeMessage } from "../shared/messages";
import { defaultSettings } from "../shared/storage";
import type { OcrBlock, Settings } from "../shared/types";
import type { LiveFrame } from "./capture";
import { createFrameSignature } from "../shared/frame-signature";
import {
  handleLiveFrameRequest,
  handleLiveImageRequest,
  handleLiveTranslateRequest,
  type LiveDependencies,
  type LiveSessions,
} from "./live";

type FrameMessage = Extract<RuntimeMessage, { type: "LIVE_FRAME_REQUEST" }>;
type ImageMessage = Extract<RuntimeMessage, { type: "LIVE_IMAGE_REQUEST" }>;

function frameOf(brightness: number, pixelRatio = 1): LiveFrame {
  const width = 40;
  const height = 10;
  const data = new Uint8ClampedArray(width * height * 4).fill(brightness);
  return {
    pixelRatio,
    signature: createFrameSignature({ width, height, data }),
    toBlob: vi.fn(async () => new Blob([`frame-${brightness}`])),
  };
}

/** A line of text whose box is `thickness` thick. */
function lineOf(text: string, thickness: number): OcrBlock {
  const rect = { x: 0, y: 0, width: 200, height: thickness };
  return { text, bbox: rect, oriented: { rect, angle: 0 } };
}

function frameMessage(overrides: Partial<FrameMessage> = {}): FrameMessage {
  return {
    type: "LIVE_FRAME_REQUEST",
    requestId: "request-1",
    sessionId: "session-1",
    rect: { x: 10, y: 20, width: 400, height: 60 },
    viewport: { width: 1280, height: 720 },
    ...overrides,
  };
}

function imageMessage(overrides: Partial<ImageMessage> = {}): ImageMessage {
  return {
    type: "LIVE_IMAGE_REQUEST",
    requestId: "request-1",
    sessionId: "session-1",
    image: { data: btoa("frame"), mediaType: "image/png" },
    ...overrides,
  };
}

const visibleTab = { id: 4, active: true, windowId: 7 };

function setup(options: {
  frames?: LiveFrame[];
  texts?: string[];
  /** The lines each read finds, in the order of the reads. */
  blocks?: OcrBlock[][];
  settings?: Settings;
}) {
  const frames = [...(options.frames ?? [frameOf(10)])];
  const texts = [...(options.texts ?? ["Hello there"])];
  const blocks = [...(options.blocks ?? [])];
  const settings = options.settings ?? defaultSettings;
  const recognize = vi.fn<OcrProvider["recognize"]>(async () => ({
    text: texts.shift() ?? "",
    blocks: blocks.shift(),
  }));
  const translate = vi.fn<TranslationProvider["translate"]>(
    async ({ text, targetLang }) => ({ text: `[${targetLang}] ${text}`, targetLang }),
  );
  const set = vi.fn(async () => undefined);
  const dependencies: LiveDependencies = {
    settingsRepository: { get: async () => settings, set },
    captureLiveFrame: vi.fn(async () => frames.shift() ?? frameOf(10)),
    createOcrProvider: () => ({ id: "fake", recognize }),
    createTranslationProvider: () => ({ id: "fake", translate }),
    detectLanguage: vi.fn(async () => undefined),
  };
  const sessions: LiveSessions = new Map();
  return { dependencies, recognize, translate, set, sessions };
}

const signal = () => new AbortController().signal;

describe("handleLiveFrameRequest", () => {
  it("reuses the first detected model through changed and empty frames", async () => {
    const { dependencies, recognize, sessions } = setup({
      frames: [frameOf(10), frameOf(200), frameOf(10), frameOf(200)],
    });
    recognize
      .mockResolvedValueOnce({ text: "", providerMeta: { modelId: "v6-multi" } })
      .mockResolvedValueOnce({ text: "Hello", providerMeta: { modelId: "v6-cyrillic" } })
      .mockResolvedValueOnce({ text: "", providerMeta: { modelId: "v6-multi" } });

    for (let read = 0; read < 4; read += 1) {
      await handleLiveFrameRequest(dependencies, sessions, frameMessage(), visibleTab, signal());
    }

    expect(recognize.mock.calls.map(([input]) => input.modelId)).toEqual([
      undefined, undefined, "v6-cyrillic", "v6-cyrillic",
    ]);
  });

  it("detects the model again after the OCR provider changes", async () => {
    const { dependencies, recognize, sessions } = setup({
      frames: [frameOf(10), frameOf(200), frameOf(10)],
    });
    let settings: Settings = defaultSettings;
    dependencies.settingsRepository.get = async () => settings;
    recognize
      .mockResolvedValueOnce({ text: "Hello", providerMeta: { modelId: "v6-multi" } })
      .mockResolvedValueOnce({ text: "Hello", providerMeta: { modelId: "v6-manga" } })
      .mockResolvedValueOnce({ text: "Hello", providerMeta: { modelId: "v6-manga" } });

    await handleLiveFrameRequest(dependencies, sessions, frameMessage(), visibleTab, signal());
    settings = {
      ...defaultSettings,
      ocr: { ...defaultSettings.ocr, providerId: "paddle-manga" },
    };
    await handleLiveFrameRequest(dependencies, sessions, frameMessage(), visibleTab, signal());
    await handleLiveFrameRequest(dependencies, sessions, frameMessage(), visibleTab, signal());

    expect(recognize.mock.calls.map(([input]) => input.modelId)).toEqual([
      undefined, undefined, "v6-manga",
    ]);
  });

  it("detects the model independently for new and restarted sessions", async () => {
    const { dependencies, recognize, sessions } = setup({
      frames: [frameOf(10), frameOf(10), frameOf(10)],
    });
    recognize.mockResolvedValue({ text: "Hello", providerMeta: { modelId: "v6-cyrillic" } });

    await handleLiveFrameRequest(dependencies, sessions, frameMessage(), visibleTab, signal());
    await handleLiveFrameRequest(dependencies, sessions, frameMessage({ sessionId: "other" }), visibleTab, signal());
    sessions.delete("session-1");
    await handleLiveFrameRequest(dependencies, sessions, frameMessage(), visibleTab, signal());

    expect(recognize.mock.calls.map(([input]) => input.modelId)).toEqual([
      undefined, undefined, undefined,
    ]);
  });

  it("does not pin a model for an explicit source language", async () => {
    const { dependencies, recognize, sessions } = setup({
      frames: [frameOf(10), frameOf(200)],
      settings: {
        ...defaultSettings,
        ocr: { ...defaultSettings.ocr, sourceLang: "ja" },
      },
    });
    recognize.mockResolvedValue({ text: "Hello", providerMeta: { modelId: "v6-multi" } });

    await handleLiveFrameRequest(dependencies, sessions, frameMessage(), visibleTab, signal());
    await handleLiveFrameRequest(dependencies, sessions, frameMessage(), visibleTab, signal());

    expect(recognize.mock.calls.map(([input]) => input.modelId)).toEqual([undefined, undefined]);
  });

  it("reads the text in the region as a single block", async () => {
    const { dependencies, recognize, sessions } = setup({});

    const response = await handleLiveFrameRequest(
      dependencies,
      sessions,
      frameMessage(),
      visibleTab,
      signal(),
    );

    expect(response).toEqual({ status: "ok", text: "Hello there", unchanged: false });
    expect(recognize).toHaveBeenCalledWith(
      expect.objectContaining({ sourceLang: "auto", grouping: "single" }),
      expect.anything(),
    );
  });

  it("reads lines down to the floor until the session asks for more", async () => {
    const { dependencies, recognize, sessions } = setup({});

    await handleLiveFrameRequest(dependencies, sessions, frameMessage(), visibleTab, signal());

    expect(recognize).toHaveBeenCalledWith(
      expect.objectContaining({ minLineThickness: 18 }),
      expect.anything(),
    );
  });

  it("skips lines thinner than the session asked for", async () => {
    const { dependencies, recognize, sessions } = setup({});

    await handleLiveFrameRequest(
      dependencies,
      sessions,
      frameMessage({ minLineThickness: 0.5 }),
      visibleTab,
      signal(),
    );

    expect(recognize).toHaveBeenCalledWith(
      expect.objectContaining({ minLineThickness: 30 }),
      expect.anything(),
    );
  });

  it("measures lines against the region, as it grows with the video", async () => {
    const { dependencies, recognize, sessions } = setup({
      frames: [frameOf(10), frameOf(200)],
    });

    for (const height of [60, 120]) {
      await handleLiveFrameRequest(
        dependencies,
        sessions,
        frameMessage({
          rect: { x: 10, y: 20, width: 400, height },
          minLineThickness: 0.5,
        }),
        visibleTab,
        signal(),
      );
    }

    expect(recognize.mock.calls.map(([input]) => input.minLineThickness)).toEqual([
      30, 60,
    ]);
  });

  it("never reads below the floor, whatever the session asks", async () => {
    const { dependencies, recognize, sessions } = setup({});

    await handleLiveFrameRequest(
      dependencies,
      sessions,
      frameMessage({ minLineThickness: 0.1 }),
      visibleTab,
      signal(),
    );

    expect(recognize).toHaveBeenCalledWith(
      expect.objectContaining({ minLineThickness: 18 }),
      expect.anything(),
    );
  });

  it("measures thickness in screen pixels on a high-density display", async () => {
    const { dependencies, recognize, sessions } = setup({
      frames: [frameOf(10, 2), frameOf(200, 2)],
    });

    await handleLiveFrameRequest(dependencies, sessions, frameMessage(), visibleTab, signal());
    await handleLiveFrameRequest(
      dependencies,
      sessions,
      frameMessage({ minLineThickness: 0.5 }),
      visibleTab,
      signal(),
    );

    expect(recognize.mock.calls.map(([input]) => input.minLineThickness)).toEqual([
      36, 60,
    ]);
  });

  it("reports the thickest line it read, as a share of the region's height", async () => {
    const { dependencies, sessions } = setup({
      frames: [frameOf(10, 2)],
      texts: ["Good morning. Goodbye."],
      blocks: [[lineOf("Good morning.", 48), lineOf("Goodbye.", 30)]],
    });

    const response = await handleLiveFrameRequest(
      dependencies,
      sessions,
      frameMessage(),
      visibleTab,
      signal(),
    );

    expect(response).toEqual({
      status: "ok",
      text: "Good morning. Goodbye.",
      unchanged: false,
      lineThickness: 0.4,
    });
  });

  it("reports no thickness when no line was read", async () => {
    const { dependencies, sessions } = setup({ texts: [""], blocks: [[]] });

    const response = await handleLiveFrameRequest(
      dependencies,
      sessions,
      frameMessage(),
      visibleTab,
      signal(),
    );

    expect(response).toEqual({ status: "ok", text: "", unchanged: false });
  });

  it("captures the sender's window with the mask it was given", async () => {
    const { dependencies, sessions } = setup({});
    const mask = { x: 0, y: 100, width: 300, height: 80 };

    await handleLiveFrameRequest(
      dependencies,
      sessions,
      frameMessage({ mask }),
      visibleTab,
      signal(),
    );

    expect(dependencies.captureLiveFrame).toHaveBeenCalledWith({
      rect: { x: 10, y: 20, width: 400, height: 60 },
      viewport: { width: 1280, height: 720 },
      mask,
      tabId: 4,
      windowId: 7,
    });
  });

  it("does not recognize a frame discarded after a tab switch", async () => {
    const { dependencies, recognize, sessions } = setup({});
    vi.mocked(dependencies.captureLiveFrame).mockResolvedValueOnce(undefined);

    const response = await handleLiveFrameRequest(
      dependencies,
      sessions,
      frameMessage(),
      visibleTab,
      signal(),
    );

    expect(response).toEqual({ status: "hidden" });
    expect(recognize).not.toHaveBeenCalled();
  });

  it("does not capture while the tab is in the background", async () => {
    const { dependencies, recognize, sessions } = setup({});

    const response = await handleLiveFrameRequest(
      dependencies,
      sessions,
      frameMessage(),
      { active: false, windowId: 7 },
      signal(),
    );

    expect(response).toEqual({ status: "hidden" });
    expect(dependencies.captureLiveFrame).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();
  });

  it("does not capture for a sender that is not a tab", async () => {
    const { dependencies, sessions } = setup({});

    const response = await handleLiveFrameRequest(
      dependencies,
      sessions,
      frameMessage(),
      undefined,
      signal(),
    );

    expect(response).toEqual({ status: "hidden" });
    expect(dependencies.captureLiveFrame).not.toHaveBeenCalled();
  });

  it("repeats the last text without recognizing an unchanged region", async () => {
    const { dependencies, recognize, sessions } = setup({
      frames: [frameOf(10), frameOf(10)],
    });

    await handleLiveFrameRequest(dependencies, sessions, frameMessage(), visibleTab, signal());
    const second = await handleLiveFrameRequest(
      dependencies,
      sessions,
      frameMessage(),
      visibleTab,
      signal(),
    );

    expect(second).toEqual({ status: "ok", text: "Hello there", unchanged: true });
    expect(recognize).toHaveBeenCalledOnce();
  });

  it("recognizes an unchanged region again when the session asks for thicker lines", async () => {
    const { dependencies, recognize, sessions } = setup({
      frames: [frameOf(10), frameOf(10)],
      texts: ["Hello there Logo", "Hello there"],
    });

    await handleLiveFrameRequest(dependencies, sessions, frameMessage(), visibleTab, signal());
    const second = await handleLiveFrameRequest(
      dependencies,
      sessions,
      frameMessage({ minLineThickness: 0.5 }),
      visibleTab,
      signal(),
    );

    expect(second).toEqual({ status: "ok", text: "Hello there", unchanged: false });
    expect(recognize).toHaveBeenCalledTimes(2);
  });

  it("recognizes again when the region changed", async () => {
    const { dependencies, recognize, sessions } = setup({
      frames: [frameOf(10), frameOf(200)],
      texts: ["First line", "Second line"],
    });

    await handleLiveFrameRequest(dependencies, sessions, frameMessage(), visibleTab, signal());
    const second = await handleLiveFrameRequest(
      dependencies,
      sessions,
      frameMessage(),
      visibleTab,
      signal(),
    );

    expect(second).toEqual({ status: "ok", text: "Second line", unchanged: false });
    expect(recognize).toHaveBeenCalledTimes(2);
  });

  it("keeps the last read frame as the reference while the region drifts", async () => {
    const { dependencies, recognize, sessions } = setup({
      frames: [frameOf(10), frameOf(20), frameOf(30)],
      texts: ["First line", "Second line"],
    });

    const responses = [];
    for (let read = 0; read < 3; read += 1) {
      responses.push(
        await handleLiveFrameRequest(
          dependencies,
          sessions,
          frameMessage(),
          visibleTab,
          signal(),
        ),
      );
    }

    // 20 is within tolerance of 10, but 30 is not, so the drift is caught.
    expect(responses.map((response) => response.status === "ok" && response.unchanged))
      .toEqual([false, true, false]);
    expect(recognize).toHaveBeenCalledTimes(2);
  });

  it("keeps sessions apart", async () => {
    const { dependencies, recognize, sessions } = setup({
      frames: [frameOf(10), frameOf(10)],
      texts: ["One", "Two"],
    });

    await handleLiveFrameRequest(dependencies, sessions, frameMessage({ sessionId: "a" }), visibleTab, signal());
    const other = await handleLiveFrameRequest(
      dependencies,
      sessions,
      frameMessage({ sessionId: "b" }),
      visibleTab,
      signal(),
    );

    expect(other).toEqual({ status: "ok", text: "Two", unchanged: false });
    expect(recognize).toHaveBeenCalledTimes(2);
  });

  it("recognizes again after a failed read", async () => {
    const { dependencies, recognize, sessions } = setup({
      frames: [frameOf(10), frameOf(10)],
    });
    recognize.mockRejectedValueOnce(new Error("worker crashed"));

    await expect(
      handleLiveFrameRequest(dependencies, sessions, frameMessage(), visibleTab, signal()),
    ).rejects.toThrow("worker crashed");
    const retry = await handleLiveFrameRequest(
      dependencies,
      sessions,
      frameMessage(),
      visibleTab,
      signal(),
    );

    expect(retry).toEqual({ status: "ok", text: "Hello there", unchanged: false });
  });

  it("recognizes again once the session has ended", async () => {
    const { dependencies, recognize, sessions } = setup({
      frames: [frameOf(10), frameOf(10)],
    });

    await handleLiveFrameRequest(dependencies, sessions, frameMessage(), visibleTab, signal());
    sessions.delete("session-1");
    await handleLiveFrameRequest(dependencies, sessions, frameMessage(), visibleTab, signal());

    expect(recognize).toHaveBeenCalledTimes(2);
  });

  it("stops before recognizing when the request was cancelled", async () => {
    const { dependencies, recognize, sessions } = setup({});
    const controller = new AbortController();
    controller.abort();

    await expect(
      handleLiveFrameRequest(dependencies, sessions, frameMessage(), visibleTab, controller.signal),
    ).rejects.toThrow();
    expect(recognize).not.toHaveBeenCalled();
  });

  it("reads with the recognizer for the saved source language", async () => {
    const { dependencies, recognize, sessions } = setup({
      settings: {
        ...defaultSettings,
        ocr: { ...defaultSettings.ocr, sourceLang: "ja" },
      },
    });

    await handleLiveFrameRequest(dependencies, sessions, frameMessage(), visibleTab, signal());

    expect(recognize).toHaveBeenCalledWith(
      expect.objectContaining({ sourceLang: "ja" }),
      expect.anything(),
    );
  });
});

describe("handleLiveImageRequest", () => {
  it("reads the image it was sent as a single block", async () => {
    const { dependencies, recognize, sessions } = setup({});

    const response = await handleLiveImageRequest(
      dependencies,
      sessions,
      imageMessage(),
      signal(),
    );

    expect(response).toEqual({ text: "Hello there" });
    expect(dependencies.captureLiveFrame).not.toHaveBeenCalled();
    const [input] = recognize.mock.calls[0];
    expect(input).toMatchObject({ sourceLang: "auto", grouping: "single" });
    await expect((input.image as Blob).text()).resolves.toBe("frame");
  });

  it("skips lines thinner than asked for, and never reads below the floor", async () => {
    const { dependencies, recognize, sessions } = setup({});

    for (const minLineThickness of [undefined, 10, 40]) {
      await handleLiveImageRequest(
        dependencies,
        sessions,
        imageMessage({ minLineThickness }),
        signal(),
      );
    }

    expect(recognize.mock.calls.map(([input]) => input.minLineThickness)).toEqual([
      18, 18, 40,
    ]);
  });

  it("reports the thickest line it read, in pixels of the image", async () => {
    const { dependencies, sessions } = setup({
      texts: ["Good morning. Goodbye."],
      blocks: [[lineOf("Good morning.", 48), lineOf("Goodbye.", 30)]],
    });

    await expect(
      handleLiveImageRequest(dependencies, sessions, imageMessage(), signal()),
    ).resolves.toEqual({ text: "Good morning. Goodbye.", lineThickness: 48 });
  });

  it("keeps the first detected model for the session", async () => {
    const { dependencies, recognize, sessions } = setup({});
    recognize
      .mockResolvedValueOnce({ text: "", providerMeta: { modelId: "v6-multi" } })
      .mockResolvedValueOnce({ text: "Hello", providerMeta: { modelId: "v6-cyrillic" } })
      .mockResolvedValueOnce({ text: "Hi", providerMeta: { modelId: "v6-multi" } });

    for (let read = 0; read < 3; read += 1) {
      await handleLiveImageRequest(dependencies, sessions, imageMessage(), signal());
    }
    // A session that falls back to the screen keeps the same model.
    await handleLiveFrameRequest(dependencies, sessions, frameMessage(), visibleTab, signal());

    expect(recognize.mock.calls.map(([input]) => input.modelId)).toEqual([
      undefined, undefined, "v6-cyrillic", "v6-cyrillic",
    ]);
  });

  it("does not stand in for the last screen capture", async () => {
    const { dependencies, recognize, sessions } = setup({
      frames: [frameOf(10), frameOf(10)],
      texts: ["Screen text", "Video text"],
    });

    await handleLiveFrameRequest(dependencies, sessions, frameMessage(), visibleTab, signal());
    await handleLiveImageRequest(dependencies, sessions, imageMessage(), signal());
    const screen = await handleLiveFrameRequest(
      dependencies,
      sessions,
      frameMessage(),
      visibleTab,
      signal(),
    );

    expect(screen).toEqual({ status: "ok", text: "Screen text", unchanged: true });
    expect(recognize).toHaveBeenCalledTimes(2);
  });
});

describe("handleLiveTranslateRequest", () => {
  const message: Extract<RuntimeMessage, { type: "LIVE_TRANSLATE_REQUEST" }> = {
    type: "LIVE_TRANSLATE_REQUEST",
    requestId: "request-2",
    text: "Good evening",
    context: [],
  };

  it("translates into the saved target language", async () => {
    const { dependencies, translate } = setup({
      settings: {
        ...defaultSettings,
        translation: { ...defaultSettings.translation, targetLang: "de" },
      },
    });

    const response = await handleLiveTranslateRequest(dependencies, message, signal());

    expect(response.translation).toEqual({ text: "[de] Good evening", targetLang: "de" });
    expect(response.translationStatus).toEqual({ state: "ok" });
    expect(translate).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Good evening", targetLang: "de" }),
      expect.anything(),
    );
  });

  it("hands the lines shown before it to the provider as context", async () => {
    const { dependencies, translate } = setup({});
    const context = [
      { text: "Good morning.", translation: "[de] Good morning." },
      { text: "Is it still early?" },
    ];

    await handleLiveTranslateRequest(dependencies, { ...message, context }, signal());

    expect(translate).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Good evening", context }),
      expect.anything(),
    );
  });

  it("leaves the saved settings alone", async () => {
    const { dependencies, set } = setup({});

    await handleLiveTranslateRequest(dependencies, message, signal());

    expect(set).not.toHaveBeenCalled();
  });

  it("skips text that is already in the target language", async () => {
    const { dependencies, translate } = setup({
      settings: {
        ...defaultSettings,
        ocr: { ...defaultSettings.ocr, sourceLang: "en" },
      },
    });

    const response = await handleLiveTranslateRequest(dependencies, message, signal());

    expect(response.translation).toBeUndefined();
    expect(response.translationStatus.state).toBe("same_language");
    expect(translate).not.toHaveBeenCalled();
  });
});
