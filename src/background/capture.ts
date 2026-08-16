import { browserApi } from "../shared/browser";
import { cropBitmapToBlob, dataUrlToImageBitmap } from "../shared/image";
import { t } from "../shared/i18n";
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
  const requestUrl = new URL(url).href;
  const ruleId = createRuleId();
  const initiator = new URL(browserApi.runtime.getURL("")).hostname;

  // Limit the temporary rule to this extension and this exact image URL.
  await browserApi.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [
      {
        id: ruleId,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Referer", operation: "set", value: referrer },
          ],
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
    return await fetch(requestUrl, { credentials: "include" });
  } finally {
    await browserApi.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
    });
  }
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

function createRuleId(): number {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return (value & 0x7fffffff) || 1;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const dataUrl = await browserApi.tabs.captureVisibleTab(null, {
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
