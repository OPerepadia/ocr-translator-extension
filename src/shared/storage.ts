import { browserApi } from "./browser";
import type { Settings } from "./types";

const SETTINGS_KEY = "settings";

// How a finished result is shown on the page: the bottom-right panel, or boxes
// drawn over the selected region. Kept under its own storage key (like the
// panel size) rather than in Settings, since it's a UI presentation preference
// read directly by the content script and the options page.
export type DisplayMode = "panel" | "overlay";

const DISPLAY_MODE_KEY = "displayMode";
const DEFAULT_DISPLAY_MODE: DisplayMode = "overlay";

export async function getDisplayMode(): Promise<DisplayMode> {
  try {
    const values = await browserApi.storage.local.get(DISPLAY_MODE_KEY);
    return values[DISPLAY_MODE_KEY] === "panel" ? "panel" : DEFAULT_DISPLAY_MODE;
  } catch {
    return DEFAULT_DISPLAY_MODE;
  }
}

export async function setDisplayMode(mode: DisplayMode): Promise<void> {
  await browserApi.storage.local.set({ [DISPLAY_MODE_KEY]: mode });
}

// Whether the overlay boxes open showing the recognized original instead of
// the translation. Stored like the display mode, under its own key.
const OVERLAY_SHOW_ORIGINAL_KEY = "overlayShowOriginal";

export async function getOverlayShowOriginal(): Promise<boolean> {
  try {
    const values = await browserApi.storage.local.get(OVERLAY_SHOW_ORIGINAL_KEY);
    return values[OVERLAY_SHOW_ORIGINAL_KEY] === true;
  } catch {
    return false;
  }
}

export async function setOverlayShowOriginal(value: boolean): Promise<void> {
  await browserApi.storage.local.set({ [OVERLAY_SHOW_ORIGINAL_KEY]: value });
}

export const defaultSettings: Settings = {
  ocr: {
    providerId: "paddle",
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
      const values = await browserApi.storage.local.get(SETTINGS_KEY);
      return (values[SETTINGS_KEY] as Settings | undefined) ?? defaultSettings;
    },

    async set(settings) {
      await browserApi.storage.local.set({
        [SETTINGS_KEY]: settings,
      });
    },
  };
}
