import type { LangCode } from "@/shared/types";

export interface LabeledOption {
  id: string;
  label: string;
}

export interface ContentControls {
  targetLanguages: LangCode[];
  ocrSourceLanguages: LabeledOption[];
  currentOcrSourceLanguageId: string;
  translationProviders: LabeledOption[];
  currentTranslationProviderId?: string;
  selectTargetLanguage(targetLang: LangCode): void;
  selectOcrSourceLanguage(sourceLang: LangCode | "auto"): void;
  selectTranslationProvider(providerId: string): void;
}
