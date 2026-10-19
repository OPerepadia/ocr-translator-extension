import {
  resolveOcrSourceLanguage,
  resolveTranslationSourceLanguage,
} from "../providers/catalog";
import { framesMatch, type FrameSignature } from "../shared/frame-signature";
import { base64ToBlob } from "../shared/image";
import type {
  LiveFrameResponse,
  LiveImageResponse,
  LiveTranslationResponse,
  RuntimeMessage,
} from "../shared/messages";
import type { OcrBlock, Settings } from "../shared/types";
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

// The thinnest line worth reading, in CSS pixels on screen and in pixels of a
// video frame as it is read: the box the detector draws around text of about
// 12 px. It cannot tell smaller sizes apart, and below this there is only
// specks and noise. A session reads nothing thinner, and asks for more once it
// knows how thick its subtitles are.
const MIN_LINE_THICKNESS = 18;

/** What a live session keeps between reads. */
interface LiveSessionState {
  ocrProviderId: string;
  /** The recognizer model Auto picked from the session's first text. */
  modelId?: string;
  /** The last screen capture that was actually read, and what it said. The
   * next capture is compared with this one. */
  screen?: ScreenReading;
}

interface ScreenReading {
  signature: FrameSignature;
  text: string;
  /** The thinnest line that was read, in image pixels. A look at the same
   * frame with a higher one would give different text. */
  minLineThickness: number;
}

/** What each running live session keeps, by session id. */
export type LiveSessions = Map<string, LiveSessionState>;

function getLiveSession(
  sessions: LiveSessions,
  sessionId: string,
  ocrProviderId: string,
): LiveSessionState {
  const current = sessions.get(sessionId);
  if (current?.ocrProviderId === ocrProviderId) {
    return current;
  }
  const session = { ocrProviderId };
  sessions.set(sessionId, session);
  return session;
}

/**
 * Capture a region and read its text. Skips recognition when the region looks
 * the same as at the last read, which is what a paused video does.
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
  const session = getLiveSession(sessions, message.sessionId, settings.ocr.providerId);
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
  const previous = session.screen;
  if (
    previous &&
    previous.minLineThickness === minLineThickness &&
    framesMatch(previous.signature, frame.signature)
  ) {
    return { status: "ok", text: previous.text, unchanged: true };
  }

  const recognized = await recognizeLiveImage(
    dependencies,
    settings,
    session,
    await frame.toBlob(),
    minLineThickness,
    signal,
  );
  session.screen = {
    signature: frame.signature,
    text: recognized.text,
    minLineThickness,
  };
  return {
    status: "ok",
    text: recognized.text,
    unchanged: false,
    lineThickness:
      recognized.lineThickness && recognized.lineThickness / regionHeight,
  };
}

/** Read the text in a region the content script took from a video. */
export async function handleLiveImageRequest(
  dependencies: LiveDependencies,
  sessions: LiveSessions,
  message: Extract<RuntimeMessage, { type: "LIVE_IMAGE_REQUEST" }>,
  signal: AbortSignal,
): Promise<LiveImageResponse> {
  const settings = await dependencies.settingsRepository.get();
  const session = getLiveSession(sessions, message.sessionId, settings.ocr.providerId);
  return recognizeLiveImage(
    dependencies,
    settings,
    session,
    base64ToBlob(message.image.data, message.image.mediaType),
    Math.max(MIN_LINE_THICKNESS, message.minLineThickness ?? 0),
    signal,
  );
}

/**
 * Read a live region as a plain single block of text. The layout model that
 * splits a page into bubbles and columns is slow, and a subtitle is one
 * sentence over however many lines.
 *
 * With the source language on Auto, the first model that finds text is kept
 * for the rest of the session.
 */
async function recognizeLiveImage(
  dependencies: LiveDependencies,
  settings: Settings,
  session: LiveSessionState,
  image: Blob,
  minLineThickness: number,
  signal: AbortSignal,
): Promise<LiveImageResponse> {
  const { sourceLang } = resolveOcrSourceLanguage(
    settings.ocr.sourceLang,
    settings.ocr.providerId,
  );
  const auto = sourceLang === "auto";
  const { modelId } = session;
  const recognized = await dependencies
    .createOcrProvider(settings.ocr)
    .recognize(
      {
        image,
        sourceLang,
        modelId: auto ? modelId : undefined,
        grouping: "single",
        minLineThickness,
      },
      signal,
    );

  const metadata = recognized.providerMeta as { modelId?: unknown } | undefined;
  if (
    auto &&
    modelId === undefined &&
    recognized.text.trim() &&
    typeof metadata?.modelId === "string"
  ) {
    session.modelId = metadata.modelId;
  }
  return {
    text: recognized.text,
    lineThickness: thickestLine(recognized.blocks),
  };
}

/** The thickest line of a result, in image pixels. */
function thickestLine(blocks: OcrBlock[] | undefined): number | undefined {
  const thickest = (blocks ?? []).reduce(
    (max, block) => Math.max(max, block.oriented?.rect.height ?? 0),
    0,
  );
  return thickest > 0 ? thickest : undefined;
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
    sourceLang: resolveTranslationSourceLanguage(
      settings.ocr.sourceLang,
      settings.ocr.providerId,
    ),
    targetLang: settings.translation.targetLang,
    context: message.context,
    detectLanguage: dependencies.detectLanguage,
    signal,
  });
  return { translation, translationStatus };
}
