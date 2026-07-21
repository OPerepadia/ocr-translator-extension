/** Map browser language detection output to the language codes used by providers. */
export function normalizeDetectedLanguage(code: string): string | undefined {
  const trimmed = code.trim();
  if (!trimmed || trimmed === "und") {
    return undefined;
  }

  const [language, ...subtags] = trimmed.split("-");
  const base = language.toLowerCase();
  if (base !== "zh") {
    return base;
  }

  const normalizedSubtags = subtags.map((subtag) => subtag.toLowerCase());
  if (
    normalizedSubtags.includes("hant") ||
    normalizedSubtags.includes("tw") ||
    normalizedSubtags.includes("hk") ||
    normalizedSubtags.includes("mo")
  ) {
    return "zh-Hant";
  }

  return "zh-Hans";
}
