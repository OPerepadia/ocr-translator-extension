import { afterEach, describe, expect, it, vi } from "vitest";
import { loadImage } from "./capture";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadImage", () => {
  it("loads an image with page credentials", async () => {
    const image = new Blob(["image"], { type: "image/png" });
    const fetchMock = vi.fn(async () => new Response(image));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadImage("https://example.com/sample.png")).resolves.toEqual(
      image,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/sample.png",
      { credentials: "include" },
    );
  });

  it("rejects failed image requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    await expect(
      loadImage("https://example.com/missing.png"),
    ).rejects.toThrow("Could not load image (404).");
  });

  it("loads a cross-origin image with the page referrer", async () => {
    const image = new Blob(["image"], { type: "image/png" });
    const fetchMock = vi.fn(async () => new Response(image));
    const updateSessionRules = vi.fn(
      async (_options: {
        addRules?: Array<{ id: number }>;
        removeRuleIds?: number[];
      }) => undefined,
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("browser", {
      runtime: {
        getURL: () => "moz-extension://extension-id/",
      },
      declarativeNetRequest: { updateSessionRules },
    });

    await expect(
      loadImage(
        "https://images.example/assets/sample.png?size=large",
        "https://reader.example/chapter/1?mode=full#page-2",
      ),
    ).resolves.toEqual(image);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://images.example/assets/sample.png?size=large",
      { credentials: "include" },
    );

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
            requestHeaders: [
              {
                header: "Referer",
                operation: "set",
                value: "https://reader.example/",
              },
            ],
          },
          condition: {
            regexFilter:
              "^https://images\\.example/assets/sample\\.png\\?size=large$",
            isUrlFilterCaseSensitive: true,
            initiatorDomains: ["extension-id"],
            resourceTypes: ["xmlhttprequest"],
          },
        },
      ],
    });
    expect(updateSessionRules).toHaveBeenNthCalledWith(2, {
      removeRuleIds: [ruleId],
    });
  });
});
