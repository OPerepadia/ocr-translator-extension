import { describe, expect, it } from "vitest";
import type { PipelineResult } from "@/shared/types";
import {
  isOverlayBoxActivationKey,
  isOverlayable,
  overlayDisplayText,
  overlayTargetLanguage,
  popoverMaxWidth,
  popoverVerticalPlacement,
} from "./overlay";

describe("isOverlayBoxActivationKey", () => {
  it.each(["Enter", " "])("accepts %j", (key) => {
    expect(isOverlayBoxActivationKey(key)).toBe(true);
  });

  it.each(["Escape", "Space", "ArrowDown"])("rejects %j", (key) => {
    expect(isOverlayBoxActivationKey(key)).toBe(false);
  });
});

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

describe("popoverMaxWidth", () => {
  it("widens to the box so long text wraps at the box's width", () => {
    expect(popoverMaxWidth(580, 1280)).toBe(580);
  });

  it("keeps a readable minimum for narrow boxes", () => {
    expect(popoverMaxWidth(120, 1280)).toBe(360);
  });

  it("stops widening past the comfortable line length", () => {
    expect(popoverMaxWidth(1100, 1600)).toBe(720);
  });

  it("never exceeds the viewport", () => {
    expect(popoverMaxWidth(600, 320)).toBe(304);
  });
});

describe("popoverVerticalPlacement", () => {
  const viewportHeight = 800;

  // No intentional gap on either side; the close delay only has to bridge the
  // empty corners around tilted boxes.
  it("sits flush below the box when the text fits there", () => {
    const placement = popoverVerticalPlacement({
      boxY: 100,
      boxHeight: 60,
      height: 200,
      viewportHeight,
    });

    expect(placement.top).toBe(160);
    expect(placement.maxHeight).toBeGreaterThanOrEqual(200);
  });

  it("flips flush above when only that side fits", () => {
    const placement = popoverVerticalPlacement({
      boxY: 400,
      boxHeight: 300,
      height: 300,
      viewportHeight,
    });

    expect(placement.top).toBe(100);
    expect(placement.top + 300).toBe(400);
    expect(placement.maxHeight).toBeGreaterThanOrEqual(300);
  });

  it("caps the height and scrolls when neither side fits", () => {
    const placement = popoverVerticalPlacement({
      boxY: 200,
      boxHeight: 100,
      height: 900,
      viewportHeight,
    });

    // Below has the most room, so the popover goes there, capped to it.
    expect(placement.maxHeight).toBe(480);
    expect(placement.top).toBe(300);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(
      viewportHeight,
    );
  });

  it("caps a tall text even where there is room for all of it", () => {
    const placement = popoverVerticalPlacement({
      boxY: 20,
      boxHeight: 20,
      height: 700,
      viewportHeight,
    });

    expect(placement.maxHeight).toBe(480);
  });

  it("keeps a usable popover on screen when the box leaves no room", () => {
    const placement = popoverVerticalPlacement({
      boxY: 0,
      boxHeight: viewportHeight,
      height: 400,
      viewportHeight,
    });

    expect(placement.maxHeight).toBe(120);
    expect(placement.top).toBe(viewportHeight - 120 - 8);
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
