import type { Rect } from "./types";

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
    throw new Error("Could not create OffscreenCanvas 2D context.");
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
