import { describe, expect, it } from "vitest";
import {
  isCancelImagePickerMessage,
  isEndImagePickerMessage,
  isGetOcrSourceLanguagesRequest,
  isOcrTranslateOcrResult,
  isOcrTranslateRequest,
  isOcrTranslateStatus,
  isRuntimeMessage,
  isRerecognizeRequest,
  isSpeakRequest,
  isStartImagePickerMessage,
  isStartImageTranslationMessage,
  isStartSelectionMessage,
  serializeError,
} from "./messages";

describe("runtime message guards", () => {
  it("recognizes runtime messages by string type", () => {
    expect(isRuntimeMessage({ type: "START_SELECTION" })).toBe(true);
    expect(isRuntimeMessage({ type: 123 })).toBe(false);
    expect(isRuntimeMessage(null)).toBe(false);
  });

  it("recognizes start selection messages", () => {
    expect(isStartSelectionMessage({ type: "START_SELECTION" })).toBe(true);
    expect(
      isStartImagePickerMessage({
        type: "START_IMAGE_PICKER",
        sessionId: "picker-1",
      }),
    ).toBe(true);
    expect(isStartImagePickerMessage({ type: "START_IMAGE_PICKER" })).toBe(
      false,
    );
    expect(
      isEndImagePickerMessage({
        type: "END_IMAGE_PICKER",
        sessionId: "picker-1",
      }),
    ).toBe(true);
    expect(
      isCancelImagePickerMessage({
        type: "CANCEL_IMAGE_PICKER",
        sessionId: "picker-1",
      }),
    ).toBe(true);
    expect(
      isStartImageTranslationMessage({
        type: "START_IMAGE_TRANSLATION",
        imageUrl: "file:///tmp/sample.png",
      }),
    ).toBe(true);
    expect(isStartSelectionMessage({ type: "OCR_TRANSLATE_REQUEST" })).toBe(
      false,
    );
  });

  it("recognizes OCR translate requests", () => {
    expect(
      isOcrTranslateRequest({
        type: "OCR_TRANSLATE_REQUEST",
        requestId: "request-1",
        rect: {
          x: 0,
          y: 0,
          width: 10,
          height: 20,
        },
        viewport: {
          width: 1280,
          height: 720,
        },
      }),
    ).toBe(true);
    expect(isOcrTranslateRequest({ type: "START_SELECTION" })).toBe(false);
    expect(
      isOcrTranslateRequest({
        type: "OCR_TRANSLATE_REQUEST",
        requestId: "request-2",
        imageUrl: "https://example.com/sample.png",
      }),
    ).toBe(true);
  });

  it("recognizes pipeline status and partial OCR result messages", () => {
    expect(
      isOcrTranslateStatus({
        type: "OCR_TRANSLATE_STATUS",
        requestId: "r1",
        status: { stage: "loading" },
      }),
    ).toBe(true);
    expect(
      isOcrTranslateStatus({
        type: "OCR_TRANSLATE_STATUS",
        requestId: "r1",
        status: { stage: "translating" },
      }),
    ).toBe(true);
    expect(isOcrTranslateStatus({ type: "OCR_TRANSLATE_REQUEST" })).toBe(false);

    expect(
      isOcrTranslateOcrResult({
        type: "OCR_TRANSLATE_OCR_RESULT",
        requestId: "r1",
        ocr: { text: "Hello" },
      }),
    ).toBe(true);
    expect(
      isOcrTranslateOcrResult({ type: "OCR_TRANSLATE_STATUS" }),
    ).toBe(false);
  });

  it("recognizes OCR source-language requests", () => {
    expect(
      isGetOcrSourceLanguagesRequest({ type: "GET_OCR_SOURCE_LANGUAGES" }),
    ).toBe(true);
    expect(
      isRerecognizeRequest({
        type: "RERECOGNIZE_REQUEST",
        requestId: "r1",
        sourceLang: "uk",
      }),
    ).toBe(true);
  });

  it("recognizes speech requests", () => {
    expect(
      isSpeakRequest({ type: "SPEAK_REQUEST", text: "Hello", lang: "en" }),
    ).toBe(true);
    expect(isSpeakRequest({ type: "GET_TARGET_LANGUAGES" })).toBe(false);
  });
});

describe("serializeError", () => {
  it("keeps Error details", () => {
    const error = new Error("Something failed");

    expect(serializeError(error)).toMatchObject({
      message: "Something failed",
      name: "Error",
    });
  });

  it("serializes unknown thrown values", () => {
    expect(serializeError("plain failure")).toEqual({
      message: "plain failure",
    });
  });
});
