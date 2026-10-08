import { afterEach, describe, expect, it, vi } from "vitest";
import { loadImage, maskRectInCrop } from "./capture";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("captureLiveFrame", () => {
  const args = {
    rect: { x: 0, y: 0, width: 100, height: 40 },
    viewport: { width: 800, height: 600 },
    tabId: 7,
    windowId: 3,
  };

  it("does not capture once another tab is active", async () => {
    vi.resetModules();
    const { captureLiveFrame } = await import("./capture");
    const query = vi.fn(async () => [{ id: 8 }]);
    const captureVisibleTab = vi.fn();
    vi.stubGlobal("browser", {
      tabs: { query, captureVisibleTab },
    });

    await expect(captureLiveFrame(args)).resolves.toBeUndefined();
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith({ active: true, windowId: 3 });
  });

  it("discards a capture if the active tab changes during it", async () => {
    vi.resetModules();
    const { captureLiveFrame } = await import("./capture");
    let activeTabId = 7;
    const query = vi.fn(async () => [{ id: activeTabId }]);
    const captureVisibleTab = vi.fn(async () => {
      activeTabId = 8;
      return "unused screenshot";
    });
    vi.stubGlobal("browser", {
      tabs: { query, captureVisibleTab },
    });

    await expect(captureLiveFrame(args)).resolves.toBeUndefined();
    expect(captureVisibleTab).toHaveBeenCalledWith(3, {
      format: "jpeg",
      quality: 92,
    });
    expect(query).toHaveBeenCalledTimes(2);
  });
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

describe("maskRectInCrop", () => {
  const viewport = { width: 1000, height: 500 };

  it("places a viewport rect in the cropped canvas", () => {
    // A 2000x1000 screenshot of a 1000x500 viewport: two pixels per CSS pixel.
    const crop = { x: 200, y: 100, width: 800, height: 200 };

    expect(
      maskRectInCrop(
        { x: 150, y: 80, width: 100, height: 30 },
        crop,
        { width: 2000, height: 1000 },
        viewport,
      ),
    ).toEqual({ x: 100, y: 60, width: 200, height: 60 });
  });

  it("rounds outwards so no touched pixel is left unmasked", () => {
    const crop = { x: 0, y: 0, width: 1000, height: 500 };

    expect(
      maskRectInCrop(
        { x: 10.4, y: 20.4, width: 10.2, height: 5.2 },
        crop,
        { width: 1000, height: 500 },
        viewport,
      ),
    ).toEqual({ x: 10, y: 20, width: 11, height: 6 });
  });
});
