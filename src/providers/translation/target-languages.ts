import type { LangCode } from "../../shared/types";

// Curated target languages offered by the remote providers (Google, LLM), as
// app language codes. Curated to standard ISO 639-1 codes (plus zh-Hans/
// zh-Hant) so Intl.DisplayNames in the UI renders proper names; the UI sorts
// them, so order here doesn't matter.
export const COMMON_TARGET_LANGUAGES: readonly LangCode[] = [
  "af",
  "sq",
  "am",
  "ar",
  "hy",
  "az",
  "eu",
  "be",
  "bn",
  "bs",
  "bg",
  "my",
  "ca",
  "zh-Hans",
  "zh-Hant",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "et",
  "tl",
  "fi",
  "fr",
  "ka",
  "de",
  "el",
  "gu",
  "ht",
  "he",
  "hi",
  "hu",
  "is",
  "id",
  "ga",
  "it",
  "ja",
  "kn",
  "kk",
  "km",
  "ko",
  "lo",
  "lv",
  "lt",
  "mk",
  "ms",
  "ml",
  "mr",
  "mn",
  "ne",
  "no",
  "ps",
  "fa",
  "pl",
  "pt",
  "pa",
  "ro",
  "ru",
  "sr",
  "si",
  "sk",
  "sl",
  "so",
  "es",
  "sw",
  "sv",
  "ta",
  "te",
  "th",
  "tr",
  "uk",
  "ur",
  "uz",
  "vi",
  "cy",
  "zu",
];

// Languages supported by DeepL, plus its regional target variants.
export const DEEPL_TARGET_LANGUAGES: readonly LangCode[] = [
  ...COMMON_TARGET_LANGUAGES.filter(
    (code) => !["am", "kn", "km", "lo", "si", "so"].includes(code),
  ),
  "en-US", "en-GB", "pt-BR", "pt-PT",
];

export function translationTargetLanguages(providerId: string): readonly LangCode[] {
  return providerId === "deepl" ? DEEPL_TARGET_LANGUAGES : COMMON_TARGET_LANGUAGES;
}

export function resolveTargetLanguage(
  selected: LangCode,
  supported: readonly LangCode[],
): LangCode {
  if (supported.includes(selected)) return selected;

  const equivalent: Record<string, string> = {
    "zh-CN": "zh-Hans",
    "zh-SG": "zh-Hans",
    "zh-TW": "zh-Hant",
    "zh-HK": "zh-Hant",
    "zh-MO": "zh-Hant",
  };
  const base = selected.split("-")[0];
  const candidates = [equivalent[selected], base];
  if (base === "en") candidates.push("en-US", "en-GB");
  if (base === "pt") candidates.push("pt-PT", "pt-BR");
  const mapped = candidates.find((code) => code && supported.includes(code));
  if (mapped) return mapped;

  return supported.find((code) => code === "en" || code === "en-US" || code === "en-GB") ?? "en";
}
