import { describe, expect, it } from "vitest";
import type { OcrProvider } from "../providers/ocr/types";
import { RemoteTranslationError } from "../providers/translation/errors";
import type { TranslationProvider } from "../providers/translation/types";
import { runPipeline } from "./pipeline";

describe("runPipeline", () => {
  it("passes recognized text and language to the translation provider", async () => {
    const image = new Blob(["image"]);
    const ocrCalls: unknown[] = [];
    const translationCalls: unknown[] = [];
    const ocrProvider: OcrProvider = {
      id: "ocr-test",
      async recognize(input) {
        ocrCalls.push(input);

        return {
          text: "Hello",
          lang: "en",
          confidence: 0.9,
        };
      },
    };
    const translationProvider: TranslationProvider = {
      id: "translation-test",
      async translate(input) {
        translationCalls.push(input);

        return {
          text: "Hi",
          sourceLang: input.sourceLang === "auto" ? undefined : input.sourceLang,
          targetLang: input.targetLang,
        };
      },
    };

    const result = await runPipeline({
      image,
      ocrProvider,
      translationProvider,
      sourceLang: "auto",
      targetLang: "uk",
    });

    expect(ocrCalls).toEqual([
      {
        image,
        sourceLang: "auto",
      },
    ]);
    expect(translationCalls).toEqual([
      {
        text: "Hello",
        sourceLang: "en",
        targetLang: "uk",
      },
    ]);
    expect(result).toEqual({
      ocr: {
        text: "Hello",
        lang: "en",
        confidence: 0.9,
      },
      translation: {
        text: "Hi",
        sourceLang: "en",
        targetLang: "uk",
      },
      translationStatus: { state: "ok" },
    });
  });

  it("detects the source language when it is auto and OCR reports none", async () => {
    const events: string[] = [];
    const translationCalls: unknown[] = [];
    const ocrProvider: OcrProvider = {
      id: "ocr-test",
      async recognize() {
        return { text: "Guten Tag" };
      },
    };
    const translationProvider: TranslationProvider = {
      id: "translation-test",
      async translate(input) {
        events.push("translate");
        translationCalls.push(input);
        return { text: "Good day", targetLang: input.targetLang };
      },
    };

    const result = await runPipeline({
      image: new Blob(["image"]),
      ocrProvider,
      translationProvider,
      sourceLang: "auto",
      targetLang: "en",
      detectLanguage: async () => {
        events.push("detect-language");
        return "de";
      },
      onOcrResult: (ocr) => {
        events.push("ocr-result");
        expect(ocr).toEqual({ text: "Guten Tag", lang: "de" });
      },
    });

    expect(events).toEqual(["detect-language", "ocr-result", "translate"]);
    expect(translationCalls).toEqual([
      { text: "Guten Tag", sourceLang: "de", targetLang: "en" },
    ]);
    expect(result.ocr).toEqual({ text: "Guten Tag", lang: "de" });
  });

  it("reports the OCR result before translating", async () => {
    const events: string[] = [];
    const ocrProvider: OcrProvider = {
      id: "ocr-test",
      async recognize() {
        events.push("recognize");
        return { text: "Bonjour", lang: "fr" };
      },
    };
    const translationProvider: TranslationProvider = {
      id: "translation-test",
      async translate() {
        events.push("translate");
        return { text: "Hello", targetLang: "en" };
      },
    };

    await runPipeline({
      image: new Blob(["image"]),
      ocrProvider,
      translationProvider,
      sourceLang: "auto",
      targetLang: "en",
      onOcrResult: async (ocr) => {
        expect(ocr).toEqual({ text: "Bonjour", lang: "fr" });
        events.push("ocr-result-start");
        await Promise.resolve();
        events.push("ocr-result");
      },
    });

    expect(events).toEqual([
      "recognize",
      "ocr-result-start",
      "ocr-result",
      "translate",
    ]);
  });

  it("reports same_language and skips translation when source equals target", async () => {
    let translateCalled = false;
    const ocrProvider: OcrProvider = {
      id: "ocr-test",
      async recognize() {
        return { text: "Hello" };
      },
    };
    const translationProvider: TranslationProvider = {
      id: "translation-test",
      async translate(input) {
        translateCalled = true;
        return { text: input.text, targetLang: input.targetLang };
      },
    };

    const result = await runPipeline({
      image: new Blob(["image"]),
      ocrProvider,
      translationProvider,
      sourceLang: "auto",
      targetLang: "en",
      detectLanguage: async () => "en",
    });

    expect(translateCalled).toBe(false);
    expect(result.translation).toBeUndefined();
    expect(result.translationStatus).toEqual({
      state: "same_language",
      sourceLang: "en",
      targetLang: "en",
    });
  });

  it("reports failed (keeping OCR + target) when a remote request fails", async () => {
    const ocrProvider: OcrProvider = {
      id: "ocr-test",
      async recognize() {
        return { text: "Hola", lang: "es" };
      },
    };
    const translationProvider: TranslationProvider = {
      id: "translation-test",
      async translate() {
        throw new RemoteTranslationError("Google Translate request failed.");
      },
    };

    const result = await runPipeline({
      image: new Blob(["image"]),
      ocrProvider,
      translationProvider,
      sourceLang: "es",
      targetLang: "en",
    });

    expect(result.ocr.text).toBe("Hola");
    expect(result.translation).toBeUndefined();
    expect(result.translationStatus).toEqual({
      state: "failed",
      reason: "Google Translate request failed.",
      targetLang: "en",
      sourceLang: "es",
    });
  });

  it("rethrows unexpected errors instead of swallowing them", async () => {
    const ocrProvider: OcrProvider = {
      id: "ocr-test",
      async recognize() {
        return { text: "x", lang: "de" };
      },
    };
    const translationProvider: TranslationProvider = {
      id: "translation-test",
      async translate() {
        throw new Error("boom");
      },
    };

    await expect(
      runPipeline({
        image: new Blob(["image"]),
        ocrProvider,
        translationProvider,
        sourceLang: "de",
        targetLang: "en",
      }),
    ).rejects.toThrow("boom");
  });

  it("falls back to the requested source language when OCR does not detect one", async () => {
    const translationCalls: unknown[] = [];
    const ocrProvider: OcrProvider = {
      id: "ocr-test",
      async recognize() {
        return {
          text: "Bonjour",
        };
      },
    };
    const translationProvider: TranslationProvider = {
      id: "translation-test",
      async translate(input) {
        translationCalls.push(input);

        return {
          text: "Hello",
          targetLang: input.targetLang,
        };
      },
    };

    await runPipeline({
      image: new Blob(["image"]),
      ocrProvider,
      translationProvider,
      sourceLang: "fr",
      targetLang: "en",
    });

    expect(translationCalls).toEqual([
      {
        text: "Bonjour",
        sourceLang: "fr",
        targetLang: "en",
      },
    ]);
  });
});
