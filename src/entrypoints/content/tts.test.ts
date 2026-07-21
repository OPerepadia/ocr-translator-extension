import { afterEach, describe, expect, it, vi } from "vitest";
import { isSpeaking, requestSpeak, stopSpeaking } from "./tts";

class FakeAudio {
  static instances: FakeAudio[] = [];

  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();
  play = vi.fn(async () => {});

  constructor(readonly src: string) {
    FakeAudio.instances.push(this);
  }
}

function installBrowser(audioChunks: string[] = ["AUDIO"]): ReturnType<typeof vi.fn> {
  const sendMessage = vi.fn(async () => ({ audioChunks }));
  vi.stubGlobal("browser", { runtime: { sendMessage } });
  vi.stubGlobal("Audio", FakeAudio);
  return sendMessage;
}

afterEach(() => {
  stopSpeaking();
  FakeAudio.instances = [];
  vi.unstubAllGlobals();
});

describe("Google text to speech playback", () => {
  it("requests audio and plays returned chunks in order", async () => {
    const sendMessage = installBrowser(["FIRST", "SECOND"]);
    const onStart = vi.fn();
    const onEnd = vi.fn();

    expect(
      requestSpeak({
        text: "こんにちは",
        lang: "ja",
        owner: "panel",
        onStart,
        onEnd,
      }),
    ).toBe(true);

    expect(sendMessage).toHaveBeenCalledWith({
      type: "SPEAK_REQUEST",
      text: "こんにちは",
      lang: "ja",
    });
    expect(isSpeaking("panel")).toBe(true);
    expect(onStart).toHaveBeenCalledOnce();

    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    expect(FakeAudio.instances[0].src).toBe(
      "data:audio/mpeg;base64,FIRST",
    );
    FakeAudio.instances[0].onended?.();

    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(2));
    expect(FakeAudio.instances[1].src).toBe(
      "data:audio/mpeg;base64,SECOND",
    );
    FakeAudio.instances[1].onended?.();

    await vi.waitFor(() => expect(isSpeaking()).toBe(false));
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("stops current audio", async () => {
    installBrowser();
    const onEnd = vi.fn();

    requestSpeak({ text: "Hello", owner: "overlay", onEnd });
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));

    stopSpeaking();

    expect(FakeAudio.instances[0].pause).toHaveBeenCalledOnce();
    expect(isSpeaking()).toBe(false);
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("does not request audio for empty text", () => {
    const sendMessage = installBrowser();
    const onEnd = vi.fn();

    expect(requestSpeak({ text: "  ", owner: "panel", onEnd })).toBe(false);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledOnce();
  });
});
