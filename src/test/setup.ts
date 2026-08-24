import messages from "../public/_locales/en/messages.json";
import { vi } from "vitest";

type MessageCatalog = Record<string, { message: string }>;

const catalog = messages as MessageCatalog;

Object.defineProperty(globalThis, "browser", {
  configurable: true,
  writable: true,
  value: {
    i18n: {
      getMessage(key: string, substitutions?: string | string[]): string {
        const message = catalog[key]?.message ?? "";
        const values = Array.isArray(substitutions)
          ? substitutions
          : substitutions === undefined
            ? []
            : [substitutions];
        return message.replace(/\$(\d+)/g, (_match, index: string) => {
          return values[Number(index) - 1] ?? "";
        });
      },
      getUILanguage: () => "en",
    },
  },
});

vi.mock("wxt/browser", () => ({
  browser: new Proxy(
    {},
    {
      get(_target, property) {
        return (globalThis as { browser?: Record<PropertyKey, unknown> }).browser?.[
          property
        ];
      },
    },
  ),
}));
