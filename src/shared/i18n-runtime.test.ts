import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyUiLocale,
  initializeI18n,
  t,
  uiDirection,
  uiLanguage,
} from "./i18n";

vi.mock("../public/_locales/en/messages.json", () => ({
  default: {
    greeting: { message: "Hello" },
    fallback: { message: "Fallback" },
    values: { message: "$2 / $1 / $1" },
  },
}));
vi.mock("../public/_locales/ja/messages.json", () => ({
  default: { greeting: { message: "こんにちは" } },
}));

afterEach(() => {
  applyUiLocale("auto");
  vi.unstubAllGlobals();
});

describe("UI locale override", () => {
  it("initializes from storage before returning", async () => {
    vi.stubGlobal("browser", {
      storage: { local: { get: async () => ({ uiLocale: "ja" }) } },
    });
    await expect(initializeI18n()).resolves.toBe("ja");
    expect(t("greeting")).toBe("こんにちは");
  });

  it("restores native browser messages, substitutions and direction", () => {
    const getMessage = vi.fn((key: string) => key === "@@bidi_dir" ? "rtl" : "Native");
    vi.stubGlobal("browser", {
      i18n: { getMessage, getUILanguage: () => "ar" },
    });
    applyUiLocale("en");
    expect(t("greeting")).toBe("Hello");
    expect(uiDirection()).toBe("ltr");
    applyUiLocale("auto");
    expect(t("greeting", ["sample"])).toBe("Native");
    expect(getMessage).toHaveBeenCalledWith("greeting", ["sample"]);
    expect(uiLanguage()).toBe("ar");
    expect(uiDirection()).toBe("rtl");
  });

  it("falls back to English and then the key without using the browser locale", () => {
    applyUiLocale("ja");
    expect(t("fallback")).toBe("Fallback");
    expect(t("missing")).toBe("missing");
    expect(t("toString")).toBe("toString");
  });

  it("substitutes repeated and reordered values without interpreting their content", () => {
    applyUiLocale("en");
    expect(t("values", ["$2", "sample"])).toBe("sample / $2 / $2");
    expect(t("values", "sample")).toBe(" / sample / sample");
    expect(t("values")).toBe(" /  / ");
  });

  it("normalizes the Chinese locale for language APIs", () => {
    applyUiLocale("zh_CN");
    expect(uiLanguage()).toBe("zh-CN");
    expect(uiDirection()).toBe("ltr");
    expect(() => new Intl.DisplayNames([uiLanguage()], { type: "language" })).not.toThrow();
  });
});
