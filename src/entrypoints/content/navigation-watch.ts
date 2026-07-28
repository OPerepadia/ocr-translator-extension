import type { ContentScriptContext } from "wxt/utils/content-script-context";

// A full page load tears the content script down, so the panel and overlay go
// with it. Same-document navigations (SPA routing, Back/Forward within the app)
// leave both pinned over content they no longer match, so close them when the
// route changes.
//
// WXT's "wxt:locationchange" does the detecting: the Navigation API where the
// browser has it, a poll otherwise. Its watcher runs until the content script is
// invalidated, so register on the first capture rather than at startup — pages
// where the extension is never used stay untouched.
let scriptContext: ContentScriptContext | undefined;
let watching = false;

export function setNavigationContext(context: ContentScriptContext): void {
  scriptContext = context;
}

// A fragment change is usually an in-page anchor jump, which leaves the page
// content (and so the captured region) alone. Hash-routed apps are the cost of
// not closing the overlay every time someone clicks a table-of-contents link.
export function hasNavigatedAway(previous: URL, current: URL): boolean {
  return (
    previous.origin !== current.origin ||
    previous.pathname !== current.pathname ||
    previous.search !== current.search
  );
}

// `onNavigate` also runs on pagehide, so leaving the page tears the UI down and
// a bfcache restore (Back into this page) doesn't bring a stale overlay with it.
// It must be safe to call with nothing on screen: only the first capture
// registers the listeners, and every later navigation fires them.
export function startNavigationWatch(onNavigate: () => void): void {
  if (watching || !scriptContext) {
    return;
  }
  watching = true;
  scriptContext.addEventListener(window, "wxt:locationchange", (event) => {
    if (hasNavigatedAway(event.oldUrl, event.newUrl)) {
      onNavigate();
    }
  });
  scriptContext.addEventListener(window, "pagehide", () => onNavigate());
}
