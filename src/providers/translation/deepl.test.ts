import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeepLTranslationProvider } from "./deepl";
import { RemoteTranslationError } from "./types";

vi.mock("../../shared/fetch-with-modified-headers", () => ({
  fetchWithModifiedHeaders: (url: string, init: RequestInit, _headers: unknown, fetchImpl: typeof fetch) => fetchImpl(url, init),
}));

const input = { text: "Sample text", targetLang: "uk" };
function mockFetch() {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({ translations: body.text.map((text: string) => ({
      text: `Translated ${text}`, detected_source_language: "EN",
    })) });
  });
}
function provider(fetchImpl = mockFetch(), plan: "free" | "pro" = "free", apiKey = "test-key", timeoutMs = 1000) {
  return createDeepLTranslationProvider({ deepl: { apiKey, plan }, fetchImpl, timeoutMs });
}
afterEach(() => vi.useRealTimers());

describe("DeepL translation", () => {
  it.each([
    ["free", "test-key", "api-free.deepl.com"],
    ["pro", "test-key:fx", "api.deepl.com"],
  ] as const)("uses the selected %s plan regardless of key suffix", async (plan, key, host) => {
    const fetchImpl = mockFetch();
    const result = await provider(fetchImpl, plan, ` ${key} `).translate(input);
    expect(fetchImpl).toHaveBeenCalledWith(`https://${host}/v2/translate`, expect.objectContaining({
      headers: { Authorization: `DeepL-Auth-Key ${key}`, "Content-Type": "application/json" },
      credentials: "omit", redirect: "error",
    }));
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body).toEqual({ text: [input.text], target_lang: "UK", preserve_formatting: true });
    expect(result).toEqual({ text: "Translated Sample text", sourceLang: "en", targetLang: "uk" });
  });

  it("requires a key before sending text", async () => {
    const fetchImpl = mockFetch();
    await expect(provider(fetchImpl, "free", " ").translate(input)).rejects.toThrow(/API key/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves blank lines and batches at most 50 texts", async () => {
    const fetchImpl = mockFetch();
    const text = Array.from({ length: 51 }, (_, i) => `Sample ${i}`).join("\n\n");
    const result = await provider(fetchImpl).translate({ ...input, text: `\n${text}\n  ` });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).text).toHaveLength(50);
    expect(result.text).toBe(`\n${text.replaceAll("Sample", "Translated Sample")}\n  `);
  });

  it("does not request or bill for blank input", async () => {
    const fetchImpl = mockFetch();
    expect((await provider(fetchImpl).translate({ ...input, text: " \n" })).text).toBe(" \n");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["en", "EN-US"], ["en-GB", "EN-GB"], ["pt", "PT-PT"], ["pt-BR", "PT-BR"],
    ["zh-Hans", "ZH-HANS"], ["zh-Hant", "ZH-HANT"], ["no", "NB"],
  ])("maps target %s to %s", async (targetLang, expected) => {
    const fetchImpl = mockFetch();
    await provider(fetchImpl).translate({ ...input, targetLang, sourceLang: "zh-Hant" });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      target_lang: expected, source_lang: "ZH",
    });
  });

  it("batches by UTF-8 request size and rejects oversized lines before sending", async () => {
    const fetchImpl = mockFetch();
    const text = "あ".repeat(23000);
    await provider(fetchImpl).translate({ ...input, text: `${text}\n${text}` });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(new TextEncoder().encode(String(init?.body)).length).toBeLessThanOrEqual(128 * 1024);
    }
    fetchImpl.mockClear();
    await expect(provider(fetchImpl).translate({ ...input, text: `Sample\n${text.repeat(2)}` })).rejects.toThrow(/limit/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([[403, /key/], [456, /quota/], [429, /requests/], [500, /500/]])(
    "reports HTTP %s without exposing response bodies", async (status, message) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret-key", { status: Number(status) }));
      await expect(provider(fetchImpl).translate(input)).rejects.toThrow(message as RegExp);
    },
  );

  it.each([null, {}, { translations: [] }, { translations: [{ text: 42 }] }, { translations: [null] }])(
    "rejects malformed responses: %j", async (body) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
      await expect(provider(fetchImpl).translate(input)).rejects.toThrow(/invalid translation response/);
    },
  );

  it("handles invalid JSON and network errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("invalid"))
      .mockRejectedValueOnce(new Error("network detail"));
    await expect(provider(fetchImpl).translate(input)).rejects.toThrow(/invalid translation response/);
    await expect(provider(fetchImpl).translate(input)).rejects.toThrow(/Could not connect/);
  });

  it("propagates cancellation and does not start pre-aborted requests", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    const translation = provider(fetchImpl).translate(input, controller.signal);
    controller.abort();
    await expect(translation).rejects.toMatchObject({ name: "AbortError" });
    await expect(provider(fetchImpl).translate(input, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("times out while reading the response body", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
    }) as Response);
    const translation = provider(fetchImpl).translate(input);
    const assertion = expect(translation).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("returns remote errors for pipeline handling and lists supported targets", async () => {
    const translation = createDeepLTranslationProvider();
    await expect(translation.translate(input)).rejects.toBeInstanceOf(RemoteTranslationError);
    expect(translation.listTargetLanguages?.()).toContain("zh-Hant");
    expect(translation.listTargetLanguages?.()).not.toContain("am");
  });
});
