import { toGoogleCode } from "../translation/google";

const BATCHEXECUTE_URL =
  "https://translate.google.com/_/TranslateWebserverUi/data/batchexecute";
const TTS_RPC_ID = "jQ1olc";
const TTS_CHAR_LIMIT = 200;

export interface GoogleTtsConfig {
  fetchImpl?: typeof fetch;
}

export async function speakText(
  text: string,
  lang: string,
  config: GoogleTtsConfig = {},
): Promise<string[]> {
  if (!text) {
    return [];
  }

  const chunks = splitTextForTts(text, TTS_CHAR_LIMIT);
  const calls = chunks.map((chunk, index) => [
    TTS_RPC_ID,
    JSON.stringify([chunk, toGoogleCode(lang), false]),
    null,
    index.toString(36),
  ]);
  const params = new URLSearchParams({
    rpcids: TTS_RPC_ID,
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
  const fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const response = await fetchImpl(`${BATCHEXECUTE_URL}?${params.toString()}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    credentials: "omit",
    body: `f.req=${encodeURIComponent(JSON.stringify([calls]))}&`,
  });

  if (!response.ok) {
    throw new Error(`Google TTS request failed (HTTP ${response.status}).`);
  }

  return parseSpeakResponse(await response.text(), chunks.length);
}

export function splitTextForTts(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    const slice = remaining.slice(0, maxLength);
    let breakAt = -1;
    for (const separator of [". ", "。", "! ", "? ", "？", "！", "\n"]) {
      const index = slice.lastIndexOf(separator);
      if (index > breakAt) {
        breakAt = index + separator.length;
      }
    }
    if (breakAt <= 0) {
      breakAt = slice.lastIndexOf(" ");
    }
    if (breakAt <= 0) {
      breakAt = maxLength;
    }

    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt);
  }

  return chunks;
}

export function parseSpeakResponse(
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
      if (
        !Array.isArray(frame) ||
        frame[0] !== "wrb.fr" ||
        frame[1] !== TTS_RPC_ID ||
        typeof frame[2] !== "string"
      ) {
        continue;
      }
      const index = parseInt(String(frame[frame.length - 1]), 36);
      if (!Number.isInteger(index) || index < 0 || index >= expectedCount) {
        continue;
      }

      try {
        const payload: unknown = JSON.parse(frame[2]);
        const audio = Array.isArray(payload) ? payload[0] : undefined;
        if (typeof audio === "string") {
          results[index] = audio;
        }
      } catch {
        continue;
      }
    }
  }

  return results.filter(Boolean);
}
