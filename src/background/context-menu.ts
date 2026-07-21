import { browserApi, type BrowserApi } from "../shared/browser";

export const START_SELECTION_MENU_ID = "select-region-for-ocr";

export function startContextMenu(api: BrowserApi = browserApi): void {
  api.runtime.onInstalled.addListener(() => {
    api.contextMenus.create({
      id: START_SELECTION_MENU_ID,
      title: "Select region for OCR",
      contexts: ["all"],
    });
  });

  api.contextMenus.onClicked.addListener((info, tab) => {
    if (
      info.menuItemId !== START_SELECTION_MENU_ID ||
      typeof tab?.id !== "number"
    ) {
      return;
    }

    void api.tabs
      .sendMessage(tab.id, { type: "START_SELECTION" })
      .catch((error) =>
        console.error(
          "[Screen OCR Translator] Failed to start selection",
          error,
        ),
      );
  });
}
