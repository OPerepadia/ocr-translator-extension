import { t } from "@/shared/i18n";

let cancelActivePicker: (() => void) | undefined;

export function cancelImagePickerOverlay(): void {
  cancelActivePicker?.();
}

export function cleanupImagePickerOnNavigation(
  isTopFrame: boolean,
  cancelLocal: () => void,
  endGlobal: () => void,
): void {
  if (isTopFrame) {
    endGlobal();
  } else {
    cancelLocal();
  }
}

export function startImagePickerOverlay(
  container: HTMLElement,
  options: { showDim?: boolean; showHint?: boolean } = {},
): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    cancelImagePickerOverlay();

    let currentImage: HTMLImageElement | undefined;

    const overlay = document.createElement("div");
    overlay.className = "ocr-translate-image-picker-overlay";

    const dim = document.createElement("div");
    dim.className = "ocr-translate-selection-dim";

    const frame = document.createElement("div");
    frame.className = "ocr-translate-image-picker-frame";

    const hint = document.createElement("div");
    hint.className =
      "ocr-translate-selection-hint ocr-translate-image-picker-hint";
    hint.append(t("imagePickerSelectImage"), document.createElement("br"));

    const hintSub = document.createElement("span");
    hintSub.className = "ocr-translate-selection-hint-sub";
    const keyMarker = "__KEY__";
    const [beforeKey, afterKey] = t(
      "selectionPressKeyToCancel",
      keyMarker,
    ).split(keyMarker);
    const key = document.createElement("kbd");
    key.className = "ocr-translate-selection-hint-kbd";
    key.textContent = "Esc";
    hintSub.append(beforeKey ?? "", key, afterKey ?? "");
    hint.append(hintSub);

    if (options.showDim !== false) {
      overlay.append(dim);
    }
    overlay.append(frame);
    if (options.showHint !== false) {
      overlay.append(hint);
    }
    container.append(overlay);
    const root = container.getRootNode();
    const uiHost = root instanceof ShadowRoot ? root.host : undefined;

    function cleanup(image: HTMLImageElement | null): void {
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", updateFrame, true);
      window.removeEventListener("resize", updateFrame);
      cancelActivePicker = undefined;
      overlay.remove();
      resolve(image);
    }

    function imageFromEvent(event: MouseEvent): HTMLImageElement | undefined {
      return findImageAtPoint(event.clientX, event.clientY, { ignore: uiHost });
    }

    function onPointerMove(event: PointerEvent): void {
      const image = imageFromEvent(event);
      if (image === currentImage) {
        return;
      }
      currentImage = image;
      updateFrame();
    }

    function onClick(event: MouseEvent): void {
      event.preventDefault();
      event.stopImmediatePropagation();
      const image = imageFromEvent(event);
      if (image) {
        cleanup(image);
      }
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      cleanup(null);
    }

    function updateFrame(): void {
      if (!currentImage?.isConnected) {
        currentImage = undefined;
        frame.hidden = true;
        dim.classList.remove("is-cutout");
        dim.removeAttribute("style");
        return;
      }

      const rect = currentImage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        currentImage = undefined;
        frame.hidden = true;
        dim.classList.remove("is-cutout");
        dim.removeAttribute("style");
        return;
      }

      frame.hidden = false;
      frame.style.left = `${rect.x}px`;
      frame.style.top = `${rect.y}px`;
      frame.style.width = `${rect.width}px`;
      frame.style.height = `${rect.height}px`;
      dim.classList.add("is-cutout");
      dim.style.left = `${rect.x}px`;
      dim.style.top = `${rect.y}px`;
      dim.style.width = `${rect.width}px`;
      dim.style.height = `${rect.height}px`;
    }

    cancelActivePicker = () => cleanup(null);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", updateFrame, true);
    window.addEventListener("resize", updateFrame);
  });
}

// Elements that paint content over whatever is under them.
const REPLACED_ELEMENTS = new Set([
  "canvas",
  "embed",
  "iframe",
  "img",
  "object",
  "svg",
  "video",
]);

// The topmost image a user can see at a viewport point. Hit testing already
// skips clipped, hidden, and inert images; this also skips images behind a
// backdrop or panel, such as the page under a lightbox. Images with
// pointer-events: none are skipped too: bounds alone can't tell whether they
// are visible.
export function findImageAtPoint(
  x: number,
  y: number,
  options: { minSize?: number; ignore?: Element } = {},
): HTMLImageElement | undefined {
  const { minSize = 0, ignore } = options;
  const stack = elementsAtPoint(document, x, y, ignore);

  for (const [index, element] of stack.entries()) {
    if (
      element instanceof HTMLImageElement &&
      isSelectableImage(element, minSize) &&
      !isCovered(element, stack.slice(0, index))
    ) {
      return element;
    }
  }
  return undefined;
}

// Hit testing reports a shadow tree as its host. Open shadow trees are
// expanded in place, each element listed just above its host.
export function elementsAtPoint(
  root: Document | ShadowRoot,
  x: number,
  y: number,
  ignore: Element | undefined,
): Element[] {
  return root.elementsFromPoint(x, y).flatMap((element) => {
    // A shadow root also reports the elements around it; the caller has them.
    if (element === ignore || element.getRootNode() !== root) {
      return [];
    }
    const shadow = element.shadowRoot;
    return shadow
      ? [...elementsAtPoint(shadow, x, y, ignore), element]
      : [element];
  });
}

// Overlays that stay within the image (captions, badges, transparent click
// catchers) leave it visible; a painted layer reaching past it hides it.
function isCovered(image: HTMLImageElement, above: Element[]): boolean {
  const bounds = image.getBoundingClientRect();
  return above.some(
    (element) =>
      !element.contains(image) &&
      !isWithin(element.getBoundingClientRect(), bounds) &&
      paints(element),
  );
}

function isWithin(inner: DOMRect, outer: DOMRect): boolean {
  return (
    inner.left >= outer.left - 1 &&
    inner.top >= outer.top - 1 &&
    inner.right <= outer.right + 1 &&
    inner.bottom <= outer.bottom + 1
  );
}

function paints(element: Element): boolean {
  const style = getComputedStyle(element);
  if (style.opacity === "0") {
    return false;
  }
  return (
    REPLACED_ELEMENTS.has(element.localName) ||
    style.backgroundImage !== "none" ||
    !isTransparent(style.backgroundColor)
  );
}

function isTransparent(color: string): boolean {
  return (
    color === "transparent" ||
    /^rgba\(.*,\s*0\)$/.test(color) ||
    /\/\s*0\)$/.test(color)
  );
}

function isSelectableImage(image: HTMLImageElement, minSize = 0): boolean {
  if (!image.currentSrc && !image.src) {
    return false;
  }
  const rect = image.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.width >= minSize &&
    rect.height >= minSize
  );
}
