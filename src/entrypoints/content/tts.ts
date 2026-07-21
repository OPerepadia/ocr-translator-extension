import { browserApi } from "../../shared/browser";
import type { SpeakResponse } from "../../shared/messages";

interface SpeakRequest {
  text: string;
  lang?: string;
  owner: string;
  onStart?: () => void;
  onEnd?: () => void;
}

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
    .then((response) => playChunks(response.audioChunks, controller.signal))
    .then(
      () => finish(currentRequestId, request.onEnd),
      () => finish(currentRequestId, request.onEnd),
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

async function playChunks(
  chunks: string[],
  signal: AbortSignal,
): Promise<void> {
  for (const chunk of chunks) {
    if (signal.aborted) {
      return;
    }
    await playChunk(chunk, signal);
  }
}

function playChunk(chunk: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(`data:audio/mpeg;base64,${chunk}`);
    let settled = false;

    const cleanup = (): boolean => {
      if (settled) {
        return false;
      }
      settled = true;
      audio.onended = null;
      audio.onerror = null;
      signal.removeEventListener("abort", stop);
      return true;
    };
    const finish = (): void => {
      if (!cleanup()) {
        return;
      }
      resolve();
    };
    const stop = (): void => {
      audio.pause();
      finish();
    };

    audio.onended = finish;
    audio.onerror = finish;
    signal.addEventListener("abort", stop, { once: true });
    audio.play().catch((error: unknown) => {
      if (cleanup()) {
        reject(error);
      }
    });
  });
}
