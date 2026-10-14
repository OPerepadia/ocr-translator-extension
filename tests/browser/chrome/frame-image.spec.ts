import { chromium, expect, test } from "@playwright/test";
import { resolve } from "node:path";

// Region selection runs in the top frame, so it asks the iframe under the
// pointer for its image. The page and its iframes come from different sites,
// so each iframe runs in a process of its own.

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
const FRAME_URL = "http://frame.test/";
const NESTED_URL = "http://nested.test/";

const PAGES = {
  [PAGE_URL]: `<!doctype html><body style="margin:0; background:#335">
    <iframe src="${FRAME_URL}" style="position:absolute; left:200px; top:100px;
      width:700px; height:500px; border:4px solid #888"></iframe>
  </body>`,
  [FRAME_URL]: `<!doctype html><body style="margin:0; background:#ddd">
    <iframe src="${NESTED_URL}" style="position:absolute; left:50px; top:60px;
      width:600px; height:400px; border:0"></iframe>
  </body>`,
  [NESTED_URL]: `<!doctype html><body style="margin:0; background:#fff">
    <img id="sample" style="position:absolute; left:40px; top:50px; width:400px; height:200px">
    <script>
      const canvas = document.createElement("canvas");
      canvas.width = 600;
      canvas.height = 300;
      const drawing = canvas.getContext("2d");
      drawing.fillStyle = "white";
      drawing.fillRect(0, 0, 600, 300);
      drawing.fillStyle = "black";
      drawing.font = "bold 80px sans-serif";
      drawing.fillText("SAMPLE", 60, 130);
      drawing.fillText("TEXT", 60, 250);
      document.getElementById("sample").src = canvas.toDataURL();
    </script>
  </body>`,
};

test("picks and recognizes an image inside a nested cross-origin iframe", async () => {
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
    // The same source and target language need no translation provider.
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
    for (const [url, body] of Object.entries(PAGES)) {
      await context.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body }),
      );
    }

    const page = await context.newPage();
    await page.goto(PAGE_URL);
    const nested = page.frameLocator("iframe").frameLocator("iframe");
    await expect(nested.locator("#sample")).toHaveJSProperty("complete", true);
    // Let the content scripts finish starting.
    await page.waitForTimeout(500);

    await worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.tabs.sendMessage(tab.id, { type: "START_SELECTION" }, { frameId: 0 });
    }, `${PAGE_URL}*`);
    await page.locator(".ocr-translate-selection-overlay").waitFor();

    // Both iframes offset the image: 200 + 4 + 50 + 40, 100 + 4 + 60 + 50.
    // Chrome sends input to the cross-origin iframe until it has drawn the
    // overlay over it, so keep moving until the overlay gets the pointer.
    const outline = page.locator(".ocr-translate-image-picker-frame");
    await expect(async () => {
      await page.mouse.move(493, 313);
      await page.mouse.move(494, 314);
      await expect(outline).toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 10_000 });
    expect(await outline.boundingBox()).toEqual({
      x: 294,
      y: 214,
      width: 400,
      height: 200,
    });

    await page.mouse.click(494, 314);
    await expect(page.locator(".ocr-translate-selection-overlay")).toHaveCount(0);
    await expect(nested.locator("textarea")).toHaveValue(/SAMPLE\s+TEXT/, {
      timeout: 30_000,
    });
  } finally {
    await context.close();
  }
});
