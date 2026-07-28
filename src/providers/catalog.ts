import { COMMON_TARGET_LANGUAGES } from "./translation/target-languages";

export const OCR_PROVIDERS = [
  {
    id: "paddle",
    label: "PP-OCR (local)",
    kind: "local",
  },
] as const;

// Recognizer model variants the user can switch between in the panel. Each is a
// folder of model files under src/public/. The detector is script-agnostic, so
// the Cyrillic variant reuses ppocrv6-small's detector via a relative path in
// its manifest; only the recognizer + dict differ.
export const OCR_MODELS = [
  {
    id: "v6-multi",
    label: "Latin / Chinese / Japanese",
    modelDir: "assets/ocr/ppocrv6-small/",
    script: "general",
  },
  {
    id: "cyrillic-v5",
    label: "Cyrillic",
    modelDir: "assets/ocr/cyrillic-v5/",
    script: "cyrillic",
  },
  {
    id: "korean-v5",
    label: "Korean",
    modelDir: "assets/ocr/korean-v5/",
    script: "hangul",
  },
  {
    id: "arabic-v5",
    label: "Arabic",
    modelDir: "assets/ocr/arabic-v5/",
    script: "arabic",
  },
  {
    id: "devanagari-v5",
    label: "Devanagari",
    modelDir: "assets/ocr/devanagari-v5/",
    script: "devanagari",
  },
] as const;

export type OcrModelId = (typeof OCR_MODELS)[number]["id"];

export const DEFAULT_OCR_MODEL_ID: OcrModelId = "v6-multi";

export interface OcrSourceLanguage {
  id: string;
  label: string;
  sourceLang: string | "auto";
  modelId: OcrModelId;
}

function languages(
  modelId: OcrModelId,
  entries: ReadonlyArray<readonly [id: string, label: string, sourceLang?: string]>,
): OcrSourceLanguage[] {
  return entries.map(([id, label, sourceLang]) => ({
    id,
    label,
    sourceLang: sourceLang ?? id,
    modelId,
  }));
}

export const OCR_SOURCE_LANGUAGES: readonly OcrSourceLanguage[] = [
  {
    id: "auto",
    label: "Auto",
    sourceLang: "auto",
    modelId: DEFAULT_OCR_MODEL_ID,
  },
  ...languages("v6-multi", [
    ["af", "Afrikaans"],
    ["sq", "Albanian"],
    ["az", "Azerbaijani"],
    ["eu", "Basque"],
    ["bs", "Bosnian"],
    ["ca", "Catalan"],
    ["zh-Hans", "Chinese (Simplified)"],
    ["zh-Hant", "Chinese (Traditional)"],
    ["hr", "Croatian"],
    ["cs", "Czech"],
    ["da", "Danish"],
    ["nl", "Dutch"],
    ["en", "English"],
    ["et", "Estonian"],
    ["fi", "Finnish"],
    ["fr", "French"],
    ["gl", "Galician"],
    ["de", "German"],
    ["hu", "Hungarian"],
    ["is", "Icelandic"],
    ["id", "Indonesian"],
    ["ga", "Irish"],
    ["it", "Italian"],
    ["ja", "Japanese"],
    ["ku", "Kurdish"],
    ["la", "Latin"],
    ["lv", "Latvian"],
    ["lt", "Lithuanian"],
    ["lb", "Luxembourgish"],
    ["ms", "Malay"],
    ["mt", "Maltese"],
    ["mi", "Maori"],
    ["no", "Norwegian"],
    ["oc", "Occitan"],
    ["pl", "Polish"],
    ["pt", "Portuguese"],
    ["qu", "Quechua"],
    ["ro", "Romanian"],
    ["rm", "Romansh"],
    ["sr-Latn", "Serbian (Latin)", "sr"],
    ["sk", "Slovak"],
    ["sl", "Slovenian"],
    ["es", "Spanish"],
    ["sw", "Swahili"],
    ["sv", "Swedish"],
    ["tl", "Tagalog"],
    ["tr", "Turkish"],
    ["uz", "Uzbek"],
    ["vi", "Vietnamese"],
    ["cy", "Welsh"],
  ]),
  ...languages("cyrillic-v5", [
    ["ab", "Abkhaz"],
    ["ady", "Adyghe"],
    ["av", "Avar"],
    ["ba", "Bashkir"],
    ["be", "Belarusian"],
    ["bg", "Bulgarian"],
    ["bua", "Buryat"],
    ["ce", "Chechen"],
    ["cv", "Chuvash"],
    ["dar", "Dargwa"],
    ["inh", "Ingush"],
    ["kbd", "Kabardian"],
    ["xal", "Kalmyk"],
    ["kaa", "Karakalpak"],
    ["kk", "Kazakh"],
    ["kv", "Komi"],
    ["ky", "Kyrgyz"],
    ["lki", "Lak"],
    ["lez", "Lezgin"],
    ["mk", "Macedonian"],
    ["mhr", "Mari"],
    ["mo-Cyrl", "Moldovan (Cyrillic)", "ro"],
    ["mn", "Mongolian"],
    ["os", "Ossetian"],
    ["ru", "Russian"],
    ["sah", "Sakha"],
    ["sr-Cyrl", "Serbian (Cyrillic)", "sr"],
    ["tg", "Tajik"],
    ["tt", "Tatar"],
    ["tab", "Tabasaran"],
    ["tyv", "Tuvan"],
    ["udm", "Udmurt"],
    ["uk", "Ukrainian"],
  ]),
  ...languages("korean-v5", [["ko", "Korean"]]),
  ...languages("arabic-v5", [
    ["ar", "Arabic"],
    ["fa", "Persian"],
    ["ps", "Pashto"],
    ["ur", "Urdu"],
  ]),
  ...languages("devanagari-v5", [
    ["hi", "Hindi"],
    ["mr", "Marathi"],
    ["ne", "Nepali"],
  ]),
];

export const COMMON_OCR_SOURCE_LANGUAGES = OCR_SOURCE_LANGUAGES.filter(
  ({ id }) =>
    id === "auto" ||
    COMMON_TARGET_LANGUAGES.includes(id) ||
    COMMON_TARGET_LANGUAGES.includes(id.split("-")[0]),
);

export function findOcrSourceLanguage(
  id: string | undefined,
): OcrSourceLanguage | undefined {
  return COMMON_OCR_SOURCE_LANGUAGES.find((language) => language.id === id);
}

export function resolveOcrSourceLanguage(
  id: string | undefined,
): OcrSourceLanguage {
  return (
    findOcrSourceLanguage(id) ??
    COMMON_OCR_SOURCE_LANGUAGES.find((language) => language.id === "auto")!
  );
}

export function resolveOcrModelIdForSourceLanguage(
  id: string | undefined,
): OcrModelId {
  return resolveOcrSourceLanguage(id).modelId;
}

export function resolveTranslationSourceLanguage(
  id: string | undefined,
): string | "auto" {
  return resolveOcrSourceLanguage(id).sourceLang;
}

/** Resolve a model id to its asset folder, falling back to the default. */
export function resolveOcrModelDir(modelId: string | undefined): string {
  return resolveOcrModel(modelId).modelDir;
}

export function resolveOcrModel(modelId: string | undefined) {
  const model =
    OCR_MODELS.find((entry) => entry.id === modelId) ??
    OCR_MODELS.find((entry) => entry.id === DEFAULT_OCR_MODEL_ID);
  return model!;
}

export const TRANSLATION_PROVIDERS = [
  {
    id: "google",
    label: "Google",
    kind: "remote",
  },
  {
    id: "openai",
    label: "LLM",
    kind: "remote",
  },
] as const;
