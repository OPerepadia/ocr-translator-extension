import { afterEach, describe, expect, it, vi } from "vitest";
import {
  base64ToBlob,
  blobToBase64,
  encodeSnapshot,
  fitSnapshotSize,
} from "./image";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fitSnapshotSize", () => {
  it("keeps a capture that already fits", () => {
    expect(fitSnapshotSize(800, 600, 2400)).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("scales the longest side down to the cap", () => {
    expect(fitSnapshotSize(4800, 1200, 2400)).toEqual({
      width: 2400,
      height: 600,
    });
  });

  it("keeps a thin capture at least one pixel thick", () => {
    expect(fitSnapshotSize(9600, 1, 2400)).toEqual({ width: 2400, height: 1 });
  });
});

describe("blobToBase64", () => {
  it("round-trips bytes through a JSON-safe string", async () => {
    const bytes = new Uint8Array([0, 1, 65, 127, 128, 254, 255]);

    const encoded = await blobToBase64(new Blob([bytes]));
    const decoded = base64ToBlob(encoded, "image/webp");

    expect(decoded.type).toBe("image/webp");
    expect(new Uint8Array(await decoded.arrayBuffer())).toEqual(bytes);
  });

  // The binary string is built in chunks, so a payload spanning several of them
  // must come back byte for byte.
  it("round-trips a payload larger than one chunk", async () => {
    const bytes = new Uint8Array(0x8000 * 2 + 17);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 256;
    }

    const encoded = await blobToBase64(new Blob([bytes]));

    expect(
      new Uint8Array(
        await base64ToBlob(encoded, "image/png").arrayBuffer(),
      ),
    ).toEqual(bytes);
  });
});

function stubCanvas(args: {
  supported: string[];
  bitmap: { width: number; height: number };
}): {
  drawImage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  requested: string[];
} {
  const drawImage = vi.fn();
  const close = vi.fn();
  const requested: string[] = [];

  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ ...args.bitmap, close })),
  );
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}

      getContext(): { drawImage: typeof drawImage } {
        return { drawImage };
      }

      async convertToBlob({ type }: { type: string }): Promise<Blob> {
        requested.push(type);
        return new Blob([new Uint8Array([1, 2, 3])], {
          type: args.supported.includes(type) ? type : "image/png",
        });
      }
    },
  );

  return { drawImage, close, requested };
}

describe("encodeSnapshot", () => {
  // A capture is in device pixels, so on a HiDPI screen it comes in at twice
  // the region's CSS size — exactly what the overlay paints it at, and so kept
  // as-is.
  it("keeps a capture already at the region's own resolution", async () => {
    const stub = stubCanvas({
      supported: ["image/webp"],
      bitmap: { width: 1600, height: 400 },
    });

    await encodeSnapshot(new Blob(["capture"]), { width: 800, height: 200 });

    expect(stub.drawImage).toHaveBeenCalledWith(
      expect.anything(),
      0,
      0,
      1600,
      400,
    );
  });

  it("scales a capture down to twice the region's CSS size", async () => {
    const stub = stubCanvas({
      supported: ["image/webp"],
      bitmap: { width: 4800, height: 1200 },
    });

    await encodeSnapshot(new Blob(["capture"]), { width: 800, height: 200 });

    expect(stub.drawImage).toHaveBeenCalledWith(
      expect.anything(),
      0,
      0,
      1600,
      400,
    );
  });

  it("falls back to an absolute cap when the region's size is unknown", async () => {
    const stub = stubCanvas({
      supported: ["image/webp", "image/jpeg", "image/png"],
      bitmap: { width: 4800, height: 1200 },
    });

    const snapshot = await encodeSnapshot(new Blob(["capture"]));

    expect(snapshot).toEqual({
      data: await blobToBase64(new Blob([new Uint8Array([1, 2, 3])])),
      mediaType: "image/webp",
    });
    expect(stub.requested).toEqual(["image/webp"]);
    expect(stub.drawImage).toHaveBeenCalledWith(
      expect.anything(),
      0,
      0,
      2400,
      600,
    );
    expect(stub.close).toHaveBeenCalledOnce();
  });

  // A browser that cannot encode a type quietly hands back PNG instead, so the
  // produced type is what the fallback chain has to read.
  it("falls back when the browser silently refuses a format", async () => {
    const stub = stubCanvas({
      supported: ["image/png"],
      bitmap: { width: 100, height: 50 },
    });

    const snapshot = await encodeSnapshot(new Blob(["capture"]));

    expect(snapshot.mediaType).toBe("image/png");
    expect(stub.requested).toEqual(["image/webp", "image/jpeg", "image/png"]);
  });
});
