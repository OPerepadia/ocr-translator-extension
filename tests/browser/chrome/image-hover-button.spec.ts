import { chromium, expect, test } from "@playwright/test";
import { resolve } from "node:path";

// The optional image button is off by default, follows the setting without a
// reload, and translates the image on click.

declare const chrome: {
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(values: Record<string, unknown>): Promise<void>;
    };
  };
};

const PAGE_URL = "http://page.test/";
const IMAGE_URL = "http://images.test/sample.png";

test("translates a large image from its hover button", async () => {
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
          <img id="icon" src="${IMAGE_URL}"
            style="position:absolute; left:600px; top:50px; width:100px; height:100px">
        </body>`,
      }),
    );
    await context.route(IMAGE_URL, (route) =>
      route.fulfill({ contentType: "image/png", body: image }),
    );

    await page.goto(PAGE_URL);
    await expect(page.locator("#sample")).toHaveJSProperty("naturalWidth", 600);
    // Let the content script finish starting.
    await page.waitForTimeout(500);

    const button = page.locator(".ocr-translate-image-button");

    await page.mouse.move(200, 150);
    await page.waitForTimeout(300);
    await expect(button).toHaveCount(0);

    // Turning it on works on the open page.
    await worker.evaluate(() => chrome.storage.local.set({ imageHoverButton: true }));
    await page.mouse.move(210, 160);
    await expect(button).toBeVisible();
    expect(await button.boundingBox()).toEqual({ x: 400, y: 58, width: 32, height: 32 });

    // Small images get no button.
    await page.mouse.move(650, 100);
    await expect(button).toBeHidden();

    await page.mouse.move(210, 160);
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.locator("textarea")).toHaveValue(/SAMPLE\s+TEXT/, {
      timeout: 30_000,
    });

    await worker.evaluate(() => chrome.storage.local.set({ imageHoverButton: false }));
    await expect(button).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("the popup toggle shows and changes the image button setting", async () => {
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
    await worker.evaluate(() => chrome.storage.local.set({ uiLocale: "en" }));
    const popupUrl = `chrome-extension://${new URL(worker.url()).host}/popup.html`;
    const stored = () =>
      worker.evaluate(
        async () =>
          (await chrome.storage.local.get("imageHoverButton")).imageHoverButton,
      );

    const popup = await context.newPage();
    await popup.goto(popupUrl);
    const toggle = popup.getByLabel("Show a translate button on images");
    await expect(toggle).not.toBeChecked();

    await toggle.check();
    await expect.poll(stored).toBe(true);

    // A value set elsewhere, such as in Options, shows when the popup opens.
    await worker.evaluate(() => chrome.storage.local.set({ imageHoverButton: false }));
    await popup.reload();
    await expect(toggle).not.toBeChecked();
    await worker.evaluate(() => chrome.storage.local.set({ imageHoverButton: true }));
    await popup.reload();
    await expect(toggle).toBeChecked();

    await toggle.uncheck();
    await expect.poll(stored).toBe(false);
  } finally {
    await context.close();
  }
});

test("hovering an image in a dialog keeps an open result in place", async () => {
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
    await worker.evaluate(() =>
      chrome.storage.local.set({
        uiLocale: "en",
        displayMode: "panel",
        imageHoverButton: true,
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
          <dialog id="lightbox" style="width:500px; height:300px; padding:0; border:0">
            <img id="big" src="${IMAGE_URL}" style="width:500px; height:250px">
          </dialog>
        </body>`,
      }),
    );
    await context.route(IMAGE_URL, (route) =>
      route.fulfill({ contentType: "image/png", body: image }),
    );

    await page.goto(PAGE_URL);
    await expect(page.locator("#sample")).toHaveJSProperty("naturalWidth", 600);
    await page.waitForTimeout(500);

    await page.mouse.move(210, 160);
    await page.locator(".ocr-translate-image-button").click();
    await expect(page.locator("textarea")).toHaveValue(/SAMPLE\s+TEXT/, {
      timeout: 30_000,
    });

    // The result is showing, so hovering the dialog's image leaves it alone.
    await page.evaluate(() =>
      (document.getElementById("lightbox") as HTMLDialogElement).showModal(),
    );
    const box = (await page.locator("#big").boundingBox())!;
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.waitForTimeout(800);
    const hostParent = () =>
      page.evaluate(
        () => document.querySelector("ocr-translate-ui")?.parentElement?.localName,
      );
    expect(await hostParent()).toBe("body");

    await page.evaluate(() =>
      (document.getElementById("lightbox") as HTMLDialogElement).close(),
    );
    await expect(page.locator("textarea")).toHaveValue(/SAMPLE\s+TEXT/);
  } finally {
    await context.close();
  }
});
