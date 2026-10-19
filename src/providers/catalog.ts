import { COMMON_TARGET_LANGUAGES } from "./translation/target-languages";

export const OCR_PROVIDERS = [
  {
    id: "paddle",
    kind: "local",
  },
  {
    id: "paddle-manga",
    kind: "local",
  },
] as const;

export const DEFAULT_OCR_PROVIDER_ID = "paddle";

// Same engine as "paddle", with the manga-tuned recognizer in place of the
// general one. Its dictionary matches PP-OCRv6, so it reads the same languages.
const MANGA_OCR_PROVIDER_ID = "paddle-manga";

// Recognizer model variants the user can switch between in the panel. Each is a
// folder of model files under src/public/. The detector is script-agnostic, so
// the Cyrillic variant reuses ppocrv6-small's detector via a relative path in
// its manifest; only the recognizer + dict differ. The manga variant ships its
// own detector.
export const OCR_MODELS = [
  {
    id: "v6-multi",
    modelDir: "assets/ocr/ppocrv6-small/",
    script: "general",
  },
  {
    id: "cyrillic-v5",
    modelDir: "assets/ocr/cyrillic-v5/",
    script: "cyrillic",
  },
  {
    id: "korean-v5",
    modelDir: "assets/ocr/korean-v5/",
    script: "hangul",
  },
  {
    id: "arabic-v5",
    modelDir: "assets/ocr/arabic-v5/",
    script: "arabic",
  },
  {
    id: "devanagari-v5",
    modelDir: "assets/ocr/devanagari-v5/",
    script: "devanagari",
  },
  {
    id: "v6-manga",
    modelDir: "assets/ocr/ppocrv6-manga/",
    script: "general",
  },
] as const;

export type OcrModelId = (typeof OCR_MODELS)[number]["id"];

export const DEFAULT_OCR_MODEL_ID: OcrModelId = "v6-multi";

export interface OcrSourceLanguage {
  id: string;
  sourceLang: string | "auto";
  modelId: OcrModelId;
}

function languages(
  modelId: OcrModelId,
  ids: readonly string[],
  sourceLanguages: Readonly<Record<string, string>> = {},
): OcrSourceLanguage[] {
  return ids.map((id) => ({
    id,
    sourceLang: sourceLanguages[id] ?? id,
    modelId,
  }));
}

export const OCR_SOURCE_LANGUAGES: readonly OcrSourceLanguage[] = [
  {
    id: "auto",
    sourceLang: "auto",
    modelId: DEFAULT_OCR_MODEL_ID,
  },
  ...languages("v6-multi", [
    "af", "sq", "az", "eu", "bs", "ca", "zh-Hans", "zh-Hant", "hr",
    "cs", "da", "nl", "en", "et", "fi", "fr", "gl", "de", "hu",
    "is", "id", "ga", "it", "ja", "ku", "la", "lv", "lt", "lb",
    "ms", "mt", "mi", "no", "oc", "pl", "pt", "qu", "ro", "rm",
    "sr-Latn", "sk", "sl", "es", "sw", "sv", "tl", "tr", "uz", "vi",
    "cy",
  ], { "sr-Latn": "sr" }),
  ...languages("cyrillic-v5", [
    "ab", "ady", "av", "ba", "be", "bg", "bua", "ce", "cv", "dar",
    "inh", "kbd", "xal", "kaa", "kk", "kv", "ky", "lki", "lez", "mk",
    "mhr", "mo-Cyrl", "mn", "os", "ru", "sah", "sr-Cyrl", "tg", "tt",
    "tab", "tyv", "udm", "uk",
  ], { "mo-Cyrl": "ro", "sr-Cyrl": "sr" }),
  ...languages("korean-v5", ["ko"]),
  ...languages("arabic-v5", ["ar", "fa", "ps", "ur"]),
  ...languages("devanagari-v5", ["hi", "mr", "ne"]),
];

export const COMMON_OCR_SOURCE_LANGUAGES = OCR_SOURCE_LANGUAGES.filter(
  ({ id }) =>
    id === "auto" ||
    COMMON_TARGET_LANGUAGES.includes(id) ||
    COMMON_TARGET_LANGUAGES.includes(id.split("-")[0]),
);

/** Source languages the OCR provider offers in the pickers. */
export function ocrSourceLanguagesForProvider(
  providerId: string | undefined,
): readonly OcrSourceLanguage[] {
  return providerId === MANGA_OCR_PROVIDER_ID
    ? COMMON_OCR_SOURCE_LANGUAGES.filter(
        ({ modelId }) => modelId === DEFAULT_OCR_MODEL_ID,
      )
    : COMMON_OCR_SOURCE_LANGUAGES;
}

export function findOcrSourceLanguage(
  id: string | undefined,
  providerId?: string,
): OcrSourceLanguage | undefined {
  return ocrSourceLanguagesForProvider(providerId).find(
    (language) => language.id === id,
  );
}

/** Falls back to Auto for an unknown language or one the provider can't read. */
export function resolveOcrSourceLanguage(
  id: string | undefined,
  providerId?: string,
): OcrSourceLanguage {
  return (
    findOcrSourceLanguage(id, providerId) ??
    COMMON_OCR_SOURCE_LANGUAGES.find((language) => language.id === "auto")!
  );
}

export function resolveOcrModelIdForSourceLanguage(
  id: string | undefined,
  providerId?: string,
): OcrModelId {
  const { modelId } = resolveOcrSourceLanguage(id, providerId);
  return providerId === MANGA_OCR_PROVIDER_ID && modelId === DEFAULT_OCR_MODEL_ID
    ? "v6-manga"
    : modelId;
}

/** Recognizers Auto chooses from by detected script. The manga provider has
 * only its own, so Auto reports text in other scripts as unsupported. */
export function autoOcrModels(providerId: string | undefined) {
  return providerId === MANGA_OCR_PROVIDER_ID
    ? OCR_MODELS.filter(({ id }) => id === "v6-manga")
    : OCR_MODELS.filter(({ id }) => id !== "v6-manga");
}

export function resolveTranslationSourceLanguage(
  id: string | undefined,
  providerId?: string,
): string | "auto" {
  return resolveOcrSourceLanguage(id, providerId).sourceLang;
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
    kind: "remote",
  },
  {
    id: "deepl",
    kind: "remote",
  },
  {
    id: "openai",
    kind: "remote",
  },
] as const;
