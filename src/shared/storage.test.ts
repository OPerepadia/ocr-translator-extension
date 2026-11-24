import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSettingsRepository,
  defaultSettings,
  getDefaultOverlayMode,
  getDisplayMode,
  getAdjustSelection,
  getImageHoverButton,
  getUiLocale,
  setUiLocale,
  UI_LOCALES,
  setDisplayMode,
  setDefaultOverlayMode,
  setImageHoverButton,
  watchImageHoverButton,
} from "./storage";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubStorage(values: Record<string, unknown>): void {
  vi.stubGlobal("browser", {
    storage: {
      local: {
        get: vi.fn(async () => values),
      },
    },
  });
}

describe("storage defaults", () => {
  it.each([undefined, null, "auto", "unsupported", {}, 42])(
    "uses the browser locale for %j",
    async (uiLocale) => {
      stubStorage({ uiLocale });
      await expect(getUiLocale()).resolves.toBe("auto");
    },
  );

  it.each(UI_LOCALES)("reads the %s UI locale", async (uiLocale) => {
    stubStorage({ uiLocale });
    await expect(getUiLocale()).resolves.toBe(uiLocale);
  });

  it("writes only the UI locale key", async () => {
    const set = vi.fn(async () => {});
    vi.stubGlobal("browser", { storage: { local: { set } } });
    await setUiLocale("ja");
    expect(set).toHaveBeenCalledWith({ uiLocale: "ja" });
  });

  it("uses the browser locale when storage cannot be read", async () => {
    vi.stubGlobal("browser", {
      storage: { local: { get: vi.fn().mockRejectedValue(new Error("Unavailable")) } },
    });
    await expect(getUiLocale()).resolves.toBe("auto");
  });

  it("uses overlay when no display mode is saved", async () => {
    stubStorage({});
    await expect(getDisplayMode()).resolves.toBe("overlay");
  });

  it.each(["panel", "overlay"] as const)(
    "saves %s as the display mode",
    async (mode) => {
      const set = vi.fn(async () => {});
      vi.stubGlobal("browser", { storage: { local: { set } } });

      await setDisplayMode(mode);

      expect(set).toHaveBeenCalledWith({ displayMode: mode });
    },
  );

  it("shows translations in new overlays by default", async () => {
    stubStorage({});
    await expect(getDefaultOverlayMode()).resolves.toBe("translation");
  });

  it.each(["translation", "original"] as const)(
    "saves %s as the default overlay content",
    async (mode) => {
      const set = vi.fn(async () => {});
      vi.stubGlobal("browser", { storage: { local: { set } } });

      await setDefaultOverlayMode(mode);

      expect(set).toHaveBeenCalledWith({ defaultOverlayMode: mode });
    },
  );

  it("skips the adjustment step by default", async () => {
    stubStorage({});
    await expect(getAdjustSelection()).resolves.toBe(false);
  });

  it("reads the adjustment setting", async () => {
    stubStorage({ adjustSelection: true });
    await expect(getAdjustSelection()).resolves.toBe(true);
  });

  it.each([
    [false, true],
    [true, false],
  ])(
    "migrates startOcrImmediately=%j to adjustSelection=%j",
    async (startOcrImmediately, adjustSelection) => {
      stubStorage({ startOcrImmediately });
      await expect(getAdjustSelection()).resolves.toBe(adjustSelection);
    },
  );

  it("prefers the adjustment setting over the legacy one", async () => {
    stubStorage({ adjustSelection: false, startOcrImmediately: false });
    await expect(getAdjustSelection()).resolves.toBe(false);
  });

  it("uses default settings when none are saved", async () => {
    stubStorage({});
    await expect(createSettingsRepository().get()).resolves.toEqual(
      defaultSettings,
    );
  });

  it("leaves model thinking on for new users", () => {
    expect(defaultSettings.translation.llm?.disableThinking).toBe(false);
  });

  it("keeps saved LLM settings without adding the new default", async () => {
    const saved = {
      ...defaultSettings,
      translation: {
        providerId: "openai",
        targetLang: "en",
        llm: { baseUrl: "http://localhost:8080/v1" },
      },
    };
    stubStorage({ settings: saved });
    await expect(createSettingsRepository().get()).resolves.toEqual(saved);
  });
});

describe("image hover button setting", () => {
  it("is off when nothing is saved", async () => {
    stubStorage({});
    await expect(getImageHoverButton()).resolves.toBe(false);
  });

  it("is off when storage cannot be read", async () => {
    vi.stubGlobal("browser", {
      storage: { local: { get: vi.fn().mockRejectedValue(new Error("Unavailable")) } },
    });
    await expect(getImageHoverButton()).resolves.toBe(false);
  });

  it.each([
    [true, true],
    [false, false],
    ["true", false],
    [1, false],
  ])("reads %j as %j", async (saved, enabled) => {
    stubStorage({ imageHoverButton: saved });
    await expect(getImageHoverButton()).resolves.toBe(enabled);
  });

  it("writes only its own key", async () => {
    const set = vi.fn(async () => {});
    vi.stubGlobal("browser", { storage: { local: { set } } });
    await setImageHoverButton(true);
    expect(set).toHaveBeenCalledWith({ imageHoverButton: true });
  });

  describe("watching", () => {
    function stubChangeEvents() {
      const addListener = vi.fn();
      const removeListener = vi.fn();
      vi.stubGlobal("browser", {
        storage: { onChanged: { addListener, removeListener } },
      });
      return { addListener, removeListener };
    }

    it("reports changes to the local area", () => {
      const { addListener } = stubChangeEvents();
      const listener = vi.fn();
      watchImageHoverButton(listener);
      const onChanged = addListener.mock.calls[0][0];

      onChanged({ imageHoverButton: { newValue: true } }, "local");
      onChanged({ imageHoverButton: { oldValue: true } }, "local");
      onChanged({ imageHoverButton: { newValue: "yes" } }, "local");

      expect(listener.mock.calls).toEqual([[true], [false], [false]]);
    });

    it("ignores other keys and storage areas", () => {
      const { addListener } = stubChangeEvents();
      const listener = vi.fn();
      watchImageHoverButton(listener);
      const onChanged = addListener.mock.calls[0][0];

      onChanged({ displayMode: { newValue: "panel" } }, "local");
      onChanged({ imageHoverButton: { newValue: true } }, "sync");

      expect(listener).not.toHaveBeenCalled();
    });

    it("stops listening when asked", () => {
      const { addListener, removeListener } = stubChangeEvents();
      const stop = watchImageHoverButton(vi.fn());
      stop();
      expect(removeListener).toHaveBeenCalledWith(addListener.mock.calls[0][0]);
    });
  });
});
