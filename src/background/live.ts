import {
  resolveOcrSourceLanguage,
  resolveTranslationSourceLanguage,
} from "../providers/catalog";
import type {
  LiveFrameResponse,
  LiveTranslationResponse,
  RuntimeMessage,
} from "../shared/messages";
import type { OcrBlock } from "../shared/types";
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
  id?: number;
  active?: boolean;
  windowId?: number;
}

// The thinnest line worth reading, in CSS pixels: the box the detector draws
// around text of about 12 px. It cannot tell smaller sizes apart, and below
// this there is only specks and noise. A session reads nothing thinner, and
// asks for more once it knows how thick its subtitles are.
const MIN_LINE_THICKNESS = 18;

/** The last region that was actually read in a live session, and what it said.
 * The next capture is compared with this one. */
interface LiveReading {
  signature: FrameSignature;
  text: string;
  /** The thinnest line that was read, in image pixels. A look at the same
   * frame with a higher one would give different text. */
  minLineThickness: number;
}

export interface LiveSessions {
  get(sessionId: string): LiveReading | undefined;
  set(sessionId: string, reading: LiveReading): void;
  end(sessionId: string): void;
}

export function createLiveSessions(): LiveSessions {
  const readings = new Map<string, LiveReading>();

  return {
    get: (sessionId) => readings.get(sessionId),
    set: (sessionId, reading) => {
      readings.set(sessionId, reading);
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
  if (
    !sender?.active ||
    sender.id === undefined ||
    sender.windowId === undefined
  ) {
    return { status: "hidden" };
  }

  const settings = await dependencies.settingsRepository.get();
  const sourceLanguage = resolveOcrSourceLanguage(settings.ocr.sourceLang);
  const frame = await dependencies.captureLiveFrame({
    rect: message.rect,
    viewport: message.viewport,
    mask: message.mask,
    tabId: sender.id,
    windowId: sender.windowId,
  });
  signal.throwIfAborted();
  if (!frame) {
    return { status: "hidden" };
  }

  // The session asks for a share of the region's height. The region grows and
  // shrinks with the video under it, and so do the subtitles.
  const regionHeight = message.rect.height * frame.pixelRatio;
  const minLineThickness = Math.max(
    MIN_LINE_THICKNESS * frame.pixelRatio,
    (message.minLineThickness ?? 0) * regionHeight,
  );
  const previous = sessions.get(message.sessionId);
  if (
    previous &&
    previous.minLineThickness === minLineThickness &&
    framesMatch(previous.signature, frame.signature)
  ) {
    return { status: "ok", text: previous.text, unchanged: true };
  }

  const image = await frame.toBlob();
  const recognized = await dependencies
    .createOcrProvider(settings.ocr)
    .recognize(
      {
        image,
        sourceLang: sourceLanguage.sourceLang,
        grouping: "single",
        minLineThickness,
      },
      signal,
    );

  const lineThickness = thickestLine(recognized.blocks, regionHeight);
  sessions.set(message.sessionId, {
    signature: frame.signature,
    text: recognized.text,
    minLineThickness,
  });
  return {
    status: "ok",
    text: recognized.text,
    unchanged: false,
    lineThickness,
  };
}

/** The thickest line of a result, as a share of `regionHeight`, which is in
 * image pixels. */
function thickestLine(
  blocks: OcrBlock[] | undefined,
  regionHeight: number,
): number | undefined {
  const thickest = (blocks ?? []).reduce(
    (max, block) => Math.max(max, block.oriented?.rect.height ?? 0),
    0,
  );
  return thickest > 0 ? thickest / regionHeight : undefined;
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
