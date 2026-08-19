import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSettingsRepository,
  defaultSettings,
  getDisplayMode,
  getStartOcrImmediately,
  setDisplayMode,
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

  it("waits for confirmation when immediate OCR is not enabled", async () => {
    stubStorage({});
    await expect(getStartOcrImmediately()).resolves.toBe(false);
  });

  it("starts OCR immediately when enabled", async () => {
    stubStorage({ startOcrImmediately: true });
    await expect(getStartOcrImmediately()).resolves.toBe(true);
  });

  it("uses default settings when none are saved", async () => {
    stubStorage({});
    await expect(createSettingsRepository().get()).resolves.toEqual(
      defaultSettings,
    );
  });
});
