import type { Rect } from "@/shared/types";

let container: HTMLElement | undefined;
let backdrop: HTMLElement | undefined;
let frame: HTMLElement | undefined;
let currentRect: Rect | undefined;
let repositionHandler: (() => void) | undefined;

export function showRegionOutline(root: HTMLElement, rect: Rect): void {
  currentRect = rect;
  if (!container) {
    container = document.createElement("div");
    container.className = "ocr-translate-region-outline";
    backdrop = document.createElement("div");
    backdrop.className = "ocr-translate-overlay-dim";
    frame = document.createElement("div");
    frame.className = "ocr-translate-overlay-region";
    container.append(backdrop, frame);
    root.append(container);

    repositionHandler = positionRegion;
    window.addEventListener("scroll", repositionHandler, { passive: true });
    window.addEventListener("resize", repositionHandler);
  }
  positionRegion();
}

export function closeRegionOutline(): void {
  if (repositionHandler) {
    window.removeEventListener("scroll", repositionHandler);
    window.removeEventListener("resize", repositionHandler);
    repositionHandler = undefined;
  }
  container?.remove();
  container = undefined;
  backdrop = undefined;
  frame = undefined;
  currentRect = undefined;
}

function positionRegion(): void {
  if (!backdrop || !frame || !currentRect) {
    return;
  }
  for (const element of [backdrop, frame]) {
    element.style.left = `${currentRect.x - window.scrollX}px`;
    element.style.top = `${currentRect.y - window.scrollY}px`;
    element.style.width = `${currentRect.width}px`;
    element.style.height = `${currentRect.height}px`;
  }
}
