import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium, firefox } from "@playwright/test";
import { transformWithOxc } from "vite";

const contentDir = new URL("../../../src/entrypoints/content/", import.meta.url);
const read = (name) => readFile(new URL(name, contentDir), "utf8");
const css = await read("style.css");
const { code } = await transformWithOxc(
  [
    "const t = (key: string) => key;",
    await read("icons.ts"),
    await read("image-picker.ts"),
    await read("overlay-layout.ts"),
    await read("image-rect.ts"),
    await read("image-hover-button.ts"),
  ]
    .join("\n")
    .replace(/^import .*;\n/gm, ""),
  "image-hover-button.ts",
);

// Blank images. The 20x10 one shows letterboxing.
const svg = (width, height) =>
  `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'/%3E`;

// Hit testing and the button both lag the pointer by a frame.
const nextPaint = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

for (const [name, browserType] of Object.entries({ chromium, firefox })) {
  test(`${name}: the hover button follows large images under the pointer`, async () => {
    const browser = await browserType.launch({
      headless: true,
      executablePath: process.env[`${name.toUpperCase()}_TEST_EXECUTABLE`],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.setContent(`
        <body style="margin:0; height:3000px">
          <img id="big" src="${svg(10, 10)}" style="position:absolute; left:100px; top:150px; width:300px; height:200px">
          <img id="small" src="${svg(10, 10)}" style="position:absolute; left:500px; top:150px; width:100px; height:100px">
          <img id="wide" src="${svg(20, 10)}" style="position:absolute; left:100px; top:400px; width:300px; height:300px; object-fit:contain">
        </body>
      `);
      await page.addScriptTag({
        type: "module",
        content: `${code}
          const host = document.createElement("div");
          document.body.append(host);
          const shadow = host.attachShadow({ mode: "open" });
          const style = document.createElement("style");
          style.textContent = ${JSON.stringify(css)};
          const container = document.createElement("div");
          shadow.append(style, container);

          // The UI is mounted on the first hover.
          window.mounts = 0;
          window.mounted = false;
          window.paused = false;
          window.translated = [];
          window.stop = startImageHoverButton({
            getReadyUiRoot: () => (window.mounted ? container : undefined),
            getUiHost: () => host,
            mountUi: async () => {
              window.mounts += 1;
              window.mounted = true;
            },
            isPaused: () => window.paused,
            onTranslate: (image) => window.translated.push(image.id),
          });
          window.container = container;
        `,
      });
      await page.waitForFunction(() => Boolean(window.stop));
      const button = page.locator(".ocr-translate-image-button");

      await page.mouse.move(250, 250);
      await button.waitFor({ state: "visible" });
      assert.equal(await page.evaluate(() => window.mounts), 1);
      assert.deepEqual(await button.boundingBox(), { x: 360, y: 158, width: 32, height: 32 });
      assert.equal(await button.getAttribute("aria-label"), "contextTranslateImage");

      // The pointer can move onto the button without it going away.
      await page.mouse.move(376, 174);
      await nextPaint(page);
      assert.equal(await button.isVisible(), true);

      // Moving off the image, or onto a small one, hides it.
      await page.mouse.move(650, 400);
      await button.waitFor({ state: "hidden" });
      await page.mouse.move(250, 250);
      await button.waitFor({ state: "visible" });
      await page.mouse.move(550, 200);
      await button.waitFor({ state: "hidden" });

      // The button sits on the picture, not on the letterbox bars.
      await page.mouse.move(250, 550);
      await button.waitFor({ state: "visible" });
      assert.deepEqual(await button.boundingBox(), { x: 360, y: 483, width: 32, height: 32 });

      // Scrolling moves the button with the image.
      await page.mouse.move(250, 200);
      await page.evaluate(() => window.scrollTo(0, 100));
      await page.waitForFunction(
        () => document.querySelector("#big").getBoundingClientRect().top === 50,
      );
      await nextPaint(page);
      assert.deepEqual(await button.boundingBox(), { x: 360, y: 58, width: 32, height: 32 });

      // It stays in the visible part of the image.
      await page.evaluate(() => window.scrollTo(0, 250));
      await page.mouse.move(250, 50);
      await nextPaint(page);
      assert.deepEqual(await button.boundingBox(), { x: 360, y: 8, width: 32, height: 32 });

      // A sliver left on screen is not worth a button.
      await page.evaluate(() => window.scrollTo(0, 330));
      await page.mouse.move(250, 10);
      await nextPaint(page);
      assert.equal(await button.isVisible(), false);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.mouse.move(250, 250);
      await button.waitFor({ state: "visible" });

      // Other extension UI under the pointer hides it.
      await page.evaluate(() => {
        const cover = document.createElement("div");
        cover.id = "cover";
        cover.style.cssText = "position:fixed; inset:0; z-index:2147483647";
        window.container.append(cover);
      });
      await page.mouse.move(260, 260);
      await button.waitFor({ state: "hidden" });
      await page.evaluate(() => window.container.querySelector("#cover").remove());
      await page.mouse.move(250, 250);
      await button.waitFor({ state: "visible" });

      // It stays hidden while paused.
      await page.evaluate(() => {
        window.paused = true;
      });
      await page.mouse.move(255, 255);
      await button.waitFor({ state: "hidden" });
      await page.evaluate(() => {
        window.paused = false;
      });
      await page.mouse.move(250, 250);
      await button.waitFor({ state: "visible" });

      // A click translates the image and hides the button until the pointer
      // leaves it.
      await button.click();
      assert.deepEqual(await page.evaluate(() => window.translated), ["big"]);
      await nextPaint(page);
      assert.equal(await button.isVisible(), false);
      await page.mouse.move(260, 260);
      await nextPaint(page);
      assert.equal(await button.isVisible(), false);
      await page.mouse.move(650, 400);
      await nextPaint(page);
      await page.mouse.move(250, 250);
      await button.waitFor({ state: "visible" });
      assert.deepEqual(await page.evaluate(() => window.translated), ["big"]);

      // A right-click hides it the same way, since the menu can translate
      // the image from a screenshot.
      await page.mouse.click(250, 250, { button: "right" });
      await nextPaint(page);
      assert.equal(await button.isVisible(), false);
      await page.mouse.move(260, 260);
      await nextPaint(page);
      assert.equal(await button.isVisible(), false);
      await page.mouse.move(650, 400);
      await nextPaint(page);
      await page.mouse.move(250, 250);
      await button.waitFor({ state: "visible" });

      // Stopping removes the button and the listeners.
      await page.evaluate(() => window.stop());
      assert.equal(await page.locator(".ocr-translate-image-button").count(), 0);
      await page.mouse.move(260, 260);
      await nextPaint(page);
      assert.equal(await page.locator(".ocr-translate-image-button").count(), 0);
      assert.equal(await page.evaluate(() => window.mounts), 1);
    } finally {
      await browser.close();
    }
  });
}
