import { chromium, expect, test } from "@playwright/test";
import { resolve } from "node:path";
import type { Settings } from "../../../src/shared/types";

declare const chrome: typeof import("wxt/browser").browser;

test("switching to the manga model limits the OCR languages", async () => {
  const extensionPath = resolve(".output/chrome-mv3");
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const context = await chromium.launchPersistentContext("", {
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    const worker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        settings: {
          ocr: { providerId: "paddle", sourceLang: "ru" },
          translation: { providerId: "google", targetLang: "en" },
        },
      });
    });
    const options = await context.newPage();
    await options.goto(
      `chrome-extension://${new URL(worker.url()).host}/options.html`,
    );
    const standard = options.locator('input[name="ocrProvider"][value="paddle"]');
    const manga = options.locator(
      'input[name="ocrProvider"][value="paddle-manga"]',
    );
    const language = options.locator('select[name="sourceLang"]');
    await expect(standard).toBeChecked();
    await expect(language).toHaveValue("ru");

    await options.locator(".ocr-model-tile", { hasText: "Manga" }).click();
    await expect(manga).toBeChecked();

    await expect(language).toHaveValue("auto");
    const offered = await language
      .locator("option")
      .evaluateAll((items: HTMLOptionElement[]) => items.map((item) => item.value));
    expect(offered).toContain("ja");
    expect(offered).not.toContain("ru");
    await expect
      .poll(() =>
        worker.evaluate(async () =>
          ((await chrome.storage.local.get("settings")).settings as Settings).ocr,
        ),
      )
      .toMatchObject({ providerId: "paddle-manga", sourceLang: "auto" });
  } finally {
    await context.close();
  }
});

test("the popup switches the OCR model and drops unreadable languages", async () => {
  const extensionPath = resolve(".output/chrome-mv3");
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const context = await chromium.launchPersistentContext("", {
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    const worker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        settings: {
          ocr: { providerId: "paddle", sourceLang: "ru" },
          translation: { providerId: "google", targetLang: "en" },
        },
      });
    });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    const model = popup.locator("#ocr-provider");
    const language = popup.locator("#source-language");
    await expect(model).toHaveValue("paddle");
    await expect(language).toHaveValue("ru");

    await popup.getByRole("button", { name: /PP-OCRv6 \/ v5/ }).click();
    await popup.getByRole("option", { name: "PP-OCRv6 Manga" }).click();

    await expect(model).toHaveValue("paddle-manga");
    await expect(language).toHaveValue("auto");
    const offered = await language
      .locator("option")
      .evaluateAll((items: HTMLOptionElement[]) => items.map((item) => item.value));
    expect(offered).not.toContain("ru");
    await expect
      .poll(() =>
        worker.evaluate(async () =>
          ((await chrome.storage.local.get("settings")).settings as Settings).ocr,
        ),
      )
      .toMatchObject({ providerId: "paddle-manga", sourceLang: "auto" });
  } finally {
    await context.close();
  }
});

test("the popup's display mode control saves the chosen mode", async () => {
  const extensionPath = resolve(".output/chrome-mv3");
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const context = await chromium.launchPersistentContext("", {
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    const worker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await worker.evaluate(async () => {
      await chrome.storage.local.set({ displayMode: "overlay" });
    });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    const panel = popup.getByRole("radio", { name: "Panel" });
    await expect(popup.getByRole("radio", { name: "Overlay" })).toBeChecked();

    await panel.click();

    await expect(panel).toBeChecked();
    await expect
      .poll(() =>
        worker.evaluate(
          async () => (await chrome.storage.local.get("displayMode")).displayMode,
        ),
      )
      .toBe("panel");
  } finally {
    await context.close();
  }
});
