import { describe, expect, it, vi } from "vitest";
import type { OcrProvider } from "../providers/ocr/types";
import type { TranslationProvider } from "../providers/translation/types";
import type { RuntimeMessage } from "../shared/messages";
import { defaultSettings } from "../shared/storage";
import type { OcrBlock, Settings } from "../shared/types";
import type { LiveFrame } from "./capture";
import { createFrameSignature } from "./frame-signature";
import {
  createLiveSessions,
  handleLiveFrameRequest,
  handleLiveTranslateRequest,
  type LiveDependencies,
} from "./live";

type FrameMessage = Extract<RuntimeMessage, { type: "LIVE_FRAME_REQUEST" }>;

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
    mask: [],
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
  return { dependencies, recognize, translate, set, sessions: createLiveSessions() };
}

const signal = () => new AbortController().signal;

describe("handleLiveFrameRequest", () => {
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
      frameMessage({ minLineThickness: 30 }),
      visibleTab,
      signal(),
    );

    expect(recognize).toHaveBeenCalledWith(
      expect.objectContaining({ minLineThickness: 30 }),
      expect.anything(),
    );
  });

  it("never reads below the floor, whatever the session asks", async () => {
    const { dependencies, recognize, sessions } = setup({});

    await handleLiveFrameRequest(
      dependencies,
      sessions,
      frameMessage({ minLineThickness: 5 }),
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
      frameMessage({ minLineThickness: 30 }),
      visibleTab,
      signal(),
    );

    expect(recognize.mock.calls.map(([input]) => input.minLineThickness)).toEqual([
      36, 60,
    ]);
  });

  it("reports the thickest line it read, in CSS pixels", async () => {
    const { dependencies, sessions } = setup({
      frames: [frameOf(10, 2)],
      texts: ["Good morning. Goodbye."],
      blocks: [[lineOf("Good morning.", 44), lineOf("Goodbye.", 30)]],
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
      lineThickness: 22,
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
    const mask = [{ x: 0, y: 100, width: 300, height: 80 }];

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
      frameMessage({ minLineThickness: 30 }),
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
    sessions.end("session-1");
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

    await handleLiveTranslateRequest(
      dependencies,
      { ...message, context: ["Good morning.", "Is it still early?"] },
      signal(),
    );

    expect(translate).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Good evening",
        context: ["Good morning.", "Is it still early?"],
      }),
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
