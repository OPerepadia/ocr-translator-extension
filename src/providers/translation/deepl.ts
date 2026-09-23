import { fetchWithModifiedHeaders } from "../../shared/fetch-with-modified-headers";
import { t } from "../../shared/i18n";
import { normalizeDetectedLanguage } from "../../shared/language";
import type { Settings } from "../../shared/types";
import { DEEPL_TARGET_LANGUAGES } from "./target-languages";
import { RemoteTranslationError, type TranslationProvider } from "./types";

interface DeepLProviderConfig {
  deepl?: Settings["translation"]["deepl"];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const ENDPOINTS = {
  free: "https://api-free.deepl.com/v2/translate",
  pro: "https://api.deepl.com/v2/translate",
};
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 128 * 1024;

function targetCode(code: string): string {
  const lower = code.toLowerCase();
  const overrides: Record<string, string> = {
    en: "EN-US", pt: "PT-PT", no: "NB", zh: "ZH-HANS",
    "zh-cn": "ZH-HANS", "zh-tw": "ZH-HANT",
  };
  return overrides[lower] ?? code.toUpperCase();
}

function sourceCode(code: string): string {
  const base = code.toLowerCase().split("-")[0];
  return base === "no" ? "NB" : base.toUpperCase();
}

export function createDeepLTranslationProvider(rawConfig?: unknown): TranslationProvider {
  const config = (rawConfig ?? {}) as DeepLProviderConfig;
  const apiKey = config.deepl?.apiKey?.trim();
  const endpoint = ENDPOINTS[config.deepl?.plan === "pro" ? "pro" : "free"];
  const fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    id: "deepl",
    listTargetLanguages: () => [...DEEPL_TARGET_LANGUAGES],
    async translate(input, signal) {
      signal?.throwIfAborted();
      const lines = input.text.split("\n");
      const entries = lines.map((text, index) => ({ text, index }))
        .filter(({ text }) => text.trim());
      if (!entries.length) {
        return { text: input.text, targetLang: input.targetLang };
      }
      if (!apiKey) {
        throw new RemoteTranslationError(t("errorDeepLKeyRequired"));
      }
      const parameters = {
        target_lang: targetCode(input.targetLang),
        source_lang: input.sourceLang && input.sourceLang !== "auto"
          ? sourceCode(input.sourceLang) : undefined,
        preserve_formatting: true,
        ...(input.format === "html" ? { tag_handling: "html" } : {}),
      };
      const bodyFor = (batch: typeof entries) => JSON.stringify({
        ...parameters, text: batch.map(({ text }) => text),
      });
      const encoder = new TextEncoder();
      const batches: (typeof entries)[] = [];
      let batch: typeof entries = [];
      for (const entry of entries) {
        if (encoder.encode(bodyFor([entry])).length > MAX_BODY_BYTES) {
          throw new RemoteTranslationError(t("errorDeepLTooLarge"));
        }
        if (batch.length === 50 || encoder.encode(bodyFor([...batch, entry])).length > MAX_BODY_BYTES) {
          batches.push(batch);
          batch = [];
        }
        batch.push(entry);
      }
      if (batch.length) batches.push(batch);

      let detectedSource: string | undefined;
      for (const batch of batches) {
        signal?.throwIfAborted();
        const controller = new AbortController();
        const forwardAbort = () => controller.abort(signal?.reason);
        signal?.addEventListener("abort", forwardAbort, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
        try {
          // DeepL rejects requests carrying a browser Origin header.
          const response = await fetchWithModifiedHeaders(endpoint, {
            method: "POST",
            headers: {
              Authorization: `DeepL-Auth-Key ${apiKey}`,
              "Content-Type": "application/json",
            },
            credentials: "omit",
            redirect: "error",
            body: bodyFor(batch),
            signal: controller.signal,
          }, [{ header: "origin", operation: "remove" }], fetchImpl);
          if (!response.ok) {
            if (response.status === 403) throw new RemoteTranslationError(t("errorDeepLAuth"));
            if (response.status === 456) throw new RemoteTranslationError(t("errorDeepLQuota"));
            if (response.status === 429) throw new RemoteTranslationError(t("errorDeepLRateLimit"));
            throw new RemoteTranslationError(t("errorDeepLRequest", String(response.status)));
          }
          let data;
          try {
            data = await response.json();
          } catch (error) {
            if (controller.signal.aborted) throw error;
            throw new RemoteTranslationError(t("errorDeepLResponse"));
          }
          if (!Array.isArray(data?.translations) || data.translations.length !== batch.length ||
              !data.translations.every((entry: unknown) => entry !== null &&
                typeof entry === "object" && "text" in entry && typeof entry.text === "string")) {
            throw new RemoteTranslationError(t("errorDeepLResponse"));
          }
          batch.forEach((entry, index) => {
            const translated = data.translations[index];
            lines[entry.index] = translated.text;
            if (!detectedSource && typeof translated.detected_source_language === "string") {
              detectedSource = translated.detected_source_language === "NB"
                ? "no" : normalizeDetectedLanguage(translated.detected_source_language);
            }
          });
        } catch (error) {
          signal?.throwIfAborted();
          if (timedOut) throw new RemoteTranslationError(t("errorDeepLTimeout"));
          if (error instanceof RemoteTranslationError) throw error;
          throw new RemoteTranslationError(t("errorDeepLUnreachable"));
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", forwardAbort);
        }
      }
      return {
        text: lines.join("\n"),
        sourceLang: input.sourceLang && input.sourceLang !== "auto" ? input.sourceLang : detectedSource,
        targetLang: input.targetLang,
      };
    },
  };
}
