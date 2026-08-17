import { describe, expect, it } from "vitest";
import { decodeRequest, encodeRequest } from "./offscreen-relay";

describe("offscreen relay encoding", () => {
  it("round-trips a capture through the port's JSON serialization", async () => {
    const image = new Blob([new Uint8Array([1, 2, 3, 250])], {
      type: "image/png",
    });

    const encoded = await encodeRequest({
      type: "recognize",
      id: 4,
      image,
      sourceLang: "ja",
    });
    // Nothing survives the trip that JSON cannot carry.
    const decoded = decodeRequest(JSON.parse(JSON.stringify(encoded)));

    expect(decoded).toMatchObject({ type: "recognize", id: 4, sourceLang: "ja" });
    const bytes = new Uint8Array(
      await (decoded as { image: Blob }).image.arrayBuffer(),
    );
    expect([...bytes]).toEqual([1, 2, 3, 250]);
    expect((decoded as { image: Blob }).image.type).toBe("image/png");
  });

  it("passes init through untouched", async () => {
    const init = {
      type: "init" as const,
      id: 1,
      model: {
        id: "v6-multi",
        modelBaseUrl: "extension://models/general/",
        script: "general" as const,
      },
      layoutModelBaseUrl: "extension://models/layout/",
      wasmBaseUrl: "extension://ort/",
      backend: "webgpu" as const,
      debug: false,
    };

    expect(await encodeRequest(init)).toEqual(init);
    expect(decodeRequest(init)).toEqual(init);
  });

  it("passes cancel through untouched", async () => {
    const cancel = { type: "cancel" as const, id: 9 };

    expect(await encodeRequest(cancel)).toEqual(cancel);
    expect(decodeRequest(cancel)).toEqual(cancel);
  });

  it("falls back to a generic media type for a typeless blob", async () => {
    const encoded = await encodeRequest({
      type: "recognize",
      id: 1,
      image: new Blob(["pixels"]),
    });

    expect((encoded as { image: { mediaType: string } }).image.mediaType).toBe(
      "application/octet-stream",
    );
  });
});
