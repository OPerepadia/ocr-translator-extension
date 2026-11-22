import type { Rect } from "@/shared/types";
import { getRenderedImageRect } from "./overlay-layout";

// The part of an <img> that shows the picture, without object-fit bars.
// Undefined while the image has no size.
export function renderedImageRect(image: HTMLImageElement): Rect | undefined {
  const rect = image.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return undefined;
  }
  const style = getComputedStyle(image);
  return getRenderedImageRect({
    elementRect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    objectFit: style.objectFit,
    objectPosition: style.objectPosition,
  });
}
