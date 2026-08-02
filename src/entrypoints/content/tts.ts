import { browserApi } from "../../shared/browser";
import type { SpeakResponse } from "../../shared/messages";

interface SpeakRequest {
  text: string;
  lang?: string;
  owner: string;
  onStart?: () => void;
  onEnd?: () => void;
}

// Chunks decoded and scheduled ahead of the one playing
const LOOKAHEAD = 2;

let speaking = false;
let speakingOwner: string | undefined;
let abortController: AbortController | undefined;
let endHandler: (() => void) | undefined;
let requestId = 0;

export function isSpeaking(owner?: string): boolean {
  return speaking && (!owner || speakingOwner === owner);
}

export function requestSpeak(request: SpeakRequest): boolean {
  stopSpeaking();

  if (!request.text.trim()) {
    request.onEnd?.();
    return false;
  }

  // Built inside the click gesture so autoplay policy leaves it running, and
  // before any state is committed so a failure here leaves nothing set.
  const context = createAudioContext();
  const currentRequestId = requestId;
  const controller = new AbortController();
  abortController = controller;
  speaking = true;
  speakingOwner = request.owner;
  endHandler = request.onEnd;
  request.onStart?.();

  void browserApi.runtime
    .sendMessage<SpeakResponse>({
      type: "SPEAK_REQUEST",
      text: request.text,
      lang: request.lang || "en",
    })
    .then((response) =>
      playChunks(context, response.audioChunks, controller.signal),
    )
    .then(
      () => {
        void context.close();
        finish(currentRequestId, request.onEnd);
      },
      (error: unknown) => {
        void context.close();
        console.error("Screen OCR Translator: speech playback failed.", error);
        finish(currentRequestId, request.onEnd);
      },
    );

  return true;
}

export function stopSpeaking(): void {
  requestId += 1;
  const onEnd = endHandler;
  speaking = false;
  speakingOwner = undefined;
  endHandler = undefined;
  abortController?.abort();
  abortController = undefined;
  onEnd?.();
}

function finish(id: number, onEnd: (() => void) | undefined): void {
  if (!speaking || requestId !== id) {
    return;
  }
  speaking = false;
  speakingOwner = undefined;
  abortController = undefined;
  endHandler = undefined;
  onEnd?.();
}

// A fresh context per utterance, closed once playback settles, so an idle tab
// holds no audio thread.
function createAudioContext(): AudioContext {
  const context = new AudioContext();
  if (context.state === "suspended") {
    void context.resume();
  }
  return context;
}

// Web Audio rather than an <audio> element: a content script's media loads are
// checked against the page's CSP, so a data: URL is refused where media-src is
// restricted (github.com, diff.wikimedia.org). Decoding a buffer loads nothing.
async function playChunks(
  context: AudioContext,
  chunks: string[],
  signal: AbortSignal,
): Promise<void> {
  // Only LOOKAHEAD chunks are decoded at once: PCM runs ~40x its mp3 size. Each
  // buys ~12s of playback and decodes in far less, so seams stay inaudible.
  const playing: Array<Promise<void>> = [];
  let startAt = context.currentTime;

  for (const chunk of chunks) {
    if (signal.aborted) {
      break;
    }
    const buffer = await decodeChunk(context, chunk);
    if (signal.aborted) {
      break;
    }

    // Clamped so a decode that outran the queued audio can't overlap the next.
    startAt = Math.max(startAt, context.currentTime);
    playing.push(playBuffer(context, buffer, startAt, signal));
    startAt += buffer.duration;
    if (playing.length === LOOKAHEAD) {
      await playing.shift();
    }
  }

  await Promise.all(playing);
}

async function decodeChunk(
  context: AudioContext,
  chunk: string,
): Promise<AudioBuffer> {
  const binary = atob(chunk);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return context.decodeAudioData(bytes.buffer);
}

function playBuffer(
  context: AudioContext,
  buffer: AudioBuffer,
  startAt: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const source = context.createBufferSource();
    const finish = (): void => {
      source.onended = null;
      signal.removeEventListener("abort", stop);
      resolve();
    };
    const stop = (): void => {
      source.stop();
      finish();
    };

    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = finish;
    source.start(startAt);
    signal.addEventListener("abort", stop, { once: true });
  });
}
