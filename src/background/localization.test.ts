import { afterEach, describe, expect, it, vi } from "vitest";
import { browser } from "wxt/browser";
import { applyUiLocale, uiLanguage } from "../shared/i18n";
import { startBackgroundLocalization } from "./localization";
import { startContextMenu } from "./context-menu";
import ja from "../public/_locales/ja/messages.json";

afterEach(() => {
  applyUiLocale("auto");
  vi.unstubAllGlobals();
});

describe("background localization", () => {
  it("registers listeners immediately and uses the locale loaded before creating menus", async () => {
    let resolveStorage!: (value: { uiLocale: string }) => void;
    const get = vi.fn(() => new Promise((resolve) => { resolveStorage = resolve; }));
    const api = stubBackground(get);
    const ready = startBackgroundLocalization();
    startContextMenu(browser, ready);

    expect(api.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
    expect(api.runtime.onInstalled.addListener).toHaveBeenCalledTimes(1);
    expect(api.contextMenus.onClicked.addListener).toHaveBeenCalledTimes(1);
    const installed = api.runtime.onInstalled.addListener.mock.calls[0][0];
    const installing = installed();
    expect(api.contextMenus.create).not.toHaveBeenCalled();
    expect(api.contextMenus.update).not.toHaveBeenCalled();

    resolveStorage({ uiLocale: "ja" });
    await installing;
    expect(api.contextMenus.create).toHaveBeenCalledWith(expect.objectContaining({
      id: "translate-image",
      title: ja.contextTranslateImage.message,
    }));
    expect(api.contextMenus.update).toHaveBeenCalledWith("translate-image", {
      title: ja.contextTranslateImage.message,
    });
  });

  it("applies newer changes after startup and only refreshes existing menu titles", async () => {
    let resolveStorage!: (value: { uiLocale: string }) => void;
    const api = stubBackground(() => new Promise((resolve) => { resolveStorage = resolve; }));
    const ready = startBackgroundLocalization();
    const changed = api.storage.onChanged.addListener.mock.calls[0][0];
    changed({ uiLocale: { newValue: "ja" } }, "local");
    resolveStorage({ uiLocale: "en" });
    await ready;
    expect(uiLanguage()).toBe("ja");
    expect(api.contextMenus.update).toHaveBeenCalledTimes(2);
    expect(api.contextMenus.create).not.toHaveBeenCalled();

    changed({ settings: { newValue: {} } }, "local");
    changed({ uiLocale: { newValue: "uk" } }, "sync");
    await Promise.resolve();
    expect(uiLanguage()).toBe("ja");
    expect(api.contextMenus.update).toHaveBeenCalledTimes(2);

    changed({ uiLocale: { oldValue: "ja" } }, "local");
    await Promise.resolve();
    expect(uiLanguage()).toBe("en");
    expect(api.contextMenus.update).toHaveBeenCalledWith("translate-image", {
      title: "Browser message",
    });
    expect(api.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
  });
});

function stubBackground(get: () => Promise<unknown>) {
  const api = {
    storage: {
      local: { get },
      onChanged: {
        addListener: vi.fn<(
          listener: (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, area: string) => void,
        ) => void>(),
      },
    },
    runtime: { onInstalled: { addListener: vi.fn<(listener: () => Promise<void>) => void>() } },
    contextMenus: {
      create: vi.fn(),
      update: vi.fn(async () => {}),
      onClicked: { addListener: vi.fn() },
    },
    i18n: { getMessage: () => "Browser message", getUILanguage: () => "en" },
  };
  vi.stubGlobal("browser", api);
  return api;
}
