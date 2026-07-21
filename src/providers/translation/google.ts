import type { LangCode } from "../../shared/types";
import { RemoteTranslationError } from "./errors";
import { COMMON_TARGET_LANGUAGES } from "./target-languages";
import type { TranslationProvider } from "./types";

// Google Translate via the unofficial "batchexecute" endpoint at
// translate.google.com — the same gateway the web UI uses, with no API key.
//
// This is a REMOTE provider: the recognized text is sent to Google to be
// translated. It is the default provider, so the add-on declares website-
// content data collection as required (see wxt.config.ts and review notes).
//
// "batchexecute" is a generic RPC gateway; each service has a short opaque RPC
// id. Text translation is 'MkEWBc'. These ids are undocumented but have been
// stable for years (google-translate-api-x and similar rely on them) and could
// change without notice.

const BATCHEXECUTE_URL =
  "https://translate.google.com/_/TranslateWebserverUi/data/batchexecute";
const TRANSLATE_RPC_ID = "MkEWBc";
// Texts per request. A large selection is split into several requests rather
// than one oversized body.
const BATCH_LIMIT = 50;
// Per-request timeout. fetch has no timeout of its own, so a stalled response
// would otherwise hang indefinitely; this bounds each request (translation is a
// small, fast call, so a generous limit is still well within reason).
const DEFAULT_TIMEOUT_MS = 15_000;

export interface GoogleProviderConfig {
  /** Defaults to globalThis.fetch; injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

export function createGoogleTranslationProvider(
  rawConfig?: unknown,
): TranslationProvider {
  const config = (rawConfig ?? {}) as GoogleProviderConfig;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    id: "google",

    listTargetLanguages() {
      return [...COMMON_TARGET_LANGUAGES];
    },

    async translate(input, signal) {
      signal?.throwIfAborted();

      const targetLang = input.targetLang;
      const to = toGoogleCode(targetLang);
      // Google can auto-detect the source, so an unknown/"auto" source is fine.
      const from =
        !input.sourceLang || input.sourceLang === "auto"
          ? "auto"
          : toGoogleCode(input.sourceLang);

      // Translate line by line so the recognized text's layout survives: the OCR
      // step joins rows with "\n", and sending the whole block at once would let
      // Google reflow it into one paragraph. Blank lines are kept as-is.
      const lines = input.text.split("\n");
      const nonBlank = lines
        .map((line, index) => ({ line, index }))
        .filter((entry) => entry.line.trim().length > 0);

      const translatedByIndex = new Map<number, string>();
      for (let offset = 0; offset < nonBlank.length; offset += BATCH_LIMIT) {
        signal?.throwIfAborted();
        const batch = nonBlank.slice(offset, offset + BATCH_LIMIT);
        const translations = await translateBatch(
          batch.map((entry) => entry.line),
          from,
          to,
          fetchImpl,
          timeoutMs,
          signal,
        );
        batch.forEach((entry, i) => {
          // Fall back to the original line if Google dropped this entry.
          translatedByIndex.set(entry.index, translations[i] || entry.line);
        });
      }

      const text = lines
        .map((line, index) => translatedByIndex.get(index) ?? line)
        .join("\n");

      return {
        text,
        // Echo back the source only when it was known; for "auto" we don't parse
        // Google's detected language out of the response.
        sourceLang:
          input.sourceLang && input.sourceLang !== "auto"
            ? input.sourceLang
            : undefined,
        targetLang,
      };
    },
  };
}

/** Send one batchexecute request and return the translations in input order. */
async function translateBatch(
  texts: string[],
  from: string,
  to: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string[]> {
  // Each text becomes one RPC call; the base-36 index lets us match responses
  // back to inputs regardless of the order Google returns them in.
  const calls = texts.map((text, index) => [
    TRANSLATE_RPC_ID,
    JSON.stringify([[text, from, to, false], [null]]),
    null,
    index.toString(36),
  ]);

  const params = new URLSearchParams({
    rpcids: TRANSLATE_RPC_ID,
    "source-path": "/",
    "f.sid": "",
    bl: "",
    hl: "en-US",
    "soc-app": "1",
    "soc-platform": "1",
    "soc-device": "1",
    _reqid: String(Math.floor(1000 + Math.random() * 9000)),
    rt: "c",
  });

  const body = `f.req=${encodeURIComponent(JSON.stringify([calls]))}&`;

  // fetch has no timeout, so bound the request with our own controller: abort it
  // when the timeout fires, and also forward the caller's abort (cancel) to it.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", forwardAbort, { once: true });
    }
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(`${BATCHEXECUTE_URL}?${params.toString()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      // Don't attach the user's Google cookies to the request.
      credentials: "omit",
      body,
      signal: controller.signal,
    });
  } catch (error) {
    // A real cancel by the caller propagates untouched so callers see an
    // AbortError; our own timeout becomes a (retryable) RemoteTranslationError.
    if (signal?.aborted) {
      throw error;
    }
    if (timedOut) {
      throw new RemoteTranslationError(
        `Google Translate timed out after ${Math.round(timeoutMs / 1000)}s. ` +
          "Try again, or switch to the local translation provider.",
      );
    }
    throw new RemoteTranslationError(
      `Couldn't reach Google Translate (${describeError(error)}). Check your ` +
        "internet connection, or switch to the local translation provider.",
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }

  if (!response.ok) {
    throw new RemoteTranslationError(
      `Google Translate request failed (HTTP ${response.status}). Try again ` +
        "later, or switch to the local translation provider.",
    );
  }

  return parseBatchResponse(await response.text(), texts.length);
}

/**
 * Parse a batchexecute response into `expectedCount` translations by index.
 *
 * Shape: a ")]}'" junk prefix, then newline-separated frames. Translation
 * frames look like ["wrb.fr", "MkEWBc", "<json>", ..., "<base36-index>"], where
 * the trailing element echoes the index we sent and the JSON payload holds the
 * translated sentence. Anything that doesn't match is skipped, so a format
 * change degrades to blank entries (then the original line) instead of throwing.
 */
export function parseBatchResponse(
  raw: string,
  expectedCount: number,
): string[] {
  const results = new Array<string>(expectedCount).fill("");

  for (const line of raw.split("\n")) {
    if (line.charAt(0) !== "[") {
      continue;
    }
    let frames: unknown;
    try {
      frames = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(frames)) {
      continue;
    }

    for (const frame of frames) {
      if (!Array.isArray(frame) || frame[0] !== "wrb.fr") {
        continue;
      }
      const payload = frame[2];
      if (typeof payload !== "string") {
        continue;
      }
      const index = parseInt(String(frame[frame.length - 1]), 36);
      if (!Number.isInteger(index) || index < 0 || index >= expectedCount) {
        continue;
      }
      results[index] = extractTranslatedText(payload);
    }
  }

  return results;
}

/** Pull the translated text out of one frame's JSON payload. */
function extractTranslatedText(payload: string): string {
  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    return "";
  }

  // The sentence lives at data[1][0][0]: its chunked form at [5] (preferred,
  // joined with spaces), else the whole string at [0].
  const sentence = at(at(at(data, 1), 0), 0);
  const chunks = at(sentence, 5);
  if (Array.isArray(chunks)) {
    return chunks
      .map((chunk) => at(chunk, 0))
      .filter((part): part is string => typeof part === "string" && part !== "")
      .join(" ");
  }

  const whole = at(sentence, 0);
  return typeof whole === "string" ? whole : "";
}

/** Index into a value only if it's an array; returns undefined otherwise. */
function at(value: unknown, index: number): unknown {
  return Array.isArray(value) ? value[index] : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Map the app's canonical language code to the code Google's endpoint expects.
// Most match ISO 639-1 directly; the differences are Chinese (the app
// distinguishes scripts as zh-Hans/zh-Hant, Google uses region tags) handled
// here, plus a generic "drop the region subtag" fallback (e.g. pt-BR -> pt).
const GOOGLE_CODE_OVERRIDES: Record<string, string> = {
  "zh-hans": "zh-CN",
  "zh-hant": "zh-TW",
  zh: "zh-CN",
};

export function toGoogleCode(code: LangCode): string {
  const lower = code.toLowerCase();
  return GOOGLE_CODE_OVERRIDES[lower] ?? lower.split("-")[0];
}
