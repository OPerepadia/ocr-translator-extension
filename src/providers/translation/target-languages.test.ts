import { describe, expect, it } from "vitest";
import { resolveTargetLanguage } from "./target-languages";

describe("resolveTargetLanguage", () => {
  it("keeps supported targets and maps regional and Chinese codes", () => {
    expect(resolveTargetLanguage("fr", ["en", "fr"])).toBe("fr");
    expect(resolveTargetLanguage("en-US", ["en", "fr"])).toBe("en");
    expect(resolveTargetLanguage("pt-BR", ["en", "pt"])).toBe("pt");
    expect(resolveTargetLanguage("pt-BR", ["en", "pt-PT"])).toBe("pt-PT");
    expect(resolveTargetLanguage("zh-TW", ["en", "zh-Hant"])).toBe("zh-Hant");
  });

  it("falls back to English when there is no equivalent", () => {
    expect(resolveTargetLanguage("am", ["en", "fr"])).toBe("en");
  });
});
