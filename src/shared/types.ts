export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
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

export type LangCode = string;

export interface OcrBlock {
  text: string;
  bbox: Rect;
  confidence?: number;
  backgroundTone?: "light" | "dark";
  /** Index of the paragraph this block was grouped into (see assembleResult).
   * Blocks sharing a value belong to the same translated paragraph. */
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
    /** Set only while re-running the current capture. */
    sourceLang?: LangCode | "auto";
    /** ORT execution backend; "webgpu" falls back to wasm when unavailable. */
    backend?: "wasm" | "webgpu";
  };
  translation: {
    providerId: string;
    targetLang: LangCode;
    /** OpenAI-compatible endpoint settings, read by the "openai" provider. */
    llm?: {
      baseUrl?: string;
      apiKey?: string;
      model?: string;
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
  | { stage: "initializing" }
  | { stage: "recognizing"; line?: number; lineCount?: number }
  | { stage: "translating" };

export interface SerializedError {
  message: string;
  name?: string;
  stack?: string;
}
