import { browser } from "wxt/browser";
import { t } from "../shared/i18n";

export type ContextMenuApi = {
  runtime: {
    onInstalled: Pick<typeof browser.runtime.onInstalled, "addListener">;
  };
  contextMenus?: {
    create: typeof browser.contextMenus.create;
    update: typeof browser.contextMenus.update;
    onClicked: Pick<typeof browser.contextMenus.onClicked, "addListener">;
  };
  tabs: Pick<typeof browser.tabs, "sendMessage">;
};

export const START_SELECTION_MENU_ID = "select-region-for-ocr";
export const TRANSLATE_IMAGE_MENU_ID = "translate-image";

// Restrict menus to pages where the content script can run. This hides them on
// privileged internal pages (about:, chrome://) where sendMessage would fail.
const CONTENT_SCRIPT_PATTERNS = ["http://*/*", "https://*/*", "file:///*"];

export function startContextMenu(
  api: ContextMenuApi = browser,
  localeReady: Promise<unknown> = Promise.resolve(),
): void {
  const contextMenus = api.contextMenus;
  if (!contextMenus) {
    return;
  }

  api.runtime.onInstalled.addListener(async () => {
    await localeReady;
    contextMenus.create({
      id: START_SELECTION_MENU_ID,
      title: t("contextTranslateScreenRegion"),
      contexts: ["page"],
      documentUrlPatterns: CONTENT_SCRIPT_PATTERNS,
    });
    contextMenus.create({
      id: TRANSLATE_IMAGE_MENU_ID,
      title: t("contextTranslateImage"),
      contexts: ["image"],
      documentUrlPatterns: CONTENT_SCRIPT_PATTERNS,
    });
  });

  void localeReady.then(() => updateContextMenuTitles(api));

  contextMenus.onClicked.addListener((info, tab) => {
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

export async function updateContextMenuTitles(
  api: Pick<ContextMenuApi, "contextMenus"> = browser,
): Promise<void> {
  if (!api.contextMenus) return;
  await Promise.allSettled([
    api.contextMenus.update(START_SELECTION_MENU_ID, {
      title: t("contextTranslateScreenRegion"),
    }),
    api.contextMenus.update(TRANSLATE_IMAGE_MENU_ID, {
      title: t("contextTranslateImage"),
    }),
  ]);
}
