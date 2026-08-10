import type { EncodedImage, Rect } from "./types";
import { t } from "./i18n";

/**
 * Decode a data URL (e.g. from tabs.captureVisibleTab) into an ImageBitmap.
 * Works in both DOM and worker/service-worker contexts.
 */
export async function dataUrlToImageBitmap(
  dataUrl: string,
): Promise<ImageBitmap> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

/**
 * Crop a region (in source/device pixels) out of a bitmap and return it as a
 * PNG Blob. Uses OffscreenCanvas so it runs without a DOM, which keeps this
 * usable from workers and MV3 service workers.
 */
export async function cropBitmapToBlob(
  bitmap: ImageBitmap,
  source: Rect,
): Promise<Blob> {
  const sourceX = Math.max(0, Math.round(source.x));
  const sourceY = Math.max(0, Math.round(source.y));
  const width = Math.max(1, Math.round(source.width));
  const height = Math.max(1, Math.round(source.height));

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error(t("errorCanvasContext"));
  }

  context.drawImage(
    bitmap,
    sourceX,
    sourceY,
    width,
    height,
    0,
    0,
    width,
    height,
  );

  return canvas.convertToBlob({ type: "image/png" });
}

// Device pixels per CSS pixel of the region a snapshot is encoded at. The
// overlay paints it at the region's CSS size, so past a HiDPI screen's own ratio
// it is detail the browser discards on draw, paid for in message size and in the
// decoded bitmap the content script then holds.
const SNAPSHOT_MAX_SCALE = 2;
// Longest side allowed when the displayed size is unknown — a context-menu
// image, whose source can be many times the box it renders in.
const MAX_SNAPSHOT_DIMENSION = 2400;
// Tried in order. A browser that cannot encode a type silently returns PNG (the
// canvas spec's fallback), so the produced blob's type is what decides.
const SNAPSHOT_MEDIA_TYPES = ["image/webp", "image/jpeg", "image/png"];
const SNAPSHOT_QUALITY = 0.8;

/** The size a capture is encoded at for the overlay: its own, unless that runs
 * past `maxDimension` on the longest side, in which case it scales down. */
export function fitSnapshotSize(
  width: number,
  height: number,
  maxDimension: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  const scale = longest > maxDimension ? maxDimension / longest : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Re-encode a captured image for the overlay's frozen region. The capture is a
 * lossless PNG sized for the recognizer; this is only ever displayed, so it goes
 * over the wire as a much smaller lossy image.
 *
 * `displaySize` is the region's CSS size, which is what the resolution is
 * measured against. Without it the capture falls back to an absolute ceiling.
 */
export async function encodeSnapshot(
  image: Blob,
  displaySize?: { width: number; height: number },
): Promise<EncodedImage> {
  const bitmap = await createImageBitmap(image);
  try {
    const size = fitSnapshotSize(
      bitmap.width,
      bitmap.height,
      displaySize
        ? SNAPSHOT_MAX_SCALE *
            Math.max(displaySize.width, displaySize.height)
        : MAX_SNAPSHOT_DIMENSION,
    );
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error(t("errorCanvasContext"));
    }

    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const encoded = await encodeCanvas(canvas);
    return { data: await blobToBase64(encoded), mediaType: encoded.type };
  } finally {
    bitmap.close();
  }
}

async function encodeCanvas(canvas: OffscreenCanvas): Promise<Blob> {
  let encoded: Blob | undefined;
  for (const type of SNAPSHOT_MEDIA_TYPES) {
    encoded = await canvas.convertToBlob({ type, quality: SNAPSHOT_QUALITY });
    if (encoded.type === type) {
      break;
    }
  }
  if (!encoded) {
    throw new Error(t("errorEncodeCapturedImage"));
  }
  return encoded;
}

// Spreading a multi-megabyte array into fromCharCode overflows the argument
// list, so the binary string is built in chunks.
const BASE64_CHUNK_BYTES = 0x8000;

/** Base64-encode a blob. Goes through `arrayBuffer` rather than FileReader,
 * which MV3 service workers do not have. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES),
    );
  }
  return btoa(binary);
}

/** Rebuild a blob from `blobToBase64`. Decoding in JS keeps the pixels off the
 * network, so a host page's CSP has no say in whether the overlay can show
 * them. */
export function base64ToBlob(data: string, mediaType: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mediaType });
}
