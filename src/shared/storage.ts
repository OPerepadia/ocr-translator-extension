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

const START_OCR_IMMEDIATELY_KEY = "startOcrImmediately";

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

export async function getStartOcrImmediately(): Promise<boolean> {
  try {
    const values = await browserApi.storage.local.get(START_OCR_IMMEDIATELY_KEY);
    return values[START_OCR_IMMEDIATELY_KEY] === true;
  } catch {
    return false;
  }
}

export async function setStartOcrImmediately(enabled: boolean): Promise<void> {
  await browserApi.storage.local.set({
    [START_OCR_IMMEDIATELY_KEY]: enabled,
  });
}

// Which view the overlay boxes open in: the translated text painted over the
// image, or transparent frames leaving the image readable. Not an Options
// setting — the toolbar switch writes the last used view here so the next
// capture opens the same way.
export type OverlayMode = "translation" | "original";

const OVERLAY_MODE_KEY = "overlayMode";
const DEFAULT_OVERLAY_MODE: OverlayMode = "translation";

export async function getOverlayMode(): Promise<OverlayMode> {
  try {
    const values = await browserApi.storage.local.get(OVERLAY_MODE_KEY);
    return values[OVERLAY_MODE_KEY] === "original"
      ? "original"
      : DEFAULT_OVERLAY_MODE;
  } catch {
    return DEFAULT_OVERLAY_MODE;
  }
}

export async function setOverlayMode(mode: OverlayMode): Promise<void> {
  try {
    await browserApi.storage.local.set({ [OVERLAY_MODE_KEY]: mode });
  } catch {
    // Losing the preference is not worth surfacing mid-capture.
  }
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
