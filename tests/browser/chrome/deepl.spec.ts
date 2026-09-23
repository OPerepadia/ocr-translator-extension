import { chromium, expect, test } from "@playwright/test";
import { resolve } from "node:path";
import type { Settings } from "../../../src/shared/types";

declare const chrome: typeof import("wxt/browser").browser;

test("saves DeepL plan and key and refreshes the cached provider when settings change", async () => {
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
    await worker.evaluate(async () => {
      await chrome.storage.local.set({ uiLocale: "en" });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        if (String(url).includes("deepl.com/v2/translate")) {
          const request = JSON.parse(String(init?.body));
          const key = new Headers(init?.headers).get("Authorization");
          return Response.json({ translations: request.text.map(() => ({
            text: `${new URL(String(url)).host}|${key}`,
            detected_source_language: "EN",
          })) });
        }
        return originalFetch(url, init);
      };
    });
    const options = await context.newPage();
    await options.goto(`${extensionUrl}/options.html#translation`);
    const provider = options.locator('select[name="translationProvider"]');
    const plan = options.locator('select[name="deeplPlan"]');
    const key = options.locator('input[name="deeplApiKey"]');
    await provider.selectOption("deepl");
    await expect(options.locator(".deepl-settings")).toBeVisible();
    await expect(options.locator(".llm-settings")).toBeHidden();
    await expect(plan).toHaveValue("free");
    await expect(key).toHaveAttribute("type", "password");
    await key.fill("fictional-key");
    await key.blur();
    const stored = () => worker.evaluate(async () =>
      ((await chrome.storage.local.get("settings")).settings as Settings).translation.deepl,
    );
    await expect.poll(stored).toEqual({ apiKey: "fictional-key", plan: "free" });
    const translate = () => options.evaluate(async () => chrome.runtime.sendMessage({
      type: "RETRANSLATE_REQUEST", requestId: crypto.randomUUID(),
      text: "Sample text for translation", targetLang: "uk",
    }));
    expect((await translate()).value.translation.text).toBe("api-free.deepl.com|DeepL-Auth-Key fictional-key");
    await plan.selectOption("pro");
    await key.fill("replacement-key:fx");
    await key.blur();
    await expect.poll(stored).toEqual({ apiKey: "replacement-key:fx", plan: "pro" });
    expect((await translate()).value.translation.text).toBe("api.deepl.com|DeepL-Auth-Key replacement-key:fx");
    await provider.selectOption("google");
    await expect(options.locator(".deepl-settings")).toBeHidden();
    await provider.selectOption("deepl");
    await expect(plan).toHaveValue("pro");
    await options.reload();
    await expect(plan).toHaveValue("pro");
    await expect(key).toHaveValue("replacement-key:fx");
    await expect(options.locator('select[name="targetLang"] option[value="en-GB"]')).toHaveCount(1);
    await expect(options.locator('select[name="targetLang"] option[value="am"]')).toHaveCount(0);
    const popup = await context.newPage();
    await popup.goto(`${extensionUrl}/popup.html`);
    await expect(popup.locator('#translation-provider')).toHaveValue("deepl");
    await expect(popup.locator('#translation-provider option[value="deepl"]')).toHaveText("DeepL");
  } finally {
    await context.close();
  }
});
