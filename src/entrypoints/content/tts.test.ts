import { afterEach, describe, expect, it, vi } from "vitest";
import { isSpeaking, requestSpeak, stopSpeaking } from "./tts";

class FakeBufferSource {
  static instances: FakeBufferSource[] = [];

  buffer: { duration: number; source?: string } | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();

  constructor() {
    FakeBufferSource.instances.push(this);
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static decodeError: Error | undefined;

  state = "running";
  currentTime = 0;
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  // Buffers are tagged with their source text so tests can assert chunk order.
  decodeAudioData = vi.fn(async (bytes: ArrayBuffer) => {
    if (FakeAudioContext.decodeError) {
      throw FakeAudioContext.decodeError;
    }
    return { duration: 1, source: new TextDecoder().decode(bytes) };
  });
  createBufferSource = vi.fn(() => new FakeBufferSource());

  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

function installBrowser(
  audioChunks: string[] = [btoa("AUDIO")],
): ReturnType<typeof vi.fn> {
  const sendMessage = vi.fn(async () => ({ ok: true, value: { audioChunks } }));
  vi.stubGlobal("browser", { runtime: { sendMessage } });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  return sendMessage;
}

function playedSources(): FakeBufferSource[] {
  return FakeBufferSource.instances;
}

afterEach(() => {
  stopSpeaking();
  FakeAudioContext.instances = [];
  FakeAudioContext.decodeError = undefined;
  FakeBufferSource.instances = [];
  vi.unstubAllGlobals();
});

describe("Google text to speech playback", () => {
  it("requests audio and plays returned chunks in order", async () => {
    const sendMessage = installBrowser([btoa("FIRST"), btoa("SECOND")]);
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

    await vi.waitFor(() => expect(playedSources()).toHaveLength(2));
    expect(playedSources().map((source) => source.buffer?.source)).toEqual([
      "FIRST",
      "SECOND",
    ]);
    // Scheduled back to back: second chunk starts where the first (1s) ends.
    expect(playedSources()[0].start).toHaveBeenCalledWith(0);
    expect(playedSources()[1].start).toHaveBeenCalledWith(1);

    playedSources()[0].onended?.();
    playedSources()[1].onended?.();

    await vi.waitFor(() => expect(isSpeaking()).toBe(false));
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("plays without an <audio> element so page CSP cannot block it", async () => {
    installBrowser();

    requestSpeak({ text: "Hello", owner: "panel" });

    await vi.waitFor(() => expect(playedSources()).toHaveLength(1));
    expect(FakeAudioContext.instances[0].decodeAudioData).toHaveBeenCalledOnce();
    expect(playedSources()[0].connect).toHaveBeenCalledOnce();
  });

  it("creates the audio context synchronously, inside the click gesture", () => {
    installBrowser();

    requestSpeak({ text: "Hello", owner: "panel" });

    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it("decodes only a couple of chunks ahead of the one playing", async () => {
    installBrowser([btoa("ONE"), btoa("TWO"), btoa("THREE")]);

    requestSpeak({ text: "Hello", owner: "panel" });

    await vi.waitFor(() => expect(playedSources()).toHaveLength(2));
    expect(FakeAudioContext.instances[0].decodeAudioData).toHaveBeenCalledTimes(
      2,
    );

    playedSources()[0].onended?.();

    await vi.waitFor(() => expect(playedSources()).toHaveLength(3));
    expect(playedSources()[2].buffer?.source).toBe("THREE");
  });

  it("skips decoding entirely when stopped before the audio arrives", async () => {
    type Envelope = { ok: true; value: { audioChunks: string[] } };
    let sendReply: ((response: Envelope) => void) | undefined;
    const sendMessage = vi.fn(
      () =>
        new Promise<Envelope>((resolve) => {
          sendReply = resolve;
        }),
    );
    vi.stubGlobal("browser", { runtime: { sendMessage } });
    vi.stubGlobal("AudioContext", FakeAudioContext);

    requestSpeak({ text: "Hello", owner: "panel" });
    stopSpeaking();
    sendReply?.({ ok: true, value: { audioChunks: [btoa("AUDIO")] } });

    await vi.waitFor(() =>
      expect(FakeAudioContext.instances[0].close).toHaveBeenCalledOnce(),
    );
    expect(FakeAudioContext.instances[0].decodeAudioData).not.toHaveBeenCalled();
    expect(playedSources()).toHaveLength(0);
  });

  it("leaves no speaking state behind if the audio context cannot be built", () => {
    installBrowser();
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          throw new Error("no audio device");
        }
      },
    );

    expect(() => requestSpeak({ text: "Hello", owner: "panel" })).toThrow();
    expect(isSpeaking()).toBe(false);
    expect(isSpeaking("panel")).toBe(false);
  });

  it("stops current audio", async () => {
    installBrowser();
    const onEnd = vi.fn();

    requestSpeak({ text: "Hello", owner: "overlay", onEnd });
    await vi.waitFor(() => expect(playedSources()).toHaveLength(1));

    stopSpeaking();

    expect(playedSources()[0].stop).toHaveBeenCalledOnce();
    expect(isSpeaking()).toBe(false);
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("reports a decode failure instead of silently ending", async () => {
    installBrowser();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const onEnd = vi.fn();
    FakeAudioContext.decodeError = new Error("bad audio");

    requestSpeak({ text: "Hello", owner: "panel", onEnd });

    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledOnce());
    expect(consoleError).toHaveBeenCalled();
    expect(isSpeaking()).toBe(false);
    consoleError.mockRestore();
  });

  it("does not request audio for empty text", () => {
    const sendMessage = installBrowser();
    const onEnd = vi.fn();

    expect(requestSpeak({ text: "  ", owner: "panel", onEnd })).toBe(false);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledOnce();
  });
});
