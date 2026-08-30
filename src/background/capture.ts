import { browser } from "wxt/browser";
import { cropBitmapToBlob, dataUrlToImageBitmap } from "../shared/image";
import { t } from "../shared/i18n";
import { fetchWithModifiedHeaders } from "../shared/fetch-with-modified-headers";
import type { Rect, Viewport } from "../shared/types";

export async function loadImage(url: string, pageUrl?: string): Promise<Blob> {
  // Image hosts such as pixiv reject extension requests without the page Referer.
  const referrer = resolveReferrer(url, pageUrl);
  const response = referrer
    ? await fetchWithReferrer(url, referrer)
    : await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(t("errorCouldNotLoadImage", String(response.status)));
  }
  return response.blob();
}

async function fetchWithReferrer(
  url: string,
  referrer: string,
): Promise<Response> {
  return fetchWithModifiedHeaders(
    url,
    { credentials: "include" },
    [{ header: "Referer", operation: "set", value: referrer }],
  );
}

function resolveReferrer(imageUrl: string, pageUrl?: string): string | undefined {
  if (!pageUrl) {
    return undefined;
  }

  const image = new URL(imageUrl);
  const page = new URL(pageUrl);
  if (
    !["http:", "https:"].includes(image.protocol) ||
    !["http:", "https:"].includes(page.protocol) ||
    (page.protocol === "https:" && image.protocol === "http:")
  ) {
    return undefined;
  }

  page.hash = "";
  return page.origin === image.origin ? page.href : `${page.origin}/`;
}

/**
 * Capture the visible tab and crop the selected region out of it.
 *
 * The selection rect is in viewport CSS pixels. We derive the effective
 * device-pixel ratio from the captured screenshot size divided by the
 * viewport size (rather than trusting window.devicePixelRatio), because at
 * non-standard zoom levels the two do not match and the crop would drift.
 */
export async function captureVisibleArea(args: {
  rect: Rect;
  viewport: Viewport;
}): Promise<Blob> {
  const dataUrl = await browser.tabs.captureVisibleTab({
    format: "png",
  });
  const bitmap = await dataUrlToImageBitmap(dataUrl);

  try {
    const dprX = bitmap.width / args.viewport.width;
    const dprY = bitmap.height / args.viewport.height;

    const left = clamp(args.rect.x, 0, args.viewport.width);
    const top = clamp(args.rect.y, 0, args.viewport.height);
    const right = clamp(args.rect.x + args.rect.width, 0, args.viewport.width);
    const bottom = clamp(
      args.rect.y + args.rect.height,
      0,
      args.viewport.height,
    );

    if (right <= left || bottom <= top) {
      throw new Error(t("errorSelectionOutsideVisibleArea"));
    }

    return await cropBitmapToBlob(bitmap, {
      x: left * dprX,
      y: top * dprY,
      width: (right - left) * dprX,
      height: (bottom - top) * dprY,
    });
  } finally {
    bitmap.close();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
