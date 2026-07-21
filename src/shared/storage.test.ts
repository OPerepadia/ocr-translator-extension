import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSettingsRepository,
  defaultSettings,
  getDisplayMode,
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

  it("uses default settings when none are saved", async () => {
    stubStorage({});
    await expect(createSettingsRepository().get()).resolves.toEqual(
      defaultSettings,
    );
  });
});
