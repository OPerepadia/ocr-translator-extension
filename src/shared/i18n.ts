import { browserApi } from "./browser";

export function localizeMarkedElements(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.dataset.i18n;
    if (!key) {
      continue;
    }

    const message = browserApi.i18n.getMessage(key);
    if (message) {
      element.textContent = message;
    }
  }
}
