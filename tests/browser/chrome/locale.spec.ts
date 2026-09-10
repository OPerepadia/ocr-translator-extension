import { chromium, expect, test } from "@playwright/test";
import { resolve } from "node:path";
import en from "../../../src/public/_locales/en/messages.json" with { type: "json" };
import uk from "../../../src/public/_locales/uk/messages.json" with { type: "json" };

declare const chrome: typeof import("wxt/browser").browser;

test("changes UI locale across settings, popup and refreshed content without losing preferences", async () => {
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
  const pageErrors: string[] = [];
  context.on("page", (page) => page.on("pageerror", (error) => pageErrors.push(error.message)));

  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const extensionUrl = `chrome-extension://${new URL(worker.url()).host}`;
    const settings = {
      ocr: { providerId: "paddle", sourceLang: "auto" },
      translation: { providerId: "google", targetLang: "ja" },
    };
    await worker.evaluate(async (settings) => {
      await chrome.storage.local.set({ settings, uiLocale: "uk" });
    }, settings);

    const options = await context.newPage();
    await options.goto(`${extensionUrl}/options.html#display-options`);
    await expect(options.locator("h1")).toHaveText(uk.optionsPageTitle.message);
    const localeSelect = options.locator(
      '.options-sidebar select[name="uiLocale"]',
    );
    await expect(
      options.locator('.sidebar-locale-field > [data-i18n="optionsUiLanguage"]'),
    ).toHaveText(uk.optionsUiLanguage.message);
    await expect(localeSelect).toBeVisible();
    await expect(
      options.locator('form select[name="uiLocale"]'),
    ).toHaveCount(0);
    await expect(localeSelect).toHaveValue("uk");
    await expect(localeSelect.locator("option")).toHaveCount(6);

    await options.setViewportSize({ width: 700, height: 800 });
    const cardBox = await options.locator(".options-card").boundingBox();
    const localeBox = await options
      .locator(".sidebar-locale-field")
      .boundingBox();
    expect(cardBox).not.toBeNull();
    expect(localeBox).not.toBeNull();
    expect(localeBox!.y).toBeGreaterThanOrEqual(cardBox!.y + cardBox!.height);

    const content = await context.newPage();
    await content.route("https://locale.example/**", (route) => route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html lang='en'><title>Sample</title><p>Sample text</p></html>",
    }));
    await content.goto("https://locale.example/");
    const startSelection = () => worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: "https://locale.example/*" });
      await chrome.tabs.sendMessage(tab.id!, { type: "START_SELECTION" });
    });
    await startSelection();
    const hint = content.locator(".ocr-translate-selection-hint");
    await expect(hint).toContainText(uk.selectionDragArea.message);

    await options.evaluate(() => {
      const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
      chrome.storage.local.set = async (values) => {
        if ("displayMode" in values) {
          await new Promise<void>((resolve) => {
            (window as unknown as { releaseSave: () => void }).releaseSave = resolve;
          });
        }
        return originalSet(values);
      };
    });
    await options.locator('select[name="displayMode"]').selectOption("panel");
    await options.waitForFunction(() => "releaseSave" in window);
    await localeSelect.selectOption("en");
    await expect(options.locator("form")).toHaveJSProperty("inert", true);
    expect(await worker.evaluate(async () => (await chrome.storage.local.get("uiLocale")).uiLocale)).toBe("uk");
    await Promise.all([
      options.waitForEvent("load"),
      options.evaluate(() => (window as unknown as { releaseSave: () => void }).releaseSave()),
    ]);
    await expect(options.locator("h1")).toHaveText(en.optionsPageTitle.message);
    await expect(
      options.locator('.sidebar-locale-field > [data-i18n="optionsUiLanguage"]'),
    ).toHaveText(en.optionsUiLanguage.message);
    await expect(options.locator('select[name="displayMode"]')).toHaveValue("panel");
    await expect(options.locator("html")).toHaveAttribute("lang", "en");
    expect(await worker.evaluate(async () => (await chrome.storage.local.get("settings")).settings)).toEqual(settings);

    await expect(hint).toContainText(uk.selectionDragArea.message);
    await content.reload();
    await startSelection();
    await expect(hint).toContainText(en.selectionDragArea.message);
    expect(await content.evaluate(() => document.documentElement.lang)).toBe("en");

    const popup = await context.newPage();
    await popup.goto(`${extensionUrl}/popup.html`);
    await expect(popup.locator("#open-settings")).toHaveAttribute("aria-label", en.commonSettings.message);
    await popup.close();

    await options.evaluate(() => {
      const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
      chrome.storage.local.set = async (values) => {
        if ("uiLocale" in values) throw new Error("Sample save failure");
        return originalSet(values);
      };
    });
    await localeSelect.selectOption("ja");
    await expect(localeSelect).toHaveValue("en");
    await expect(options.getByRole("status")).toContainText("Sample save failure");
    await expect(options.locator("form")).toHaveJSProperty("inert", false);
    expect(await worker.evaluate(async () => (await chrome.storage.local.get("uiLocale")).uiLocale)).toBe("en");
    await options.reload();

    for (const locale of ["ja", "zh_CN", "ru", "uk", "auto"]) {
      await expect(localeSelect).toBeVisible();
      await Promise.all([
        options.waitForEvent("load"),
        localeSelect.selectOption(locale),
      ]);
      await expect(localeSelect).toHaveValue(locale);
      const language = locale === "auto"
        ? await worker.evaluate(() => chrome.i18n.getUILanguage())
        : locale.replace("_", "-");
      await expect(options.locator("html")).toHaveAttribute("lang", language);
    }
    const browserTitle = await worker.evaluate(() => chrome.i18n.getMessage("optionsPageTitle"));
    await expect(options.locator("h1")).toHaveText(browserTitle);
    await options.screenshot({ path: test.info().outputPath("locale-settings.png"), fullPage: true });
    expect(pageErrors).toEqual([]);
  } finally {
    await context.close();
  }
});
