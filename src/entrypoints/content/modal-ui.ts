export function getUiAnchor(): HTMLElement {
  const focusedModal = document.activeElement?.closest<HTMLDialogElement>(
    "dialog[open]:modal",
  );
  return focusedModal ?? Array.from(
    document.querySelectorAll<HTMLDialogElement>("dialog[open]:modal"),
  ).at(-1) ?? getFullscreenAnchor() ?? document.body;
}

// Elements that draw only their own picture, so a child of theirs would not show.
const UNHOSTABLE_FULLSCREEN = new Set([
  "audio",
  "canvas",
  "embed",
  "iframe",
  "img",
  "object",
  "video",
]);

// While an element is full screen the browser shows nothing outside it, so the
// UI has to live inside it. A popover does not get around this.
function getFullscreenAnchor(): HTMLElement | undefined {
  let element: Element | null = document.fullscreenElement;
  // A page component reports itself as the full screen element; what gets
  // drawn is the element inside its shadow tree.
  while (element?.shadowRoot?.fullscreenElement) {
    element = element.shadowRoot.fullscreenElement;
  }
  return element instanceof HTMLElement &&
    !UNHOSTABLE_FULLSCREEN.has(element.localName)
    ? element
    : undefined;
}

/**
 * Moves the UI into whatever the page puts full screen, and back out
 * afterwards. A UI inside a modal dialog is left alone, since the modal watch
 * above owns where that one lives.
 */
export function watchFullscreen(host: HTMLElement): () => void {
  // Where the UI was before it went into the fullscreen element. Unknown when
  // it was first mounted there; it then goes back to the body.
  let home: Node | null = null;
  let inside = false;

  const follow = (): void => {
    if (host.parentElement instanceof HTMLDialogElement) {
      return;
    }
    const anchor = getFullscreenAnchor();
    if (anchor) {
      if (host.parentElement !== anchor) {
        home ??= host.parentNode;
        anchor.append(host);
      }
      inside = true;
    } else if (inside) {
      (home?.isConnected ? home : document.body).appendChild(host);
      home = null;
      inside = false;
    }
  };

  document.addEventListener("fullscreenchange", follow);
  follow();
  return () => document.removeEventListener("fullscreenchange", follow);
}

export function watchUiModal(
  host: HTMLElement,
  container: HTMLElement,
  onClose: () => void,
): () => void {
  const modal = host.parentElement;
  if (!(modal instanceof HTMLDialogElement) || !modal.matches(":modal")) {
    return () => {};
  }

  // Stay inside the modal for input, but escape its containing block for layout.
  container.classList.add("ocr-translate-modal-surface");
  container.popover = "manual";
  container.showPopover();

  const observer = new MutationObserver(() => {
    if (!modal.isConnected || !modal.open || host.parentElement !== modal) {
      dismiss();
    }
  });
  function stop(): void {
    observer.disconnect();
    modal?.removeEventListener("close", dismiss);
    if (container.matches(":popover-open")) {
      container.hidePopover();
    }
    container.removeAttribute("popover");
    container.classList.remove("ocr-translate-modal-surface");
  }
  function dismiss(): void {
    stop();
    onClose();
    host.remove();
  }

  modal.addEventListener("close", dismiss);
  observer.observe(modal, { attributes: true, attributeFilter: ["open"] });
  // Removing a dialog (or its ancestor) does not fire its close event.
  observer.observe(document, { childList: true, subtree: true });
  return stop;
}
