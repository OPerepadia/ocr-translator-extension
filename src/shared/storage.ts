import { browser } from "wxt/browser";
import type { OverlayMode, Settings } from "./types";

const SETTINGS_KEY = "settings";

// How a finished result is shown on the page: the bottom-right panel, or boxes
// drawn over the selected region. Kept under its own storage key (like the
// panel size) rather than in Settings, since it's a UI presentation preference
// read directly by the content script and the options page.
export type DisplayMode = "panel" | "overlay";

const DISPLAY_MODE_KEY = "displayMode";
const DEFAULT_DISPLAY_MODE: DisplayMode = "overlay";

const START_OCR_IMMEDIATELY_KEY = "startOcrImmediately";

export async function getDisplayMode(): Promise<DisplayMode> {
  try {
    const values = await browser.storage.local.get(DISPLAY_MODE_KEY);
    return values[DISPLAY_MODE_KEY] === "panel" ? "panel" : DEFAULT_DISPLAY_MODE;
  } catch {
    return DEFAULT_DISPLAY_MODE;
  }
}

export async function setDisplayMode(mode: DisplayMode): Promise<void> {
  await browser.storage.local.set({ [DISPLAY_MODE_KEY]: mode });
}

export async function getStartOcrImmediately(): Promise<boolean> {
  try {
    const values = await browser.storage.local.get(START_OCR_IMMEDIATELY_KEY);
    return values[START_OCR_IMMEDIATELY_KEY] === true;
  } catch {
    return false;
  }
}

export async function setStartOcrImmediately(enabled: boolean): Promise<void> {
  await browser.storage.local.set({
    [START_OCR_IMMEDIATELY_KEY]: enabled,
  });
}

const DEFAULT_OVERLAY_MODE_KEY = "defaultOverlayMode";

export async function getDefaultOverlayMode(): Promise<OverlayMode> {
  try {
    const values = await browser.storage.local.get(DEFAULT_OVERLAY_MODE_KEY);
    return values[DEFAULT_OVERLAY_MODE_KEY] === "original"
      ? "original"
      : "translation";
  } catch {
    return "translation";
  }
}

export async function setDefaultOverlayMode(mode: OverlayMode): Promise<void> {
  await browser.storage.local.set({ [DEFAULT_OVERLAY_MODE_KEY]: mode });
}

export const defaultSettings: Settings = {
  ocr: {
    providerId: "paddle",
    sourceLang: "auto",
  },
  translation: {
    providerId: "google",
    targetLang: "en",
    llm: {
      baseUrl: "http://localhost:8080/v1",
    },
  },
};

export interface SettingsRepository {
  get(): Promise<Settings>;
  set(settings: Settings): Promise<void>;
}

export function createSettingsRepository(): SettingsRepository {
  return {
    async get() {
      const values = await browser.storage.local.get(SETTINGS_KEY);
      return (values[SETTINGS_KEY] as Settings | undefined) ?? defaultSettings;
    },

    async set(settings) {
      await browser.storage.local.set({
        [SETTINGS_KEY]: settings,
      });
    },
  };
}
