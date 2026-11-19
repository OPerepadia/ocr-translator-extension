import { IMAGE_LOAD_ERROR } from "@/shared/messages";
import type { Rect, Viewport } from "@/shared/types";

// Returns the visible part of the image to screenshot.
// Returns undefined for other errors or when the image is not on screen.
export function screenshotFallbackRect(
  error: unknown,
  imageRect: Rect | undefined,
  viewport: Viewport,
): Rect | undefined {
  if (!(error instanceof Error) || error.name !== IMAGE_LOAD_ERROR) {
    return undefined;
  }
  if (!imageRect) {
    return undefined;
  }

  const left = Math.max(imageRect.x, 0);
  const top = Math.max(imageRect.y, 0);
  const right = Math.min(imageRect.x + imageRect.width, viewport.width);
  const bottom = Math.min(imageRect.y + imageRect.height, viewport.height);
  if (right <= left || bottom <= top) {
    return undefined;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}
