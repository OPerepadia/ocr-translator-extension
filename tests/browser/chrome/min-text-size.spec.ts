import { chromium, expect, test } from "@playwright/test";
import { resolve } from "node:path";
import type { Settings } from "../../../src/shared/types";

declare const chrome: typeof import("wxt/browser").browser;

test("saves the live translation text size and falls back to the default", async () => {
  const extensionPath = resolve(".output/chrome-mv3");
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const context = await chromium.launchPersistentContext("", {
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const extensionUrl = `chrome-extension://${new URL(worker.url()).host}`;
    await worker.evaluate(() => chrome.storage.local.set({ uiLocale: "en" }));

    const options = await context.newPage();
    await options.goto(`${extensionUrl}/options.html#ocr`);
    const size = options.locator('input[name="minTextSize"]');
    const saved = () => worker.evaluate(async () =>
      ((await chrome.storage.local.get("settings")).settings as Settings | undefined)?.ocr.minTextSize,
    );

    // Nothing saved yet: the field shows the default as a placeholder.
    await expect(size).toHaveValue("");
    await expect(size).toHaveAttribute("placeholder", "16");
    await expect(options.locator(".min-text-size-unit")).toHaveText("px");

    await size.fill("27");
    await size.blur();
    await expect.poll(saved).toBe(27);

    // Zero is a real value: it turns the filter off.
    await size.fill("0");
    await size.blur();
    await expect.poll(saved).toBe(0);

    await size.fill("5000");
    await size.blur();
    await expect.poll(saved).toBe(200);

    await size.fill("27");
    await size.blur();
    await expect.poll(saved).toBe(27);
    await options.reload();
    await expect(options.locator('input[name="minTextSize"]')).toHaveValue("27");

    // Clearing the field goes back to the default instead of saving a number.
    await options.locator('input[name="minTextSize"]').fill("");
    await options.locator('input[name="minTextSize"]').blur();
    await expect.poll(saved).toBeUndefined();
  } finally {
    await context.close();
  }
});
