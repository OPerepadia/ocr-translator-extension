import { describe, expect, it, vi } from "vitest";
import {
  parseSpeakResponse,
  speakText,
  splitTextForTts,
} from "./google";

function response(audioChunks: Array<string | null>): string {
  const frames = audioChunks.map((audio, index) => [
    "wrb.fr",
    "jQ1olc",
    audio === null ? null : JSON.stringify([audio]),
    null,
    index.toString(36),
  ]);
  return `)]}'\n\n${JSON.stringify(frames)}\n`;
}

describe("splitTextForTts", () => {
  it("splits long text without changing it", () => {
    const text = "First sentence. Second sentence. Third sentence.";
    const chunks = splitTextForTts(text, 25);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 25)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("hard-splits text without whitespace", () => {
    expect(splitTextForTts("a".repeat(300), 200)).toEqual([
      "a".repeat(200),
      "a".repeat(100),
    ]);
  });
});

describe("parseSpeakResponse", () => {
  it("returns audio chunks in their request order", () => {
    const frames = [
      ["wrb.fr", "jQ1olc", JSON.stringify(["SECOND"]), null, "1"],
      ["wrb.fr", "jQ1olc", JSON.stringify(["FIRST"]), null, "0"],
    ];

    expect(parseSpeakResponse(`)]}'\n\n${JSON.stringify(frames)}`, 2)).toEqual([
      "FIRST",
      "SECOND",
    ]);
  });

  it("ignores missing and malformed frames", () => {
    expect(parseSpeakResponse(response(["AUDIO", null]), 2)).toEqual([
      "AUDIO",
    ]);
    expect(parseSpeakResponse(")]}'\n\n[malformed", 1)).toEqual([]);
  });
});

describe("speakText", () => {
  it("calls the Google TTS RPC without credentials", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => response(["AUDIO"]),
    })) as unknown as typeof fetch;

    await expect(
      speakText("Hello", "EN", { fetchImpl }),
    ).resolves.toEqual(["AUDIO"]);

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(String(url)).toContain("translate.google.com");
    expect(String(url)).toContain("rpcids=jQ1olc");
    expect(init).toMatchObject({ method: "POST", credentials: "omit" });
    const encoded = String(init?.body).slice(
      "f.req=".length,
      String(init?.body).lastIndexOf("&"),
    );
    const calls = JSON.parse(decodeURIComponent(encoded))[0] as string[][];
    expect(JSON.parse(calls[0][1])).toEqual(["Hello", "en", false]);
  });

  it("maps app language codes to Google language codes", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const encoded = String(init?.body).slice(
        "f.req=".length,
        String(init?.body).lastIndexOf("&"),
      );
      const calls = JSON.parse(decodeURIComponent(encoded))[0] as string[][];
      expect(JSON.parse(calls[0][1])).toEqual(["你好", "zh-CN", false]);
      return {
        ok: true,
        status: 200,
        text: async () => response(["AUDIO"]),
      };
    }) as unknown as typeof fetch;

    await speakText("你好", "zh-Hans", { fetchImpl });
  });

  it("throws on an HTTP failure", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => "",
    })) as unknown as typeof fetch;

    await expect(speakText("Hello", "en", { fetchImpl })).rejects.toThrow(
      /HTTP 429/,
    );
  });
});
