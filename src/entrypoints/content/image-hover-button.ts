import { t } from "@/shared/i18n";
import type { Rect } from "@/shared/types";
import { TRANSLATE_ICON } from "./icons";
import { findImageAtPoint } from "./image-picker";
import { renderedImageRect } from "./image-rect";

// Smaller images are icons and thumbnails.
const MIN_PICTURE_SIZE = 150;
const MOUNT_RETRY_MS = 3000;

export interface ImageHoverButtonOptions {
  /** The UI root, once it is mounted where the page shows it. */
  getReadyUiRoot(): HTMLElement | undefined;
  /** The shadow host of the UI. */
  getUiHost(): Element | undefined;
  /** Mounts the page UI. */
  mountUi(): Promise<void>;
  /** True while the button should stay hidden. */
  isPaused(): boolean;
  onTranslate(image: HTMLImageElement): void;
}

interface Picture {
  image: HTMLImageElement;
  rect: Rect;
}

// Shows a translate button in the corner of an image under the pointer.
// Returns a function that removes the button.
export function startImageHoverButton(
  options: ImageHoverButtonOptions,
): () => void {
  let button: HTMLButtonElement | undefined;
  let target: HTMLImageElement | undefined;
  let clicked: HTMLImageElement | undefined;
  let point: { x: number; y: number } | undefined;
  let frame = 0;
  let stopped = false;
  let mounting = false;
  // No new mount attempt before this time.
  let retryAt = 0;

  function schedule(): void {
    if (!stopped) {
      frame ||= requestAnimationFrame(update);
    }
  }

  function hide(): void {
    target = undefined;
    if (button) {
      button.hidden = true;
    }
  }

  function update(): void {
    frame = 0;
    if (!point || options.isPaused()) {
      hide();
      return;
    }
    // Other extension UI is under the pointer.
    const host = options.getUiHost();
    if (host && isOtherUiAt(host, point.x, point.y)) {
      hide();
      return;
    }
    const picture = pictureAt(point.x, point.y, host);
    // Stay hidden on a clicked image until the pointer leaves it.
    if (picture?.image !== clicked) {
      clicked = undefined;
    }
    if (!picture || picture.image === clicked) {
      hide();
      return;
    }
    show(picture);
  }

  function isOtherUiAt(host: Element, x: number, y: number): boolean {
    if (document.elementsFromPoint(x, y)[0] !== host) {
      return false;
    }
    // Over the button, the top element is its icon.
    const top = host.shadowRoot?.elementsFromPoint(x, y)[0];
    return !(top && button?.contains(top));
  }

  function show({ image, rect }: Picture): void {
    const root = options.getReadyUiRoot();
    if (!root) {
      mountUi();
      return;
    }
    // Hide when the corner is off screen or covered, such as by a page header.
    const top = rect.y;
    const right = rect.x + rect.width;
    const host = options.getUiHost();
    if (findImageAtPoint(right - 24, top + 24, host) !== image) {
      hide();
      return;
    }

    button ??= createButton();
    if (button.parentElement !== root) {
      root.append(button);
    }
    target = image;
    // The stylesheet moves the button in from this corner.
    button.style.left = `${right}px`;
    button.style.top = `${top}px`;
    button.hidden = false;
  }

  // Mount the UI on first use, then draw the button on the next frame.
  function mountUi(): void {
    if (mounting || Date.now() < retryAt) {
      return;
    }
    mounting = true;
    options.mountUi().then(
      () => {
        mounting = false;
        if (options.getReadyUiRoot()) {
          schedule();
        } else {
          retryAt = Date.now() + MOUNT_RETRY_MS;
        }
      },
      (error: unknown) => {
        mounting = false;
        retryAt = Date.now() + MOUNT_RETRY_MS;
        console.error(
          "[Screen OCR Translator] Failed to show the image button",
          error,
        );
      },
    );
  }

  function createButton(): HTMLButtonElement {
    const created = document.createElement("button");
    created.type = "button";
    created.className = "ocr-translate-image-button";
    created.hidden = true;
    created.title = t("contextTranslateImage");
    created.setAttribute("aria-label", t("contextTranslateImage"));
    created.innerHTML = TRANSLATE_ICON;
    // Keep presses on the button from reaching the page.
    for (const type of ["pointerdown", "mousedown"]) {
      created.addEventListener(type, (event) => event.stopPropagation());
    }
    created.addEventListener("click", (event) => {
      event.stopPropagation();
      const image = target;
      hide();
      if (image?.isConnected) {
        clicked = image;
        options.onTranslate(image);
      }
    });
    return created;
  }

  function onPointerMove(event: PointerEvent): void {
    // Touch has no hover.
    if (event.pointerType === "touch") {
      return;
    }
    point = { x: event.clientX, y: event.clientY };
    schedule();
  }

  // The menu can translate the image from a screenshot, so keep the button
  // off that image until the pointer leaves it.
  function onContextMenu(event: MouseEvent): void {
    const host = options.getUiHost();
    const picture = pictureAt(event.clientX, event.clientY, host);
    if (picture) {
      clicked = picture.image;
      hide();
    }
  }

  function onPointerOut(event: PointerEvent): void {
    // The pointer left the window.
    if (!event.relatedTarget) {
      point = undefined;
      schedule();
    }
  }

  const listener = { capture: true, passive: true } as const;
  document.addEventListener("pointermove", onPointerMove, listener);
  document.addEventListener("pointerout", onPointerOut, listener);
  document.addEventListener("contextmenu", onContextMenu, listener);
  // The page can move under a still pointer.
  window.addEventListener("scroll", schedule, listener);
  window.addEventListener("resize", schedule);

  return () => {
    stopped = true;
    document.removeEventListener("pointermove", onPointerMove, listener);
    document.removeEventListener("pointerout", onPointerOut, listener);
    document.removeEventListener("contextmenu", onContextMenu, listener);
    window.removeEventListener("scroll", schedule, listener);
    window.removeEventListener("resize", schedule);
    cancelAnimationFrame(frame);
    button?.remove();
  };
}

// The image at a point, if it is big enough. Images in iframes are left to
// their own frame.
function pictureAt(
  x: number,
  y: number,
  ignore: Element | undefined,
): Picture | undefined {
  const image = findImageAtPoint(x, y, ignore);
  if (!(image instanceof HTMLImageElement)) {
    return undefined;
  }
  const rect = renderedImageRect(image);
  return rect && rect.width >= MIN_PICTURE_SIZE && rect.height >= MIN_PICTURE_SIZE
    ? { image, rect }
    : undefined;
}
