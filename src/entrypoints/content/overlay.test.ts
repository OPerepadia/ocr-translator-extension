import { describe, expect, it } from "vitest";
import type { PipelineResult } from "@/shared/types";
import {
  isOverlayable,
  overlayDisplayText,
  overlayTargetLanguage,
  toolbarErrorChipY,
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

describe("toolbarErrorChipY", () => {
  it("places a recovery error below a toolbar near the top edge", () => {
    const toolbar = { top: 32, bottom: 72 };
    const y = toolbarErrorChipY(
      { x: 20, y: 4, width: 300, height: 20 },
      64,
      720,
      toolbar,
    );

    expect(y).toBeGreaterThanOrEqual(toolbar.bottom + 8);
  });

  it("places a recovery error above a toolbar near the bottom edge", () => {
    const toolbar = { top: 628, bottom: 668 };
    const height = 64;
    const y = toolbarErrorChipY(
      { x: 20, y: 676, width: 300, height: 20 },
      height,
      720,
      toolbar,
    );

    expect(y + height).toBeLessThanOrEqual(toolbar.top - 8);
  });
});
