import type { LangCode } from "../../shared/types";
import { t } from "../../shared/i18n";
import { COMMON_TARGET_LANGUAGES } from "./target-languages";
import { RemoteTranslationError, type TranslationProvider } from "./types";

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
// The older single-shot endpoint. Used when batchexecute answers with a body
// that has no translation in it: that used to be reported as success and the
// overlay painted the original line in the translation view.
const SINGLE_URL = "https://translate.googleapis.com/translate_a/single";
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

      const translateLines = async (fromCode: string): Promise<string> => {
        const translatedByIndex = new Map<number, string>();
        for (let offset = 0; offset < nonBlank.length; offset += BATCH_LIMIT) {
          signal?.throwIfAborted();
          const batch = nonBlank.slice(offset, offset + BATCH_LIMIT);
          const translations = await translateBatch(
            batch.map((entry) => entry.line),
            fromCode,
            to,
            fetchImpl,
            timeoutMs,
            signal,
          );
          batch.forEach((entry, i) => {
            translatedByIndex.set(entry.index, translations[i]);
          });
        }
        return lines
          .map((line, index) => translatedByIndex.get(index) ?? line)
          .join("\n");
      };

      let text = await translateLines(from);
      // A wrong source guess (the caption was labeled Esperanto) makes Google
      // echo the original into the translation. Ask once more with detection
      // left to Google.
      if (
        from !== "auto" &&
        from !== to &&
        sameWriting(text, input.text)
      ) {
        text = await translateLines("auto");
      }

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

  let parsed: string[] | undefined;
  try {
    const raw = await fetchText(
      `${BATCHEXECUTE_URL}?${params.toString()}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        // Don't attach the user's Google cookies to the request.
        credentials: "omit",
        body,
      },
      fetchImpl,
      timeoutMs,
      signal,
    );
    parsed = parseBatchResponse(raw, texts.length);
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    // A stall has already waited out the timeout; don't start a second one.
    if (
      error instanceof RemoteTranslationError &&
      error.message ===
        t(
          "errorGoogleTranslateTimeout",
          String(Math.round(timeoutMs / 1000)),
        )
    ) {
      throw error;
    }
    parsed = undefined;
  }

  // A 200 with no translation used to be treated as success, and the overlay
  // then drew the original line. Ask the single-shot endpoint before giving up.
  if (!parsed || parsed.some((line) => line.trim() === "")) {
    const fallback = await translateLinesWithSingle(
      texts,
      from,
      to,
      fetchImpl,
      timeoutMs,
      signal,
    );
    if (fallback.some((line) => line.trim() === "")) {
      throw new RemoteTranslationError(t("errorGoogleTranslateEmpty"));
    }
    return fallback;
  }

  return parsed;
}

/** One line per request, so a merged paragraph can't be assigned to the wrong row. */
async function translateLinesWithSingle(
  texts: string[],
  from: string,
  to: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const results: string[] = [];
  for (const text of texts) {
    signal?.throwIfAborted();
    const params = new URLSearchParams({
      client: "gtx",
      sl: from,
      tl: to,
      dt: "t",
      q: text,
    });
    const raw = await fetchText(
      `${SINGLE_URL}?${params.toString()}`,
      { method: "GET", credentials: "omit" },
      fetchImpl,
      timeoutMs,
      signal,
    );
    results.push(parseSingleResponse(raw));
  }
  return results;
}

/** `[[["translated", "source", ...], ...], ...]`. Join the translated pieces. */
function parseSingleResponse(raw: string): string {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return "";
  }
  const segments = at(data, 0);
  if (!Array.isArray(segments)) {
    return "";
  }
  return segments
    .map((segment) => at(segment, 0))
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join("")
    .replace(/\n$/, "");
}

async function fetchText(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
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
    response = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    if (timedOut) {
      throw new RemoteTranslationError(
        t("errorGoogleTranslateTimeout", String(Math.round(timeoutMs / 1000))),
      );
    }
    throw new RemoteTranslationError(
      t("errorGoogleTranslateUnreachable", describeError(error)),
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }

  if (!response.ok) {
    throw new RemoteTranslationError(
      t("errorGoogleTranslateRequest", String(response.status)),
    );
  }
  return response.text();
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

/** Ignore surrounding space and blank lines so an echoed caption still matches. */
function sameWriting(a: string, b: string): boolean {
  const normalize = (value: string): string =>
    value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");
  return normalize(a) === normalize(b);
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
