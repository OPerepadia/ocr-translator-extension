import { browser } from "wxt/browser";

export function t(key: string, substitutions?: string | string[]): string {
  const getMessage = browser.i18n.getMessage as (
    messageName: string,
    substitutions?: string | string[],
  ) => string;
  return getMessage(key, substitutions) || key;
}

export function localizeMarkedElements(root: ParentNode = document): void {
  if (root instanceof Document) {
    root.documentElement.lang = uiLanguage();
    root.documentElement.dir = uiDirection();
  }

  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.dataset.i18n;
    if (key) {
      element.textContent = t(key);
    }
  }

  for (const attribute of ["aria-label", "placeholder", "title"] as const) {
    for (const element of root.querySelectorAll<HTMLElement>(
      `[data-i18n-${attribute}]`,
    )) {
      const key = element.getAttribute(`data-i18n-${attribute}`);
      if (key) {
        element.setAttribute(attribute, t(key));
      }
    }
  }
}

export function uiLanguage(): string {
  return browser.i18n.getUILanguage() || "en";
}

export function uiDirection(): "ltr" | "rtl" {
  return browser.i18n.getMessage("@@bidi_dir") === "rtl" ? "rtl" : "ltr";
}

export function translationProviderLabel(id: string): string {
  switch (id) {
    case "google":
      return t("providerGoogle");
    case "openai":
      return t("providerLlm");
    default:
      return id;
  }
}
