import type {
  EncodedImage,
  LangCode,
  PipelineOcrResult,
  PipelineStatus,
  Rect,
  SerializedError,
  Viewport,
} from "./types";

export type OcrImageSource =
  | { rect: Rect; viewport: Viewport }
  | { imageUrl: string };

export type RuntimeMessage =
  | {
      type: "START_SELECTION";
    }
  | {
      type: "START_IMAGE_PICKER";
      sessionId: string;
    }
  | {
      type: "END_IMAGE_PICKER";
      sessionId: string;
    }
  | {
      type: "CANCEL_IMAGE_PICKER";
      sessionId: string;
    }
  | {
      type: "START_IMAGE_TRANSLATION";
      imageUrl: string;
    }
  // Content -> background: run the pipeline over a region or an image. The
  // response resolves to a PipelineResult, and a failure rejects it — neither
  // comes back as a message of its own.
  | ({ type: "OCR_TRANSLATE_REQUEST"; requestId: string } & OcrImageSource)
  // Background -> content tab: which pipeline step is running, so the loading
  // popup can show the current status (recognizing, translating, …).
  | {
      type: "OCR_TRANSLATE_STATUS";
      requestId: string;
      status: PipelineStatus;
    }
  // Background -> content tab: the OCR step has completed, while translation may
  // still be running. Lets the panel replace stale recognized text immediately.
  | {
      type: "OCR_TRANSLATE_OCR_RESULT";
      requestId: string;
      ocr: PipelineOcrResult;
    }
  // Content -> background: start loading the OCR worker and model while the user
  // is still doing the selection, so recognition can begin as soon as the
  // screenshot is ready. Fire-and-forget; failures surface on the real request.
  | {
      type: "PRELOAD_OCR";
    }
  // Content -> background: open the extension's options page. Content scripts
  // can't call runtime.openOptionsPage themselves, so the background does it.
  | {
      type: "OPEN_OPTIONS";
      section?: "translation";
    }
  // Content -> background: the pixels of this frame's last capture, so the
  // overlay can paint the region it was recognized from instead of leaving its
  // boxes over a page that may have moved on. The response resolves to a
  // CaptureSnapshotResponse, whose snapshot is absent once the capture is gone.
  | {
      type: "GET_CAPTURE_SNAPSHOT";
    }
  // Content -> background: list the languages the active translation provider
  // can translate into. The response resolves to an array of language codes.
  | {
      type: "GET_TARGET_LANGUAGES";
    }
  // Content -> background: list the source languages supported by the packaged
  // recognizers and which one is currently selected.
  | {
      type: "GET_OCR_SOURCE_LANGUAGES";
    }
  // Content -> background: list the available translation providers and which one
  // is currently selected. The response resolves to a TranslationProvidersResponse.
  | {
      type: "GET_TRANSLATION_PROVIDERS";
    }
  // Content -> background: fetch Google TTS audio for the selected text.
  | {
      type: "SPEAK_REQUEST";
      text: string;
      lang: LangCode;
    }
  // Content -> background: re-translate already-recognized text into a new
  // target language (after the user changes it in the popup). Persists the new
  // target as the default. The response resolves to a PipelineResult.
  | {
      type: "RETRANSLATE_REQUEST";
      requestId: string;
      text: string;
      targetLang: LangCode;
    }
  // Content -> background: re-run OCR on the last captured image for a different
  // source language, then translate. The background chooses the recognizer and
  // saves the language as the default for future captures. The pixels stay in
  // the background's capture store: Chrome serializes messages as JSON, so a
  // Blob would not survive the trip.
  | {
      type: "RERECOGNIZE_REQUEST";
      requestId: string;
      sourceLang: LangCode | "auto";
    }
  // Content -> background: switch the active translation provider (picked in the
  // panel) and re-translate already-recognized text with it. Persists the
  // provider as the new default. The response resolves to a PipelineResult.
  | {
      type: "SWITCH_PROVIDER_REQUEST";
      requestId: string;
      providerId: string;
      text: string;
    }
  // Content -> background: abort the in-flight pipeline
  // so an abandoned recognition stops occupying the single OCR worker.
  | {
      type: "CANCEL_REQUEST";
      requestId: string;
    };

export interface OcrSourceLanguagesResponse {
  languages: Array<{ id: string }>;
  currentId: string;
}

export interface TranslationProvidersResponse {
  providers: Array<{ id: string }>;
  currentId: string;
}

export interface CaptureSnapshotResponse {
  /** Absent when the frame has no retained capture — the event page can unload
   * between the capture and the request. */
  snapshot?: EncodedImage;
}

export interface SpeakResponse {
  audioChunks: string[];
}

export function isRuntimeMessage<T extends RuntimeMessage["type"]>(
  value: unknown,
  type: T,
): value is Extract<RuntimeMessage, { type: T }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === type
  );
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}

export function deserializeError(error: SerializedError): Error {
  const reconstructed = new Error(error.message);
  if (error.name) {
    reconstructed.name = error.name;
  }
  if (error.stack) {
    reconstructed.stack = error.stack;
  }
  return reconstructed;
}
