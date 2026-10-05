import {
  resolveOcrSourceLanguage,
  resolveTranslationSourceLanguage,
} from "../providers/catalog";
import type {
  LiveFrameResponse,
  LiveTranslationResponse,
  RuntimeMessage,
} from "../shared/messages";
import { framesMatch, type FrameSignature } from "./frame-signature";
import { translateText } from "./pipeline";
import type { RouterDependencies } from "./router";

export type LiveDependencies = Pick<
  RouterDependencies,
  | "settingsRepository"
  | "captureLiveFrame"
  | "createOcrProvider"
  | "createTranslationProvider"
  | "detectLanguage"
>;

/** The tab a live request came from. */
export interface LiveSender {
  active?: boolean;
  windowId?: number;
}

/** The last region that was actually read in a live session, and what it said.
 * The next capture is compared with this one. */
interface LiveReading {
  signature: FrameSignature;
  text: string;
  readAt: number;
}

export interface LiveSessions {
  get(sessionId: string): LiveReading | undefined;
  set(sessionId: string, reading: Omit<LiveReading, "readAt">): void;
  end(sessionId: string): void;
}

// A session whose tab went away never says goodbye. The state is small, so
// this only keeps the map from growing across a long browser session.
const SESSION_TTL_MS = 10 * 60_000;

export function createLiveSessions(now: () => number = Date.now): LiveSessions {
  const readings = new Map<string, LiveReading>();

  return {
    get: (sessionId) => readings.get(sessionId),
    set(sessionId, reading) {
      const current = now();
      for (const [id, existing] of readings) {
        if (current - existing.readAt > SESSION_TTL_MS) {
          readings.delete(id);
        }
      }
      readings.set(sessionId, { ...reading, readAt: current });
    },
    end: (sessionId) => {
      readings.delete(sessionId);
    },
  };
}

/**
 * Capture a region and read its text. Skips recognition when the region looks
 * the same as at the last read, which is what a paused video does.
 *
 * Each read is a plain single block of text. The layout model that splits a
 * page into bubbles and columns is slow, and a subtitle is one sentence over
 * however many lines.
 */
export async function handleLiveFrameRequest(
  dependencies: LiveDependencies,
  sessions: LiveSessions,
  message: Extract<RuntimeMessage, { type: "LIVE_FRAME_REQUEST" }>,
  sender: LiveSender | undefined,
  signal: AbortSignal,
): Promise<LiveFrameResponse> {
  // A screenshot is of whichever tab is active in the window. Once the user
  // switches tabs, that is no longer the page this region belongs to.
  if (!sender?.active) {
    return { status: "hidden" };
  }

  const settings = await dependencies.settingsRepository.get();
  const sourceLanguage = resolveOcrSourceLanguage(settings.ocr.sourceLang);
  const frame = await dependencies.captureLiveFrame({
    rect: message.rect,
    viewport: message.viewport,
    mask: message.mask,
    windowId: sender.windowId,
  });
  signal.throwIfAborted();

  const previous = sessions.get(message.sessionId);
  if (previous && framesMatch(previous.signature, frame.signature)) {
    return { status: "ok", text: previous.text, unchanged: true };
  }

  const image = await frame.toBlob();
  const recognized = await dependencies
    .createOcrProvider(settings.ocr)
    .recognize(
      { image, sourceLang: sourceLanguage.sourceLang, grouping: "single" },
      signal,
    );

  sessions.set(message.sessionId, {
    signature: frame.signature,
    text: recognized.text,
  });
  return { status: "ok", text: recognized.text, unchanged: false };
}

/** Translate a line the live loop read, into the saved target language. */
export async function handleLiveTranslateRequest(
  dependencies: LiveDependencies,
  message: Extract<RuntimeMessage, { type: "LIVE_TRANSLATE_REQUEST" }>,
  signal: AbortSignal,
): Promise<LiveTranslationResponse> {
  const settings = await dependencies.settingsRepository.get();
  const { translation, translationStatus } = await translateText({
    text: message.text,
    translationProvider: dependencies.createTranslationProvider(
      settings.translation,
    ),
    sourceLang: resolveTranslationSourceLanguage(settings.ocr.sourceLang),
    targetLang: settings.translation.targetLang,
    context: message.context,
    detectLanguage: dependencies.detectLanguage,
    signal,
  });
  return { translation, translationStatus };
}
