import type { LangCode } from "@/shared/types";

export interface LabeledOption {
  id: string;
  label: string;
  icon?: string;
}

export interface ContentControls {
  targetLanguages: LangCode[];
  ocrSourceLanguages: LabeledOption[];
  currentOcrSourceLanguageId: string;
  ocrProviders: LabeledOption[];
  currentOcrProviderId?: string;
  translationProviders: LabeledOption[];
  currentTranslationProviderId?: string;
  selectTargetLanguage(targetLang: LangCode): void;
  selectOcrSourceLanguage(sourceLang: LangCode | "auto"): void;
  selectOcrProvider(providerId: string): void;
  selectTranslationProvider(providerId: string): void;
}
