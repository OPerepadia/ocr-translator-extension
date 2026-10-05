import { browser } from "wxt/browser";
import type { OverlayMode, Settings } from "./types";

const SETTINGS_KEY = "settings";

export const UI_LOCALES = ["en", "ja", "zh_CN", "ru", "uk"] as const;
export type UiLocale = "auto" | (typeof UI_LOCALES)[number];

export function normalizeUiLocale(value: unknown): UiLocale {
  return UI_LOCALES.find((locale) => locale === value) ?? "auto";
}

export async function getUiLocale(): Promise<UiLocale> {
  try {
    const values = await browser.storage.local.get("uiLocale");
    return normalizeUiLocale(values.uiLocale);
  } catch {
    return "auto";
  }
}

export async function setUiLocale(locale: UiLocale): Promise<void> {
  await browser.storage.local.set({ uiLocale: locale });
}

// How a finished result is shown on the page: the bottom-right panel, or boxes
// drawn over the selected region. Kept under its own storage key (like the
// panel size) rather than in Settings, since it's a UI presentation preference
// read directly by the content script and the options page.
export type DisplayMode = "panel" | "overlay";

const DISPLAY_MODE_KEY = "displayMode";
const DEFAULT_DISPLAY_MODE: DisplayMode = "overlay";

const ADJUST_SELECTION_KEY = "adjustSelection";
// Older versions saved the inverse setting under this key.
// TODO: Remove this key, its fallback in getAdjustSelection, and the migration
// tests a release or two after 0.19.0.
const LEGACY_START_OCR_IMMEDIATELY_KEY = "startOcrImmediately";

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

export async function getAdjustSelection(): Promise<boolean> {
  try {
    const values = await browser.storage.local.get([
      ADJUST_SELECTION_KEY,
      LEGACY_START_OCR_IMMEDIATELY_KEY,
    ]);
    const adjustSelection = values[ADJUST_SELECTION_KEY];
    if (typeof adjustSelection === "boolean") {
      return adjustSelection;
    }
    return values[LEGACY_START_OCR_IMMEDIATELY_KEY] === false;
  } catch {
    return false;
  }
}

export async function setAdjustSelection(enabled: boolean): Promise<void> {
  await browser.storage.local.set({ [ADJUST_SELECTION_KEY]: enabled });
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

// Text smaller than this, in CSS pixels, is left out of live translation: it is
// usually the page's interface and not what the user came to read.
export const DEFAULT_MIN_TEXT_SIZE = 16;
export const MAX_MIN_TEXT_SIZE = 200;

/** The saved size, or the default when it is absent or not a usable number.
 * Zero is valid and means no text is skipped. */
export function resolveMinTextSize(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), MAX_MIN_TEXT_SIZE)
    : DEFAULT_MIN_TEXT_SIZE;
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
