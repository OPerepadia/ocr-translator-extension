import { browser } from "wxt/browser";
import en from "../public/_locales/en/messages.json";
import ja from "../public/_locales/ja/messages.json";
import zh_CN from "../public/_locales/zh_CN/messages.json";
import ru from "../public/_locales/ru/messages.json";
import uk from "../public/_locales/uk/messages.json";
import { getUiLocale, normalizeUiLocale, type UiLocale } from "./storage";

type MessageCatalog = Record<string, { message: string }>;
const catalogs: Record<Exclude<UiLocale, "auto">, MessageCatalog> = {
  en,
  ja,
  zh_CN,
  ru,
  uk,
};
let locale: UiLocale = "auto";

export function applyUiLocale(value: unknown): UiLocale {
  locale = normalizeUiLocale(value);
  return locale;
}

export async function initializeI18n(): Promise<UiLocale> {
  return applyUiLocale(await getUiLocale());
}

export function t(key: string, substitutions?: string | string[]): string {
  if (locale !== "auto") {
    const catalog = catalogs[locale];
    const message =
      (Object.hasOwn(catalog, key) ? catalog[key].message : undefined) ||
      (Object.hasOwn(en, key) ? (en as MessageCatalog)[key].message : undefined);
    if (!message) return key;
    const values = Array.isArray(substitutions)
      ? substitutions
      : substitutions === undefined
        ? []
        : [substitutions];
    return message.replace(
      /\$(\d+)/g,
      (_match, index: string) => values[Number(index) - 1] ?? "",
    );
  }
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
  if (locale !== "auto") return locale.replaceAll("_", "-");
  return browser.i18n.getUILanguage() || "en";
}

export function uiDirection(): "ltr" | "rtl" {
  if (locale !== "auto") return "ltr";
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
