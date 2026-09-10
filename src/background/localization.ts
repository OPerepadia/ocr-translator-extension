import { browser } from "wxt/browser";
import { applyUiLocale, initializeI18n } from "../shared/i18n";
import { updateContextMenuTitles } from "./context-menu";

export function startBackgroundLocalization(): Promise<unknown> {
  const ready = initializeI18n();
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.uiLocale) return;
    // Let startup finish before applying a newer value from storage.
    void ready.then(() => {
      applyUiLocale(changes.uiLocale.newValue);
      return updateContextMenuTitles();
    });
  });
  return ready;
}
