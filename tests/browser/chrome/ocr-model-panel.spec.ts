import { chromium, expect, test } from "@playwright/test";
import { resolve } from "node:path";
import type { Settings } from "../../../src/shared/types";

declare const chrome: typeof import("wxt/browser").browser;

test("offers the standard model when the manga model can't read the script", async () => {
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
    // An unreachable local endpoint keeps the text on this machine.
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        settings: {
          ocr: { providerId: "paddle-manga", sourceLang: "auto" },
          translation: {
            providerId: "openai",
            targetLang: "en",
            llm: { baseUrl: "http://127.0.0.1:9/v1" },
          },
        },
        displayMode: "panel",
      });
    });
    await context.route("https://example.test/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><title>Test</title><p>Test page</p>",
      }),
    );
    const page = await context.newPage();
    await page.goto("https://example.test/");
    const imageUrl = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 500;
      canvas.height = 128;
      const drawing = canvas.getContext("2d")!;
      drawing.fillStyle = "white";
      drawing.fillRect(0, 0, canvas.width, canvas.height);
      drawing.fillStyle = "black";
      drawing.font = "bold 56px sans-serif";
      drawing.fillText("Пример текста", 16, 80);
      return canvas.toDataURL("image/png");
    });
    await expect
      .poll(() =>
        worker.evaluate(async (imageUrl) => {
          const [tab] = await chrome.tabs.query({ url: "https://example.test/*" });
          try {
            await chrome.tabs.sendMessage(tab.id!, {
              type: "START_IMAGE_TRANSLATION",
              imageUrl,
            });
            return true;
          } catch {
            return false;
          }
        }, imageUrl),
      )
      .toBe(true);

    await expect(
      page.getByText(
        "The selected recognition model doesn't support this script: Cyrillic.",
      ),
    ).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Recognize with PP-OCRv6 / v5" }).click();

    await expect(page.getByRole("textbox", { name: "Source text" })).toHaveValue(
      "Пример текста",
      { timeout: 60_000 },
    );
    await expect(
      page.getByRole("button", { name: "Recognition model: PP-OCRv6 / v5" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        worker.evaluate(async () =>
          ((await chrome.storage.local.get("settings")).settings as Settings).ocr,
        ),
      )
      .toMatchObject({ providerId: "paddle" });
  } finally {
    await context.close();
  }
});
