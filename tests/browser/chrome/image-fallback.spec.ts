import { chromium, expect, test } from "@playwright/test";
import { resolve } from "node:path";

// The page can load the image, but the extension's download gets a 403.
// The extension should read the image from a screenshot instead.

declare const chrome: {
  tabs: {
    query(query: { url: string }): Promise<Array<{ id: number }>>;
    sendMessage(
      tabId: number,
      message: unknown,
      options?: { frameId: number },
    ): Promise<unknown>;
  };
  storage: { local: { set(values: Record<string, unknown>): Promise<void> } };
};

const PAGE_URL = "http://page.test/";
const IMAGE_URL = "http://images.test/sample.png";

test("recognizes an image the extension cannot download", async () => {
  const extensionPath = resolve(".output/chrome-mv3");
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const context = await chromium.launchPersistentContext("", {
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    headless: true,
    viewport: { width: 1280, height: 720 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    const worker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    // Same source and target language, so nothing is translated.
    await worker.evaluate(() =>
      chrome.storage.local.set({
        uiLocale: "en",
        displayMode: "panel",
        settings: {
          ocr: { providerId: "paddle", sourceLang: "en" },
          translation: { providerId: "google", targetLang: "en" },
        },
      }),
    );

    const page = await context.newPage();
    const image = Buffer.from(
      (await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 600;
        canvas.height = 300;
        const drawing = canvas.getContext("2d")!;
        drawing.fillStyle = "white";
        drawing.fillRect(0, 0, 600, 300);
        drawing.fillStyle = "black";
        drawing.font = "bold 80px sans-serif";
        drawing.fillText("SAMPLE", 60, 130);
        drawing.fillText("TEXT", 60, 250);
        return canvas.toDataURL("image/png");
      })).split(",")[1]!,
      "base64",
    );

    await context.route(PAGE_URL, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><body style="margin:0; background:#fff">
          <img id="sample" src="${IMAGE_URL}"
            style="position:absolute; left:40px; top:50px; width:400px; height:200px">
        </body>`,
      }),
    );
    // Serve the image to the page only. Later requests get a 403.
    let served = false;
    await context.route(IMAGE_URL, (route) => {
      if (!served) {
        served = true;
        return route.fulfill({
          contentType: "image/png",
          headers: { "Cache-Control": "no-store" },
          body: image,
        });
      }
      return route.fulfill({ status: 403, body: "Forbidden" });
    });

    await page.goto(PAGE_URL);
    await expect(page.locator("#sample")).toHaveJSProperty("naturalWidth", 600);
    // Let the content script finish starting.
    await page.waitForTimeout(500);

    await worker.evaluate(
      async ({ url, imageUrl }) => {
        const [tab] = await chrome.tabs.query({ url });
        await chrome.tabs.sendMessage(
          tab.id,
          { type: "START_IMAGE_TRANSLATION", imageUrl },
          { frameId: 0 },
        );
      },
      { url: `${PAGE_URL}*`, imageUrl: IMAGE_URL },
    );

    await expect(page.locator("textarea")).toHaveValue(/SAMPLE\s+TEXT/, {
      timeout: 30_000,
    });
  } finally {
    await context.close();
  }
});
