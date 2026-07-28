import { browserApi, type BrowserApi } from "../shared/browser";

export const START_SELECTION_MENU_ID = "select-region-for-ocr";
export const TRANSLATE_IMAGE_MENU_ID = "translate-image";

// Restrict menus to pages where the content script can run. This hides them on
// privileged internal pages (about:, chrome://) where sendMessage would fail.
const CONTENT_SCRIPT_PATTERNS = ["http://*/*", "https://*/*", "file:///*"];

export function startContextMenu(api: BrowserApi = browserApi): void {
  api.runtime.onInstalled.addListener(() => {
    api.contextMenus.create({
      id: START_SELECTION_MENU_ID,
      title: "Translate a screen region…",
      contexts: ["page"],
      documentUrlPatterns: CONTENT_SCRIPT_PATTERNS,
    });
    api.contextMenus.create({
      id: TRANSLATE_IMAGE_MENU_ID,
      title: "Translate this image",
      contexts: ["image"],
      documentUrlPatterns: CONTENT_SCRIPT_PATTERNS,
    });
  });

  api.contextMenus.onClicked.addListener((info, tab) => {
    if (typeof tab?.id !== "number") {
      return;
    }

    const message =
      info.menuItemId === START_SELECTION_MENU_ID
        ? { type: "START_SELECTION" as const }
        : info.menuItemId === TRANSLATE_IMAGE_MENU_ID && info.srcUrl
          ? {
              type: "START_IMAGE_TRANSLATION" as const,
              imageUrl: info.srcUrl,
            }
          : undefined;

    if (!message) {
      return;
    }

    const frameId =
      info.menuItemId === TRANSLATE_IMAGE_MENU_ID ? info.frameId : 0;
    void api.tabs
      .sendMessage(tab.id, message, { frameId: frameId ?? 0 })
      .catch((error) =>
        console.error(
          "[Screen OCR Translator] Failed to start translation",
          error,
        ),
      );
  });
}
