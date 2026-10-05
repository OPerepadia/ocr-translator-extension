import { afterEach, describe, expect, it, vi } from "vitest";
import { loadImage, maskRectsInCrop } from "./capture";

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

describe("maskRectsInCrop", () => {
  const viewport = { width: 1000, height: 500 };

  it("places viewport rects in the cropped canvas", () => {
    // A 2000x1000 screenshot of a 1000x500 viewport: two pixels per CSS pixel.
    const crop = { x: 200, y: 100, width: 800, height: 200 };

    expect(
      maskRectsInCrop(
        [{ x: 150, y: 80, width: 100, height: 30 }],
        crop,
        { width: 2000, height: 1000 },
        viewport,
      ),
    ).toEqual([{ x: 100, y: 60, width: 200, height: 60 }]);
  });

  it("rounds outwards so no touched pixel is left unmasked", () => {
    const crop = { x: 0, y: 0, width: 1000, height: 500 };

    expect(
      maskRectsInCrop(
        [{ x: 10.4, y: 20.4, width: 10.2, height: 5.2 }],
        crop,
        { width: 1000, height: 500 },
        viewport,
      ),
    ).toEqual([{ x: 10, y: 20, width: 11, height: 6 }]);
  });

  it("returns nothing for no mask", () => {
    expect(
      maskRectsInCrop([], { x: 0, y: 0, width: 10, height: 10 }, viewport, viewport),
    ).toEqual([]);
  });
});
