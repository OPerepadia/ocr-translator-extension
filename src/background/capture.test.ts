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
});
