import type { Rect } from "@/shared/types";
import { elementsAtPoint } from "./image-picker";
import { getRenderedImageRect } from "./overlay-layout";

export interface LiveRegion {
  /** Where the region is now, in viewport coordinates. Measures it again, so
   * a move that came without an event still counts. */
  measure(): Rect;
  dispose(): void;
}

// Elements that draw a picture of their own, such as a video or a game.
// Subtitles are part of that picture, or laid over it and scaled along with it.
const PICTURE_ELEMENTS = new Set([
  "canvas",
  "embed",
  "iframe",
  "img",
  "object",
  "video",
]);

/**
 * Keeps a region over the same part of the video (or other picture) it was
 * selected on. The page moves and resizes the video as it scrolls, zooms and
 * goes full screen, and the region moves and resizes with it. `onMove` gets
 * each new place.
 *
 * A region that is not over a picture stays where it was selected.
 */
export function followRegion(
  rect: Rect,
  ignore: Element | undefined,
  onMove: (rect: Rect) => void,
): LiveRegion {
  const picture = findPicture(rect, ignore);
  if (!picture) {
    return { measure: () => rect, dispose() {} };
  }

  // Shares of the picture hold however the page scales it.
  const start = pictureRect(picture);
  const share = {
    x: (rect.x - start.x) / start.width,
    y: (rect.y - start.y) / start.height,
    width: rect.width / start.width,
    height: rect.height / start.height,
  };
  let current = rect;

  const measure = (): Rect => {
    const box = pictureRect(picture);
    // While the picture is gone or hidden, the region stays where it was.
    if (!picture.isConnected || box.width <= 0 || box.height <= 0) {
      return current;
    }
    const next = {
      x: box.x + share.x * box.width,
      y: box.y + share.y * box.height,
      width: share.width * box.width,
      height: share.height * box.height,
    };
    if (
      next.x !== current.x ||
      next.y !== current.y ||
      next.width !== current.width ||
      next.height !== current.height
    ) {
      current = next;
      onMove(next);
    }
    return current;
  };
  const update = (): void => void measure();

  // Zooming and going full screen resize the window. The page can also resize
  // the picture on its own, such as for a wider player.
  window.addEventListener("resize", update);
  window.addEventListener("scroll", update, true);
  const observer = new ResizeObserver(update);
  observer.observe(picture);

  return {
    measure,
    dispose() {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      observer.disconnect();
    },
  };
}

/** The topmost picture under the middle of `rect` that holds most of it. */
function findPicture(
  rect: Rect,
  ignore: Element | undefined,
): HTMLElement | undefined {
  const holdsRegion = (element: Element): element is HTMLElement =>
    element instanceof HTMLElement &&
    PICTURE_ELEMENTS.has(element.localName) &&
    holdsMostOf(element.getBoundingClientRect(), rect);

  return (
    elementsAtPoint(
      document,
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
      ignore,
    ).find(holdsRegion) ??
    // Players can turn off pointer events on the video, which hides it from
    // hit testing.
    Array.from(document.getElementsByTagName("video")).find(holdsRegion)
  );
}

function holdsMostOf(box: DOMRect, rect: Rect): boolean {
  const width =
    Math.min(box.right, rect.x + rect.width) - Math.max(box.left, rect.x);
  const height =
    Math.min(box.bottom, rect.y + rect.height) - Math.max(box.top, rect.y);
  return (
    width > 0 && height > 0 && width * height >= (rect.width * rect.height) / 2
  );
}

/** Where `element` draws its picture. A video keeps its shape, with bars on
 * the sides or above and below when the element is a different shape. */
function pictureRect(element: HTMLElement): Rect {
  const box = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const [naturalWidth, naturalHeight] =
    element instanceof HTMLVideoElement
      ? [element.videoWidth, element.videoHeight]
      : element instanceof HTMLImageElement
        ? [element.naturalWidth, element.naturalHeight]
        : element instanceof HTMLCanvasElement
          ? [element.width, element.height]
          : [0, 0];
  return getRenderedImageRect({
    elementRect: { x: box.x, y: box.y, width: box.width, height: box.height },
    naturalWidth,
    naturalHeight,
    objectFit: style.objectFit,
    objectPosition: style.objectPosition,
  });
}
