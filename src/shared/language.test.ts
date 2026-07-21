import { describe, expect, it } from "vitest";
import { normalizeDetectedLanguage } from "./language";

describe("normalizeDetectedLanguage", () => {
  it("keeps ordinary language codes simple", () => {
    expect(normalizeDetectedLanguage("de-DE")).toBe("de");
    expect(normalizeDetectedLanguage("EN")).toBe("en");
  });

  it("maps Chinese detector output to canonical script codes", () => {
    expect(normalizeDetectedLanguage("zh")).toBe("zh-Hans");
    expect(normalizeDetectedLanguage("zh-Hans")).toBe("zh-Hans");
    expect(normalizeDetectedLanguage("zh-CN")).toBe("zh-Hans");
    expect(normalizeDetectedLanguage("zh-Hant")).toBe("zh-Hant");
    expect(normalizeDetectedLanguage("zh-TW")).toBe("zh-Hant");
    expect(normalizeDetectedLanguage("zh-HK")).toBe("zh-Hant");
  });

  it("ignores undetermined languages", () => {
    expect(normalizeDetectedLanguage("und")).toBeUndefined();
    expect(normalizeDetectedLanguage("")).toBeUndefined();
  });
});
