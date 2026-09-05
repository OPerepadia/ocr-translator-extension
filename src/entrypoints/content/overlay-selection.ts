// Stabilize mouse selection over OCR text by mapping the pointer to character
// boundaries and buffering line transitions. Keep native highlighting and copying;
// leave modified clicks, multi-clicks, and unsupported text layouts to the browser.

import type { Rect } from "@/shared/types";

export interface SelectionLine {
  rect: Rect;
  vertical: boolean;
  stops: Array<{ x: number; y: number; node: Text; offset: number }>;
}

export function selectionTarget(
  lines: SelectionLine[],
  point: { x: number; y: number },
  previous?: number,
): { line: number; stop: SelectionLine["stops"][number] } {
  const distances = lines.map(({ rect, vertical }) => {
    const across = vertical ? point.x : point.y;
    const start = vertical ? rect.x : rect.y;
    const size = vertical ? rect.width : rect.height;
    const along = vertical ? point.y : point.x;
    const alongStart = vertical ? rect.y : rect.x;
    const alongSize = vertical ? rect.height : rect.width;
    // Passing a line's end must not favor a longer neighboring line.
    return (
      Math.max(start - across, 0, across - start - size) +
      Math.max(alongStart - along, 0, along - alongStart - alongSize) * 0.001
    );
  });
  let line = distances.indexOf(Math.min(...distances));
  if (previous !== undefined) {
    const rect = lines[previous].rect;
    const tolerance = Math.min(
      4,
      (lines[previous].vertical ? rect.width : rect.height) * 0.2,
    );
    if (distances[previous] <= distances[line] + tolerance) {
      line = previous;
    }
  }
  const { stops, vertical } = lines[line];
  const coordinate = vertical ? "y" : "x";
  const stop = stops.reduce((best, candidate) =>
    Math.abs(candidate[coordinate] - point[coordinate]) <
    Math.abs(best[coordinate] - point[coordinate])
      ? candidate
      : best,
  );
  return { line, stop };
}

export function startTextSelection(
  event: MouseEvent,
  layer: HTMLElement,
  angle: number,
  onEnd: () => void,
): (() => void) | undefined {
  if (
    event.button !== 0 || event.detail > 1 || event.shiftKey ||
    event.ctrlKey || event.metaKey || event.altKey
  ) {
    return;
  }
  if (getComputedStyle(layer).direction === "rtl") return;
  const selection = window.getSelection();
  if (!selection) return;
  const grouped = new Map<string, SelectionLine>();
  const spans = layer.querySelectorAll<HTMLElement>(
    ".ocr-translate-overlay-text-layer-line",
  );
  for (const span of spans) {
    const node = span.firstChild;
    if (!(node instanceof Text)) continue;
    // Whole-line fallback text keeps the browser's font-aware caret placement.
    if (span.dataset.character !== "true") return;
    const rect = {
      x: Number(span.dataset.x),
      y: Number(span.dataset.y),
      width: Number(span.dataset.width),
      height: Number(span.dataset.height),
    };
    const vertical = span.classList.contains("is-vertical");
    const key = span.dataset.line!;
    let line = grouped.get(key);
    if (!line) {
      line = { rect: { ...rect }, vertical, stops: [] };
      grouped.set(key, line);
    } else {
      const right = Math.max(line.rect.x + line.rect.width, rect.x + rect.width);
      const bottom = Math.max(line.rect.y + line.rect.height, rect.y + rect.height);
      line.rect.x = Math.min(line.rect.x, rect.x);
      line.rect.y = Math.min(line.rect.y, rect.y);
      line.rect.width = right - line.rect.x;
      line.rect.height = bottom - line.rect.y;
    }
    line.stops.push(
      { x: rect.x, y: rect.y, node, offset: 0 },
      {
        x: vertical ? rect.x : rect.x + rect.width,
        y: vertical ? rect.y + rect.height : rect.y,
        node,
        offset: node.length,
      },
    );
  }
  const lines = [...grouped.values()];
  if (!lines.length) return;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  function point(e: MouseEvent): { x: number; y: number } {
    const bounds = layer.getBoundingClientRect();
    const dx = e.clientX - (bounds.left + bounds.width / 2);
    const dy = e.clientY - (bounds.top + bounds.height / 2);
    return {
      x: dx * cos + dy * sin + layer.clientWidth / 2,
      y: dy * cos - dx * sin + layer.clientHeight / 2,
    };
  }
  let target = selectionTarget(lines, point(event));
  const anchor = target.stop;
  selection.setBaseAndExtent(anchor.node, anchor.offset, anchor.node, anchor.offset);
  event.preventDefault();
  function move(e: PointerEvent): void {
    if (e.pointerType !== "mouse") return;
    if (!layer.isConnected || !(e.buttons & 1)) {
      onEnd();
      return;
    }
    const next = selectionTarget(lines, point(e), target.line);
    if (next.stop.node !== target.stop.node || next.stop.offset !== target.stop.offset) {
      selection!.setBaseAndExtent(
        anchor.node, anchor.offset, next.stop.node, next.stop.offset,
      );
    }
    target = next;
    e.preventDefault();
  }
  document.addEventListener("pointermove", move, true);
  window.addEventListener("blur", onEnd);
  return () => {
    document.removeEventListener("pointermove", move, true);
    window.removeEventListener("blur", onEnd);
  };
}
