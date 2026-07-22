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
});
