import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithModifiedHeaders } from "./fetch-with-modified-headers";

interface RuleUpdate {
  addRules?: Array<{ id: number; action?: unknown }>;
  removeRuleIds?: number[];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubBrowser() {
  const updateSessionRules = vi.fn(async (_options: RuleUpdate) => undefined);
  vi.stubGlobal("browser", {
    runtime: {
      getURL: () => "moz-extension://extension-id/",
    },
    declarativeNetRequest: { updateSessionRules },
  });
  return updateSessionRules;
}

describe("fetchWithModifiedHeaders", () => {
  it("modifies headers only for the exact extension request", async () => {
    const updateSessionRules = stubBrowser();
    const response = new Response("ok");
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch;
    const init = { method: "POST", body: "{}" };

    await expect(
      fetchWithModifiedHeaders(
        "http://server.example:2244/v1/chat/completions",
        init,
        [{ header: "Origin", operation: "remove" }],
        fetchImpl,
      ),
    ).resolves.toBe(response);

    const addRules = updateSessionRules.mock.calls[0]?.[0];
    const ruleId = addRules?.addRules?.[0]?.id;
    expect(addRules).toEqual({
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [{ header: "Origin", operation: "remove" }],
          },
          condition: {
            regexFilter:
              "^http://server\\.example:2244/v1/chat/completions$",
            isUrlFilterCaseSensitive: true,
            initiatorDomains: ["extension-id"],
            resourceTypes: ["xmlhttprequest"],
          },
        },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://server.example:2244/v1/chat/completions",
      init,
    );
    expect(updateSessionRules).toHaveBeenNthCalledWith(2, {
      removeRuleIds: [ruleId],
    });
  });

  it("removes the temporary rule when fetch fails", async () => {
    const updateSessionRules = stubBrowser();
    const fetchImpl = vi.fn(async () => {
      throw new Error("network failure");
    }) as unknown as typeof fetch;

    await expect(
      fetchWithModifiedHeaders(
        "http://host.test/v1/chat/completions",
        {},
        [{ header: "Origin", operation: "remove" }],
        fetchImpl,
      ),
    ).rejects.toThrow("network failure");

    const ruleId = updateSessionRules.mock.calls[0]?.[0].addRules?.[0]?.id;
    expect(updateSessionRules).toHaveBeenNthCalledWith(2, {
      removeRuleIds: [ruleId],
    });
  });
});
