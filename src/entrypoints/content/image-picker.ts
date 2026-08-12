import { t } from "@/shared/i18n";

let cancelActivePicker: (() => void) | undefined;

export function cancelImagePickerOverlay(): void {
  cancelActivePicker?.();
}

export function startImagePickerOverlay(
  container: HTMLElement,
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

    overlay.append(dim, frame, hint);
    container.append(overlay);

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

    function imageFromEvent(event: Event): HTMLImageElement | undefined {
      const image = event
        .composedPath()
        .find(
          (target): target is HTMLImageElement =>
            target instanceof HTMLImageElement,
        );
      if (!image || !image.currentSrc && !image.src) {
        return undefined;
      }
      const rect = image.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? image : undefined;
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
