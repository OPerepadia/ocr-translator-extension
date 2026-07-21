import { describe, expect, it, vi } from "vitest";
import { RemoteTranslationError } from "./errors";
import {
  createOpenAiTranslationProvider,
  extractTranslations,
  fetchAvailableModels,
  languageLabel,
  stripCodeFence,
  stripThinking,
  testLlmConnection,
} from "./openai";

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  credentials?: string;
  body: {
    model?: string;
    chat_template_kwargs?: unknown;
    messages: Array<{ role: string; content: string }>;
  };
}

function translationReply(texts: string[]): string {
  return JSON.stringify({
    translations: texts.map((text, id) => ({ id, text })),
  });
}

// A fetch stand-in that answers every request with a chat completion whose
// content comes from `reply` (given the JSON-decoded segments the provider
// sent). Records each request so tests can assert on URL, headers, and body.
function llmFetchMock(
  reply: (segments: string[], requestIndex: number) => string,
): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = vi.fn(
    async (
      url: unknown,
      init?: {
        headers?: Record<string, string>;
        credentials?: string;
        body?: unknown;
      },
    ): Promise<unknown> => {
      const body = JSON.parse(String(init?.body)) as RecordedRequest["body"];
      const requestIndex = requests.length;
      requests.push({
        url: String(url),
        headers: init?.headers ?? {},
        credentials: init?.credentials,
        body,
      });
      const input = JSON.parse(body.messages[1].content) as {
        segments: Array<{ id: number; text: string }>;
      };
      const segments = input.segments.map((segment) => segment.text);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: reply(segments, requestIndex) } }],
          }),
      };
    },
  );
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests };
}

const llm = {
  baseUrl: "http://localhost:8080/v1",
  apiKey: "test-api-key",
  model: "qwen2.5",
};

describe("extractTranslations", () => {
  it("parses translations by id rather than response order", () => {
    expect(
      extractTranslations(
        '{"translations":[{"id":1,"text":"two"},{"id":0,"text":"one"}]}',
        2,
      ),
    ).toEqual(["one", "two"]);
  });

  it("parses a fenced bare array of id objects", () => {
    expect(
      extractTranslations(
        '```json\n[{"id":0,"text":"one"},{"id":1,"translation":"two"}]\n```',
        2,
      ),
    ).toEqual(["one", "two"]);
  });

  it("accepts ids quoted as strings", () => {
    expect(
      extractTranslations(
        '{"translations":[{"id":"0","text":"one"},{"id":"1","text":"two"}]}',
        2,
      ),
    ).toEqual(["one", "two"]);
  });

  it("rejects positional string arrays", () => {
    expect(extractTranslations('["one", "two"]', 2)).toBeNull();
  });

  it("rejects a non-numeric id", () => {
    expect(
      extractTranslations('{"translations":[{"id":"first","text":"one"}]}', 1),
    ).toBeNull();
  });

  it("rejects missing, duplicate, and out-of-range ids", () => {
    expect(
      extractTranslations('{"translations":[{"id":0,"text":"one"}]}', 2),
    ).toBeNull();
    expect(
      extractTranslations(
        '{"translations":[{"id":0,"text":"one"},{"id":0,"text":"two"}]}',
        2,
      ),
    ).toBeNull();
    expect(
      extractTranslations(
        '{"translations":[{"id":0,"text":"one"},{"id":2,"text":"two"}]}',
        2,
      ),
    ).toBeNull();
  });

  it("rejects a blank translation", () => {
    expect(
      extractTranslations('{"translations":[{"id":0,"text":"  "}]}', 1),
    ).toBeNull();
  });
});

describe("stripCodeFence", () => {
  it("removes a wrapping fence and keeps everything else", () => {
    expect(stripCodeFence("```json\nhello\n```")).toBe("hello");
    expect(stripCodeFence("plain text")).toBe("plain text");
  });
});

describe("stripThinking", () => {
  it("removes <think> and <thinking> blocks", () => {
    expect(stripThinking('<think>\nplan ["x"]\n</think>\n["ok"]')).toBe(
      '["ok"]',
    );
    expect(stripThinking("<thinking>hm</thinking>answer")).toBe("answer");
  });

  it("drops everything before a lone closing tag", () => {
    expect(stripThinking('reasoning here...\n</think>\n["ok"]')).toBe('["ok"]');
  });

  it("leaves replies without think tags alone", () => {
    expect(stripThinking('["ok"]')).toBe('["ok"]');
  });
});

describe("languageLabel", () => {
  it("renders an English name with the code", () => {
    expect(languageLabel("uk")).toBe("Ukrainian (uk)");
    expect(languageLabel("zh-Hans")).toBe("Simplified Chinese (zh-Hans)");
  });
});

describe("createOpenAiTranslationProvider", () => {
  it("fails with a configuration hint when no endpoint is set", async () => {
    const { fetchImpl } = llmFetchMock(() => "[]");
    const provider = createOpenAiTranslationProvider({ fetchImpl });

    const error = await provider
      .translate({ text: "hi", targetLang: "en" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteTranslationError);
    expect((error as Error).message).toMatch(/endpoint/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["not a url at all", /not a valid absolute URL/],
    ["ftp://localhost:8080/v1", /http:\/\/ or https:\/\//],
    ["http://localhost:8080/v1?key=1", /query string/],
    ["http://localhost:8080/v1#anchor", /query string|fragment/],
  ])("rejects the endpoint URL %j without fetching", async (baseUrl, hint) => {
    const { fetchImpl } = llmFetchMock(() => "[]");
    const provider = createOpenAiTranslationProvider({
      llm: { baseUrl },
      fetchImpl,
    });

    const error = await provider
      .translate({ text: "hi", targetLang: "en" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteTranslationError);
    expect((error as Error).message).toMatch(hint);
    expect((error as Error).message).toMatch(/settings/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends one chat request with auth, model, and the non-blank lines", async () => {
    const { fetchImpl, requests } = llmFetchMock((segments) =>
      translationReply(segments.map((s) => `T:${s}`)),
    );
    const provider = createOpenAiTranslationProvider({ llm, fetchImpl });

    const result = await provider.translate({
      text: "first\n\nsecond",
      sourceLang: "ja",
      targetLang: "en",
    });

    expect(result.text).toBe("T:first\n\nT:second");
    expect(result.sourceLang).toBe("ja");
    expect(result.targetLang).toBe("en");

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.url).toBe("http://localhost:8080/v1/chat/completions");
    expect(request.headers.Authorization).toBe("Bearer test-api-key");
    // The user's cookies must never ride along to the endpoint.
    expect(request.credentials).toBe("omit");
    expect(request.body.model).toBe("qwen2.5");
    // Blank lines are reassembled locally, not sent to the model.
    expect(JSON.parse(request.body.messages[1].content)).toEqual({
      segments: [
        { id: 0, text: "first" },
        { id: 1, text: "second" },
      ],
    });
    // The prompt names the languages rather than passing bare codes.
    expect(request.body.messages[0].content).toContain("Japanese (ja)");
    expect(request.body.messages[0].content).toContain("English (en)");
    // Thinking is disabled by default.
    expect(request.body.chat_template_kwargs).toEqual({
      enable_thinking: false,
    });
  });

  it("leaves thinking alone when the user re-enabled it", async () => {
    const { fetchImpl, requests } = llmFetchMock((segments) =>
      translationReply(segments),
    );
    const provider = createOpenAiTranslationProvider({
      llm: { ...llm, disableThinking: false },
      fetchImpl,
    });

    await provider.translate({ text: "hi", targetLang: "en" });

    expect(requests[0].body.chat_template_kwargs).toBeUndefined();
  });

  it("ignores a leaked <think> block before the translations", async () => {
    const { fetchImpl } = llmFetchMock(
      (segments) =>
        '<think>\nInput was ["one","two"], so I should...\n</think>\n' +
        translationReply(segments.map((s) => `T:${s}`)),
    );
    const provider = createOpenAiTranslationProvider({ llm, fetchImpl });

    const result = await provider.translate({
      text: "one\ntwo",
      sourceLang: "fr",
      targetLang: "en",
    });

    expect(result.text).toBe("T:one\nT:two");
  });

  it("omits the auth header and model when not configured", async () => {
    const { fetchImpl, requests } = llmFetchMock((segments) =>
      translationReply(segments),
    );
    const provider = createOpenAiTranslationProvider({
      llm: { baseUrl: "http://localhost:8080/v1/" },
      fetchImpl,
    });

    await provider.translate({ text: "hi", targetLang: "en" });

    const request = requests[0];
    // Trailing slash on the base URL doesn't double up.
    expect(request.url).toBe("http://localhost:8080/v1/chat/completions");
    expect(request.headers.Authorization).toBeUndefined();
    expect(request.body.model).toBeUndefined();
  });

  it("accepts a fenced or object-wrapped reply", async () => {
    const { fetchImpl } = llmFetchMock(
      (segments) =>
        "```json\n" +
        translationReply(segments.map((s) => s.toUpperCase())) +
        "\n```",
    );
    const provider = createOpenAiTranslationProvider({ llm, fetchImpl });

    const result = await provider.translate({
      text: "one\ntwo",
      sourceLang: "fr",
      targetLang: "en",
    });

    expect(result.text).toBe("ONE\nTWO");
  });

  it("corrects an extra translation with one retry", async () => {
    const { fetchImpl, requests } = llmFetchMock((segments, requestIndex) =>
      requestIndex === 0
        ? translationReply(["first option", "extra option"])
        : translationReply(segments.map((segment) => `T:${segment}`)),
    );
    const provider = createOpenAiTranslationProvider({ llm, fetchImpl });

    const result = await provider.translate({
      text: "one",
      sourceLang: "fr",
      targetLang: "en",
    });

    expect(result.text).toBe("T:one");
    expect(requests).toHaveLength(2);
    expect(requests[1].body.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(requests[1].body.messages[3].content).toContain(
      "outside the expected range",
    );
  });

  it("rejects an invalid reply after one retry without exposing it", async () => {
    const { fetchImpl, requests } = llmFetchMock(() =>
      '["first option", "extra option"]',
    );
    const provider = createOpenAiTranslationProvider({ llm, fetchImpl });

    const error = await provider
      .translate({ text: "one", sourceLang: "fr", targetLang: "en" })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(RemoteTranslationError);
    expect((error as Error).message).toMatch(/invalid translation format/i);
    expect((error as Error).message).not.toContain("first option");
    expect(requests).toHaveLength(2);
  });

  it("retries a blank translation", async () => {
    const { fetchImpl } = llmFetchMock((segments, requestIndex) =>
      requestIndex === 0
        ? translationReply(["T:one", ""])
        : translationReply(segments.map((segment) => `T:${segment}`)),
    );
    const provider = createOpenAiTranslationProvider({ llm, fetchImpl });

    const result = await provider.translate({
      text: "one\ntwo",
      sourceLang: "fr",
      targetLang: "en",
    });

    expect(result.text).toBe("T:one\nT:two");
  });

  it("returns blank-only input unchanged without a request", async () => {
    const { fetchImpl } = llmFetchMock(() => "[]");
    const provider = createOpenAiTranslationProvider({ llm, fetchImpl });

    const result = await provider.translate({
      text: "\n\n",
      targetLang: "en",
    });

    expect(result.text).toBe("\n\n");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces the API's error message on an HTTP failure", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({ error: { message: "Invalid API key" } }),
    })) as unknown as typeof fetch;
    const provider = createOpenAiTranslationProvider({ llm, fetchImpl });

    const error = await provider
      .translate({ text: "hi", targetLang: "en" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteTranslationError);
    expect((error as Error).message).toMatch(/HTTP 401/);
    expect((error as Error).message).toMatch(/Invalid API key/);
  });

  it("rejects a non-JSON response body with a helpful error", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "<html>not an API</html>",
    })) as unknown as typeof fetch;
    const provider = createOpenAiTranslationProvider({ llm, fetchImpl });

    await expect(
      provider.translate({ text: "hi", targetLang: "en" }),
    ).rejects.toThrow(/OpenAI-compatible/);
  });

  it("rejects an empty completion", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ choices: [{ message: { content: "" } }] }),
    })) as unknown as typeof fetch;
    const provider = createOpenAiTranslationProvider({ llm, fetchImpl });

    await expect(
      provider.translate({ text: "hi", targetLang: "en" }),
    ).rejects.toThrow(/empty/i);
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
    const provider = createOpenAiTranslationProvider({
      llm,
      fetchImpl,
      timeoutMs: 10,
    });

    const error = await provider
      .translate({ text: "hi", targetLang: "en" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteTranslationError);
    expect((error as Error).message).toMatch(/did not answer/i);
  });

  it("times out while reading a stalled response body", async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("Aborted", "AbortError")),
              );
            }),
        }),
    ) as unknown as typeof fetch;
    const provider = createOpenAiTranslationProvider({
      llm,
      fetchImpl,
      timeoutMs: 10,
    });

    const error = await provider
      .translate({ text: "hi", targetLang: "en" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteTranslationError);
    expect((error as Error).message).toMatch(/did not answer/i);
  });

  it("honors the timeout from the saved LLM settings", async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    ) as unknown as typeof fetch;
    const provider = createOpenAiTranslationProvider({
      llm: { ...llm, timeoutMs: 10 },
      fetchImpl,
    });

    const error = await provider
      .translate({ text: "hi", targetLang: "en" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteTranslationError);
    expect((error as Error).message).toMatch(/did not answer/i);
  });

  it("rejects an already-aborted request without fetching", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const provider = createOpenAiTranslationProvider({ llm, fetchImpl });
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.translate({ text: "hi", targetLang: "en" }, controller.signal),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lists target languages including common codes", () => {
    const provider = createOpenAiTranslationProvider();
    const langs = provider.listTargetLanguages?.() ?? [];
    expect(langs).toContain("en");
    expect(langs).toContain("ja");
    expect(langs).toContain("zh-Hans");
    expect(langs.length).toBeGreaterThan(50);
  });
});

describe("fetchAvailableModels", () => {
  function modelsFetchMock(body: unknown, status = 200) {
    const requests: Array<{ url: string; headers: Record<string, string> }> =
      [];
    const fetchImpl = vi.fn(
      async (
        url: unknown,
        init?: { headers?: Record<string, string> },
      ): Promise<unknown> => {
        requests.push({ url: String(url), headers: init?.headers ?? {} });
        return {
          ok: status >= 200 && status < 300,
          status,
          text: async () =>
            typeof body === "string" ? body : JSON.stringify(body),
        };
      },
    );
    return { fetchImpl: fetchImpl as unknown as typeof fetch, requests };
  }

  it("lists ids from the OpenAI shape, sorted and de-duplicated", async () => {
    const { fetchImpl, requests } = modelsFetchMock({
      object: "list",
      data: [{ id: "qwen" }, { id: "gemma" }, { id: "qwen" }],
    });

    const models = await fetchAvailableModels({
      baseUrl: "http://localhost:8080/v1/",
      apiKey: "test-api-key",
      fetchImpl,
    });

    expect(models).toEqual(["gemma", "qwen"]);
    expect(requests[0].url).toBe("http://localhost:8080/v1/models");
    expect(requests[0].headers.Authorization).toBe("Bearer test-api-key");
  });

  it("accepts a bare array and omits auth when there is no key", async () => {
    const { fetchImpl, requests } = modelsFetchMock(["b", "a"]);

    const models = await fetchAvailableModels({
      baseUrl: "http://localhost:8080/v1",
      fetchImpl,
    });

    expect(models).toEqual(["a", "b"]);
    expect(requests[0].headers.Authorization).toBeUndefined();
  });

  it("surfaces the API's error message on an HTTP failure", async () => {
    const { fetchImpl } = modelsFetchMock(
      { error: { message: "Invalid API key" } },
      401,
    );

    await expect(
      fetchAvailableModels({ baseUrl: "http://x/v1", fetchImpl }),
    ).rejects.toThrow(/HTTP 401.*Invalid API key/);
  });

  it("rejects a response without a model list", async () => {
    const { fetchImpl } = modelsFetchMock("<html>not an API</html>");

    await expect(
      fetchAvailableModels({ baseUrl: "http://x/v1", fetchImpl }),
    ).rejects.toThrow(/didn't return a model list/);
  });

  it("rejects an invalid endpoint URL without fetching", async () => {
    const { fetchImpl } = modelsFetchMock({ data: [] });

    await expect(
      fetchAvailableModels({ baseUrl: "not a url at all", fetchImpl }),
    ).rejects.toThrow(/not a valid absolute URL/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("testLlmConnection", () => {
  it("tests chat completions with the current endpoint settings", async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl = vi.fn(
      async (
        url: unknown,
        init?: {
          headers?: Record<string, string>;
          credentials?: string;
          body?: unknown;
        },
      ): Promise<unknown> => {
        requests.push({
          url: String(url),
          headers: init?.headers ?? {},
          credentials: init?.credentials,
          body: JSON.parse(String(init?.body)) as RecordedRequest["body"],
        });
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
        };
      },
    );

    await testLlmConnection({
      baseUrl: "http://localhost:8080/v1/",
      apiKey: "test-api-key",
      model: "qwen2.5",
      disableThinking: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(requests).toEqual([
      {
        url: "http://localhost:8080/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-api-key",
        },
        credentials: "omit",
        body: {
          model: "qwen2.5",
          chat_template_kwargs: { enable_thinking: false },
          messages: [
            {
              role: "system",
              content: "You are a connection test. Reply only with OK.",
            },
            { role: "user", content: "OK" },
          ],
        },
      },
    ]);
  });

  it("requires an endpoint URL", async () => {
    await expect(testLlmConnection({ baseUrl: "" })).rejects.toThrow(
      "Set the endpoint URL first.",
    );
  });
});
