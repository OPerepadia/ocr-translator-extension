import { describe, expect, it, vi } from "vitest";
import { RemoteTranslationError } from "./types";
import {
  createGoogleTranslationProvider,
  parseBatchResponse,
  toGoogleCode,
} from "./google";

// Build a batchexecute payload string ([2] of a frame) whose translation is
// `text`. When `chunks` is given, it goes in the sentence's [5] slot (the
// chunked form); otherwise the whole string sits at [0].
function payload(text: string, chunks?: string[]): string {
  const sentence = chunks
    ? [text, null, null, null, null, chunks.map((c) => [c])]
    : [text, null, null, null, null, null];
  return JSON.stringify([null, [[sentence]]]);
}

// Build a full response body for the given index -> payload frames.
function response(frames: Array<{ index: number; body: string }>): string {
  const line = JSON.stringify(
    frames.map(({ index, body }) => [
      "wrb.fr",
      "MkEWBc",
      body,
      null,
      null,
      null,
      index.toString(36),
    ]),
  );
  return `)]}'\n\n${line}\n`;
}

// A fetch stand-in that decodes the request and echoes each input through
// `translate`, returning a well-formed batchexecute response. Records each
// request body so tests can assert on batching.
function googleFetchMock(translate: (text: string) => string): {
  fetchImpl: typeof fetch;
  bodies: string[];
} {
  const bodies: string[] = [];
  const fetchImpl = vi.fn(
    async (_url: unknown, init?: { body?: unknown }): Promise<unknown> => {
      const body = String(init?.body ?? "");
      bodies.push(body);
      const encoded = body.slice("f.req=".length, body.lastIndexOf("&"));
      const calls = JSON.parse(decodeURIComponent(encoded))[0] as string[][];
      const frames = calls.map((call) => {
        const input = JSON.parse(call[1])[0][0] as string;
        return { index: parseInt(call[3], 36), body: payload(translate(input)) };
      });
      return { ok: true, status: 200, text: async () => response(frames) };
    },
  );
  return { fetchImpl: fetchImpl as unknown as typeof fetch, bodies };
}

describe("toGoogleCode", () => {
  it("maps Chinese script codes to Google's region tags", () => {
    expect(toGoogleCode("zh-Hans")).toBe("zh-CN");
    expect(toGoogleCode("zh-Hant")).toBe("zh-TW");
    expect(toGoogleCode("zh")).toBe("zh-CN");
  });

  it("drops region subtags and lowercases other codes", () => {
    expect(toGoogleCode("EN")).toBe("en");
    expect(toGoogleCode("pt-BR")).toBe("pt");
    expect(toGoogleCode("uk")).toBe("uk");
  });
});

describe("parseBatchResponse", () => {
  it("extracts the whole-string translation form", () => {
    const raw = response([{ index: 0, body: payload("Bonjour") }]);
    expect(parseBatchResponse(raw, 1)).toEqual(["Bonjour"]);
  });

  it("joins the chunked sentence form with spaces", () => {
    const raw = response([
      { index: 0, body: payload("ignored", ["Hello", "world"]) },
    ]);
    expect(parseBatchResponse(raw, 1)).toEqual(["Hello world"]);
  });

  it("places translations by their echoed index, not response order", () => {
    const raw = response([
      { index: 1, body: payload("second") },
      { index: 0, body: payload("first") },
    ]);
    expect(parseBatchResponse(raw, 2)).toEqual(["first", "second"]);
  });

  it("skips junk lines, non-translation frames, and out-of-range indices", () => {
    const good = JSON.stringify([
      ["wrb.fr", "MkEWBc", payload("ok"), null, null, null, "0"],
    ]);
    const noise = JSON.stringify([["di", 42], ["af.httprm", 1]]);
    const raw = `)]}'\n\n${good}\n${noise}\n[garbage\n`;
    expect(parseBatchResponse(raw, 1)).toEqual(["ok"]);
  });

  it("returns blanks when frames are missing entirely", () => {
    expect(parseBatchResponse(")]}'\n\n", 2)).toEqual(["", ""]);
  });
});

describe("createGoogleTranslationProvider", () => {
  it("translates line by line and preserves blank lines", async () => {
    const { fetchImpl, bodies } = googleFetchMock((text) => `T:${text}`);
    const provider = createGoogleTranslationProvider({ fetchImpl });

    const result = await provider.translate({
      text: "first\n\nsecond",
      sourceLang: "ja",
      targetLang: "en",
    });

    expect(result.text).toBe("T:first\n\nT:second");
    expect(result.sourceLang).toBe("ja");
    expect(result.targetLang).toBe("en");
    // One request for the two non-blank lines.
    expect(bodies).toHaveLength(1);
  });

  it("sends the mapped source/target codes and 'auto' for unknown source", async () => {
    const seen: Array<[string, string]> = [];
    const { fetchImpl } = googleFetchMock((text) => text);
    const spy = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      const body = String(init?.body ?? "");
      const encoded = body.slice("f.req=".length, body.lastIndexOf("&"));
      const calls = JSON.parse(decodeURIComponent(encoded))[0] as string[][];
      const [, from, to] = JSON.parse(calls[0][1])[0] as [
        string,
        string,
        string,
      ];
      seen.push([from, to]);
      return (fetchImpl as unknown as (...a: unknown[]) => unknown)(url, init);
    });

    const provider = createGoogleTranslationProvider({
      fetchImpl: spy as unknown as typeof fetch,
    });

    await provider.translate({ text: "x", targetLang: "zh-Hant" });
    await provider.translate({
      text: "y",
      sourceLang: "zh-Hans",
      targetLang: "en",
    });

    expect(seen).toEqual([
      ["auto", "zh-TW"],
      ["zh-CN", "en"],
    ]);
  });

  it("splits more than 50 lines across multiple requests", async () => {
    const { fetchImpl, bodies } = googleFetchMock((text) => text.toUpperCase());
    const provider = createGoogleTranslationProvider({ fetchImpl });
    const lines = Array.from({ length: 120 }, (_, i) => `line${i}`);

    const result = await provider.translate({
      text: lines.join("\n"),
      sourceLang: "fr",
      targetLang: "en",
    });

    expect(result.text).toBe(lines.map((l) => l.toUpperCase()).join("\n"));
    expect(bodies).toHaveLength(3); // 50 + 50 + 20
  });

  it("throws a helpful error on an HTTP failure", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => "",
    })) as unknown as typeof fetch;
    const provider = createGoogleTranslationProvider({ fetchImpl });

    await expect(
      provider.translate({ text: "hi", sourceLang: "ja", targetLang: "en" }),
    ).rejects.toThrow(/HTTP 429/);
  });

  it("times out a hung request as a retryable RemoteTranslationError", async () => {
    // A fetch that never resolves on its own, only rejecting when aborted.
    const fetchImpl = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    ) as unknown as typeof fetch;
    const provider = createGoogleTranslationProvider({ fetchImpl, timeoutMs: 10 });

    const error = await provider
      .translate({ text: "hi", sourceLang: "ja", targetLang: "en" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteTranslationError);
    expect((error as Error).message).toMatch(/timed out/i);
  });

  it("rejects an already-aborted request without fetching", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const provider = createGoogleTranslationProvider({ fetchImpl });
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.translate(
        { text: "hi", sourceLang: "ja", targetLang: "en" },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lists target languages including common codes", () => {
    const provider = createGoogleTranslationProvider();
    const langs = provider.listTargetLanguages?.() ?? [];
    expect(langs).toContain("en");
    expect(langs).toContain("ja");
    expect(langs).toContain("zh-Hans");
    expect(langs).toContain("zh-Hant");
    expect(langs.length).toBeGreaterThan(50);
  });
});
