import { describe, expect, it } from "vitest";
import {
  autoOcrModels,
  DEFAULT_OCR_MODEL_ID,
  COMMON_OCR_SOURCE_LANGUAGES,
  OCR_MODELS,
  OCR_SOURCE_LANGUAGES,
  ocrSourceLanguagesForProvider,
  TRANSLATION_PROVIDERS,
  resolveOcrModelDir,
  resolveOcrModelIdForSourceLanguage,
  resolveOcrSourceLanguage,
  resolveTranslationSourceLanguage,
} from "./catalog";

describe("translation providers", () => {
  it("offers Google, DeepL and LLM translation", () => {
    expect(TRANSLATION_PROVIDERS.map(({ id }) => id)).toEqual([
      "google",
      "deepl",
      "openai",
    ]);
  });
});

describe("resolveOcrModelDir", () => {
  it("maps a known model id to its asset folder", () => {
    expect(resolveOcrModelDir("cyrillic-v5")).toBe("assets/ocr/cyrillic-v5/");
    expect(resolveOcrModelDir("korean-v5")).toBe("assets/ocr/korean-v5/");
    expect(resolveOcrModelDir("arabic-v5")).toBe("assets/ocr/arabic-v5/");
    expect(resolveOcrModelDir("devanagari-v5")).toBe(
      "assets/ocr/devanagari-v5/",
    );
  });

  it("falls back to the default folder for unknown or missing ids", () => {
    const fallback = OCR_MODELS.find(
      (model) => model.id === DEFAULT_OCR_MODEL_ID,
    )!.modelDir;
    expect(resolveOcrModelDir(undefined)).toBe(fallback);
    expect(resolveOcrModelDir("does-not-exist")).toBe(fallback);
  });

  it("default model id exists in the catalog", () => {
    expect(
      OCR_MODELS.some((model) => model.id === DEFAULT_OCR_MODEL_ID),
    ).toBe(true);
  });
});

describe("OCR source languages", () => {
  it("maps Auto and supported scripts to their recognizers", () => {
    expect(resolveOcrModelIdForSourceLanguage("auto")).toBe("v6-multi");
    expect(resolveOcrModelIdForSourceLanguage("ja")).toBe("v6-multi");
    expect(resolveOcrModelIdForSourceLanguage("uk")).toBe("cyrillic-v5");
    expect(resolveOcrModelIdForSourceLanguage("ko")).toBe("korean-v5");
    expect(resolveOcrModelIdForSourceLanguage("ar")).toBe("arabic-v5");
    expect(resolveOcrModelIdForSourceLanguage("ur")).toBe("arabic-v5");
    expect(resolveOcrModelIdForSourceLanguage("hi")).toBe("devanagari-v5");
  });

  it("falls back to Auto for an unknown or missing selection", () => {
    expect(resolveOcrSourceLanguage(undefined).id).toBe("auto");
    expect(resolveOcrSourceLanguage("unknown").id).toBe("auto");
  });

  it("normalizes script-specific selections for translation", () => {
    expect(resolveTranslationSourceLanguage("sr-Latn")).toBe("sr");
    expect(resolveTranslationSourceLanguage("sr-Cyrl")).toBe("sr");
  });

  it("has unique ids and only references packaged models", () => {
    expect(new Set(OCR_SOURCE_LANGUAGES.map(({ id }) => id)).size).toBe(
      OCR_SOURCE_LANGUAGES.length,
    );
    expect(
      OCR_SOURCE_LANGUAGES.every(({ modelId }) =>
        OCR_MODELS.some(({ id }) => id === modelId),
      ),
    ).toBe(true);
    expect(OCR_MODELS.map(({ script }) => script)).toEqual([
      "general",
      "cyrillic",
      "hangul",
      "arabic",
      "devanagari",
      "general",
    ]);
  });

  it("offers only commonly translated languages in the picker", () => {
    expect(COMMON_OCR_SOURCE_LANGUAGES.some(({ id }) => id === "ru")).toBe(true);
    expect(COMMON_OCR_SOURCE_LANGUAGES.some(({ id }) => id === "ar")).toBe(true);
    expect(COMMON_OCR_SOURCE_LANGUAGES.some(({ id }) => id === "hi")).toBe(true);
    expect(
      COMMON_OCR_SOURCE_LANGUAGES.some(({ id }) => id === "sr-Cyrl"),
    ).toBe(true);
    expect(COMMON_OCR_SOURCE_LANGUAGES.some(({ id }) => id === "ab")).toBe(
      false,
    );
    expect(resolveOcrSourceLanguage("ab").id).toBe("auto");
  });
});

describe("manga OCR provider", () => {
  it("offers only the languages its recognizer can read", () => {
    const ids = ocrSourceLanguagesForProvider("paddle-manga").map(({ id }) => id);
    expect(ids).toContain("auto");
    expect(ids).toContain("ja");
    expect(ids).toContain("en");
    expect(ids).not.toContain("ru");
    expect(ids).not.toContain("ko");
    expect(ocrSourceLanguagesForProvider("paddle")).toBe(
      COMMON_OCR_SOURCE_LANGUAGES,
    );
  });

  it("swaps the general recognizer for the manga one", () => {
    expect(resolveOcrModelIdForSourceLanguage("ja", "paddle-manga")).toBe(
      "v6-manga",
    );
    expect(resolveOcrModelIdForSourceLanguage("auto", "paddle-manga")).toBe(
      "v6-manga",
    );
    expect(resolveOcrModelIdForSourceLanguage("ja", "paddle")).toBe("v6-multi");
    expect(resolveOcrModelDir("v6-manga")).toBe("assets/ocr/ppocrv6-manga/");
  });

  it("falls back to Auto for a language the manga recognizer can't read", () => {
    expect(resolveOcrSourceLanguage("ru", "paddle-manga").id).toBe("auto");
    expect(resolveOcrModelIdForSourceLanguage("ru", "paddle-manga")).toBe(
      "v6-manga",
    );
  });

  it("keeps the manga model alone in Auto", () => {
    expect(autoOcrModels("paddle").map(({ id }) => id)).toEqual([
      "v6-multi",
      "cyrillic-v5",
      "korean-v5",
      "arabic-v5",
      "devanagari-v5",
    ]);
    expect(autoOcrModels("paddle-manga").map(({ id }) => id)).toEqual([
      "v6-manga",
    ]);
  });
});
