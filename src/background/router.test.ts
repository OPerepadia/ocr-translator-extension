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
});
