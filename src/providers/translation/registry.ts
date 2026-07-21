import { createGoogleTranslationProvider } from "./google";
import { createOpenAiTranslationProvider } from "./openai";
import type { TranslationProviderFactory } from "./types";

export const translationRegistry = {
  google: createGoogleTranslationProvider,
  openai: createOpenAiTranslationProvider,
} satisfies Record<string, TranslationProviderFactory>;

export type TranslationProviderId = keyof typeof translationRegistry;
