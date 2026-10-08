import { browser } from "wxt/browser";
import {
  cropBitmapToBlob,
  cropBitmapToCanvas,
  dataUrlToImageBitmap,
  roundCropRect,
} from "../shared/image";
import { t } from "../shared/i18n";
import { fetchWithModifiedHeaders } from "../shared/fetch-with-modified-headers";
import type { Rect, Viewport } from "../shared/types";
import { createThrottle } from "./capture-throttle";
import { createFrameSignature, type FrameSignature } from "./frame-signature";

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
    return await cropBitmapToBlob(
      bitmap,
      toDeviceRect(bitmap, args.rect, args.viewport),
    );
  } finally {
    bitmap.close();
  }
}

/** A viewport rect clipped to the viewport and scaled to the screenshot's
 * pixels. Throws when nothing of it is visible. */
function toDeviceRect(
  bitmap: { width: number; height: number },
  rect: Rect,
  viewport: Viewport,
): Rect {
  const dprX = bitmap.width / viewport.width;
  const dprY = bitmap.height / viewport.height;

  const left = clamp(rect.x, 0, viewport.width);
  const top = clamp(rect.y, 0, viewport.height);
  const right = clamp(rect.x + rect.width, 0, viewport.width);
  const bottom = clamp(rect.y + rect.height, 0, viewport.height);

  if (right <= left || bottom <= top) {
    throw new Error(t("errorSelectionOutsideVisibleArea"));
  }

  return {
    x: left * dprX,
    y: top * dprY,
    width: (right - left) * dprX,
    height: (bottom - top) * dprY,
  };
}

/** A region of the screen as captured for live translation. */
export interface LiveFrame {
  /** Screenshot pixels per CSS pixel of height. */
  pixelRatio: number;
  signature: FrameSignature;
  /** Encoded on demand: a frame that looks unchanged is never read. */
  toBlob(): Promise<Blob>;
}

// Chrome allows two captures a second and counts a refused one, so stay
// clear of the limit.
const LIVE_CAPTURE_GAP_MS = 600;
// A screenshot of the whole viewport is the costly step of each frame. JPEG
// encodes it several times faster than PNG, and at this quality the text
// stays clean enough to read.
const LIVE_CAPTURE_QUALITY = 92;
const LIVE_MASK_FILL = "#808080";

const waitForLiveCaptureSlot = createThrottle(LIVE_CAPTURE_GAP_MS);

/**
 * Capture a region for live translation. `mask` is a viewport rect to paint
 * over first, which hides the extension's own panel where it overlaps.
 *
 * The screenshot is of the active tab in `windowId`. Resolves to `undefined`
 * when `tabId` is not that tab before or after the capture, since the user
 * switched tabs and the screenshot would be of another page.
 */
export async function captureLiveFrame(args: {
  rect: Rect;
  viewport: Viewport;
  mask?: Rect;
  tabId: number;
  windowId: number;
}): Promise<LiveFrame | undefined> {
  await waitForLiveCaptureSlot();
  if (!(await isActiveTab(args.tabId, args.windowId))) {
    return undefined;
  }
  const options = { format: "jpeg", quality: LIVE_CAPTURE_QUALITY } as const;
  const dataUrl = await browser.tabs.captureVisibleTab(args.windowId, options);
  if (!(await isActiveTab(args.tabId, args.windowId))) {
    return undefined;
  }
  const bitmap = await dataUrlToImageBitmap(dataUrl);

  try {
    const crop = roundCropRect(toDeviceRect(bitmap, args.rect, args.viewport));
    const canvas = cropBitmapToCanvas(bitmap, crop);
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error(t("errorCanvasContext"));
    }

    if (args.mask) {
      const mask = maskRectInCrop(args.mask, crop, bitmap, args.viewport);
      context.fillStyle = LIVE_MASK_FILL;
      context.fillRect(mask.x, mask.y, mask.width, mask.height);
    }

    return {
      pixelRatio: bitmap.height / args.viewport.height,
      signature: createFrameSignature(
        context.getImageData(0, 0, canvas.width, canvas.height),
      ),
      toBlob: () => canvas.convertToBlob({ type: "image/png" }),
    };
  } finally {
    bitmap.close();
  }
}

async function isActiveTab(tabId: number, windowId: number): Promise<boolean> {
  const [activeTab] = await browser.tabs.query({ active: true, windowId });
  return activeTab?.id === tabId;
}

/** A viewport rect as a position in the cropped canvas, rounded outwards so
 * the mask covers every pixel it touches. */
export function maskRectInCrop(
  mask: Rect,
  crop: Rect,
  bitmap: { width: number; height: number },
  viewport: Viewport,
): Rect {
  const dprX = bitmap.width / viewport.width;
  const dprY = bitmap.height / viewport.height;

  const left = Math.floor(mask.x * dprX - crop.x);
  const top = Math.floor(mask.y * dprY - crop.y);
  const right = Math.ceil((mask.x + mask.width) * dprX - crop.x);
  const bottom = Math.ceil((mask.y + mask.height) * dprY - crop.y);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
