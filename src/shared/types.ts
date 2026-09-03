export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rect that sits at an angle: `rect` is the box before rotation, `angle` the
 * rotation about its centre, in radians. `rect.width` runs along the text, so
 * `angle` is not folded into a quarter turn — a vertical column reports ~90°. */
export interface OrientedRect {
  rect: Rect;
  angle: number;
}

/**
 * Visible viewport size in CSS pixels, reported by the content script. The
 * background derives the effective device-pixel ratio from the captured
 * screenshot dimensions divided by these values, which stays correct at
 * non-standard zoom levels where `window.devicePixelRatio` does not.
 */
export interface Viewport {
  width: number;
  height: number;
}

/**
 * An image encoded for message passing. Runtime messages are serialized as
 * JSON, which drops Blobs and ArrayBuffers, so the pixels travel as base64.
 */
export interface EncodedImage {
  /** Base64 payload, without a `data:` prefix. */
  data: string;
  mediaType: string;
}

export type LangCode = string;
export type OverlayMode = "translation" | "original";

/** One recognized character and where it sits, in the same pixel space as the
 * block's bbox. Derived from the recognizer's timesteps, so positions are
 * approximate — good enough to lay a selectable text layer over the glyphs. */
export interface OcrChar {
  text: string;
  bbox: Rect;
  /** The character's slice of the line's tilted box. `bbox` bounds the same
   * slice axis-aligned, which for tilted text is a good deal larger. */
  oriented?: OrientedRect;
}

export interface OcrBlock {
  text: string;
  bbox: Rect;
  /** The tilted box the detector found for this line, when the provider reports
   * one. `bbox` bounds the same text axis-aligned, so anything that does not
   * handle rotation keeps working off that. */
  oriented?: OrientedRect;
  /** Per-character boxes for this line, in reading order, when the recognizer
   * could locate them. */
  chars?: OcrChar[];
  confidence?: number;
  /** Index of the translated paragraph this block belongs to. Blocks sharing a
   * value were assigned to the same text region. */
  paragraph?: number;
  /** Reading orientation of this block's paragraph, when the provider
   * distinguishes it — a mixed capture can hold e.g. vertical CJK columns and
   * a horizontal footer. Falls back to the result-level orientation. */
  orientation?: "horizontal" | "vertical";
}

export interface PipelineOcrResult {
  text: string;
  blocks?: OcrBlock[];
  lang?: LangCode;
  confidence?: number;
  /** Reading orientation of the recognized text. "vertical" means CJK columns
   * read top-to-bottom, right-to-left; the overlay then renders the original
   * text with a vertical writing mode to match the source. */
  orientation?: "horizontal" | "vertical";
  providerMeta?: unknown;
  /** Pixel size of the recognized (cropped) image. Block bboxes are in this
   * coordinate space, so the overlay maps them onto the selection rect by
   * fraction (bbox / image size). Set by the OCR engine. */
  imageWidth?: number;
  imageHeight?: number;
}

export interface PipelineTranslationResult {
  text: string;
  sourceLang?: LangCode;
  targetLang: LangCode;
  confidence?: number;
  providerMeta?: unknown;
}

export interface Settings {
  ocr: {
    providerId: string;
    /** Default recognizer language. "auto" uses the general multilingual model. */
    sourceLang?: LangCode | "auto";
    /** ORT execution backend; "webgpu" falls back to wasm when unavailable. */
    backend?: "wasm" | "webgpu";
    /** Developer diagnostics. Not exposed in the options UI. */
    debug?: boolean;
  };
  translation: {
    providerId: string;
    targetLang: LangCode;
    /** OpenAI-compatible endpoint settings, read by the "openai" provider. */
    llm?: {
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      /** Remove the browser extension's Origin header. Defaults to false. */
      removeOriginHeader?: boolean;
      /** Thinking is disabled unless this is explicitly false. */
      disableThinking?: boolean;
      /** Per-request timeout; the provider default (60s) when unset. */
      timeoutMs?: number;
    };
  };
}

/**
 * Outcome of the translation step. OCR always runs; translation may be skipped
 * for matching languages or fail at a remote provider. In both cases
 * `translation` is absent but the recognized text is still shown.
 */
export interface TranslationStatus {
  state: "ok" | "same_language" | "failed";
  /** Set when state === "failed": a human-readable reason. */
  reason?: string;
  /** The resolved source language, set whenever it is known even though
   * translation produced no output, so the UI can still show the recognized-
   * text language badge. For same_language it equals targetLang. */
  sourceLang?: LangCode;
  /** The target language the request used, set for the no-output states
   * (same_language/failed) so the UI can keep the language pill and offer a
   * retry on failure. */
  targetLang?: LangCode;
}

export interface PipelineResult {
  ocr: PipelineOcrResult;
  translation?: PipelineTranslationResult;
  translationStatus: TranslationStatus;
}

/** The step the pipeline is currently working on, reported to the UI for status. */
export type PipelineStatus =
  | { stage: "loading" }
  | { stage: "initializing" }
  | { stage: "recognizing"; line?: number; lineCount?: number }
  | { stage: "translating" };

export interface SerializedError {
  message: string;
  name?: string;
  stack?: string;
}
