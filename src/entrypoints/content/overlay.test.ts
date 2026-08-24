import { describe, expect, it } from "vitest";
import type { PipelineResult } from "@/shared/types";
import {
  isOverlayable,
  overlayDisplayText,
  overlayTargetLanguage,
} from "./overlay";

const overlayReadyOcr: PipelineResult["ocr"] = {
  text: "Hello",
  blocks: [{ text: "Hello", bbox: { x: 0, y: 0, width: 100, height: 20 } }],
  imageWidth: 100,
  imageHeight: 20,
};

describe("overlayDisplayText", () => {
  it("uses the translation when one exists", () => {
    const result: PipelineResult = {
      ocr: overlayReadyOcr,
      translation: { text: "Bonjour", targetLang: "fr" },
      translationStatus: { state: "ok" },
    };

    expect(overlayDisplayText(result)).toBe("Bonjour");
  });

  it("uses OCR text when translation was skipped for same language", () => {
    const result: PipelineResult = {
      ocr: overlayReadyOcr,
      translationStatus: {
        state: "same_language",
        sourceLang: "en",
        targetLang: "en",
      },
    };

    expect(overlayDisplayText(result)).toBe("Hello");
    expect(isOverlayable(result)).toBe(true);
  });

  it("keeps unchanged translated text overlayable", () => {
    const result: PipelineResult = {
      ocr: overlayReadyOcr,
      translation: { text: "Hello", sourceLang: "en", targetLang: "en" },
      translationStatus: { state: "ok" },
    };

    expect(overlayDisplayText(result)).toBe("Hello");
    expect(isOverlayable(result)).toBe(true);
  });

  it("keeps recognized boxes overlayable when translation fails", () => {
    const result: PipelineResult = {
      ocr: overlayReadyOcr,
      translationStatus: { state: "failed", targetLang: "ja" },
    };

    expect(overlayDisplayText(result)).toBe("Hello");
    expect(isOverlayable(result)).toBe(true);
  });
});

describe("overlayTargetLanguage", () => {
  it("uses the translated target language", () => {
    const result: PipelineResult = {
      ocr: overlayReadyOcr,
      translation: { text: "Bonjour", targetLang: "fr" },
      translationStatus: { state: "ok" },
    };

    expect(overlayTargetLanguage(result)).toBe("fr");
  });

  it("falls back to no-output translation status target language", () => {
    const result: PipelineResult = {
      ocr: overlayReadyOcr,
      translationStatus: {
        state: "same_language",
        sourceLang: "en",
        targetLang: "en",
      },
    };

    expect(overlayTargetLanguage(result)).toBe("en");
  });
});
