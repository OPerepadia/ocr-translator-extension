import { browser } from "wxt/browser";

interface RequestHeaderModification {
  header: string;
  operation: "remove" | "set";
  value?: string;
}

export async function fetchWithModifiedHeaders(
  url: string,
  init: RequestInit,
  requestHeaders: RequestHeaderModification[],
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const requestUrl = new URL(url).href;
  const ruleId = createRuleId();
  const initiator = new URL(browser.runtime.getURL("")).hostname;

  await browser.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [
      {
        id: ruleId,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders,
        },
        condition: {
          regexFilter: `^${escapeRegex(requestUrl)}$`,
          isUrlFilterCaseSensitive: true,
          initiatorDomains: [initiator],
          resourceTypes: ["xmlhttprequest"],
        },
      },
    ],
  });

  try {
    return await fetchImpl(requestUrl, init);
  } finally {
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
    });
  }
}

function createRuleId(): number {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return (value & 0x7fffffff) || 1;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
