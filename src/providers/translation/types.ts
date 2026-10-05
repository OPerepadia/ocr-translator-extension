import type {
  LangCode,
  PipelineTranslationResult,
} from "../../shared/types";

export class RemoteTranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteTranslationError";
  }
}

export interface TranslationProvider {
  readonly id: string;

  translate(
    input: TranslationInput,
    signal?: AbortSignal,
  ): Promise<TranslationResult>;

  preload?(pair: LanguagePair, signal?: AbortSignal): Promise<void>;

  dispose?(): Promise<void>;

  /** The languages this provider can translate into, as app language codes.
   * Used by the UI to offer a target-language choice. */
  listTargetLanguages?(): LangCode[];
}

export interface TranslationInput {
  text: string;
  sourceLang?: LangCode | "auto";
  targetLang: LangCode;
  format?: "plain" | "html";
  /** Source-language text that came just before `text`, such as the previous
   * subtitles. Providers that can use it to resolve what `text` means do so,
   * and none of them translate it. */
  context?: string[];
}

export interface TranslationResult extends PipelineTranslationResult {}

export interface LanguagePair {
  sourceLang: LangCode | "auto";
  targetLang: LangCode;
}

export interface TranslationProviderFactory<TConfig = unknown> {
  (config?: TConfig): TranslationProvider;
}
