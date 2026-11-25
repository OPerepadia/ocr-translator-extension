import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium, firefox } from "@playwright/test";
import { transformWithOxc } from "vite";

const contentDir = new URL("../../../src/entrypoints/content/", import.meta.url);
const popoverSource = await readFile(new URL("overlay-popover.ts", contentDir), "utf8");
const iconsSource = await readFile(new URL("icons.ts", contentDir), "utf8");
const css = await readFile(new URL("style.css", contentDir), "utf8");
const { code } = await transformWithOxc(
  [
    "const t = (key: string) => key;",
    "const rotatedBounds = (rect: any) => rect;",
    "const isSpeaking = () => false, requestSpeak = () => {}, stopSpeaking = () => {};",
    iconsSource,
    popoverSource,
  ]
    .join("\n")
    .replace(/^import [^;]*;\n/gm, ""),
  "overlay-popover.ts",
);

const setupScript = `${code}
  window.start = (blocks) => {
    const shadow = document.querySelector("#host").attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = ${JSON.stringify(css)};
    const container = document.createElement("div");
    container.className = "ocr-translate-overlay";
    shadow.append(style, container);
    const boxes = blocks.map(({ rect, words }) => {
      const element = document.createElement("div");
      element.className = "ocr-translate-overlay-box ocr-translate-overlay-frame-box";
      element.style.cssText = \`left:\${rect.x}px;top:\${rect.y}px;width:\${rect.width}px;height:\${rect.height}px\`;
      container.append(element);
      const text = "sample text ".repeat(words / 2);
      return { element, rect, angle: 0, content: { original: text, translated: text } };
    });
    window.popover = createOverlayPopover({
      container,
      speechOwner: "test",
      getState: () => ({
        boxes,
        mode: "translation",
        hasTranslation: true,
        sourceLang: "en",
        targetLang: "uk",
        selectingFromPopover: false,
      }),
      beginSelection: () => {},
      endSelection: () => {},
    });
    boxes.forEach((box, index) => window.popover.attach(box.element, index));
  };
`;

for (const [name, browserType] of Object.entries({ chromium, firefox })) {
  const withBlocks = (label, blocks, run) =>
    test(`${name}: ${label}`, async () => {
      const browser = await browserType.launch({
        headless: true,
        executablePath: process.env[`${name.toUpperCase()}_TEST_EXECUTABLE`],
      });
      try {
        const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
        await page.setContent("<div id='host'></div>");
        await page.addScriptTag({ type: "module", content: setupScript });
        await page.waitForFunction(() => Boolean(window.start));
        await page.evaluate((blocks) => window.start(blocks), blocks);
        const popover = page.locator(".ocr-translate-overlay-popover");
        await run({
          page,
          popover,
          body: popover.locator(".ocr-translate-overlay-popover-body"),
          hover: async (index) => {
            const { x, y } = blocks[index].rect;
            await page.mouse.move(x + 10, y + 10);
            await page.mouse.move(x + 11, y + 10);
            await page.waitForTimeout(250);
          },
          // Without the popover's opening motion.
          rect: () =>
            popover.evaluate((el) => ({
              x: el.offsetLeft,
              y: el.offsetTop,
              width: el.offsetWidth,
              height: el.offsetHeight,
            })),
        });
      } finally {
        await browser.close();
      }
    });
  const cutOff = (body) => body.evaluate((el) => el.scrollHeight - el.clientHeight);

  withBlocks(
    "long text opens beside its block, and the pointer can move onto it",
    [{ rect: { x: 100, y: 200, width: 300, height: 300 }, words: 80 }],
    async ({ page, popover, body, hover, rect }) => {
      await hover(0);
      const { x, y, width, height } = await rect();
      assert.equal(x, 400);
      assert.ok(width <= 384, `width ${width}`);
      assert.ok(y >= 8 && y + height <= 692, `${y} + ${height}`);
      assert.ok((await cutOff(body)) <= 1);

      await page.mouse.move(390, 210);
      await page.mouse.move(420, 210, { steps: 5 });
      await page.waitForTimeout(400);
      assert.equal(await popover.isVisible(), true);
      await page.mouse.move(1150, 30);
      await page.waitForTimeout(400);
      assert.equal(await popover.isHidden(), true);
    },
  );

  withBlocks(
    "short text opens below its block",
    [{ rect: { x: 100, y: 200, width: 300, height: 300 }, words: 10 }],
    async ({ hover, rect }) => {
      await hover(0);
      assert.equal((await rect()).y, 500);
    },
  );

  withBlocks(
    "a block without room around it is covered in part",
    [{ rect: { x: 50, y: 50, width: 1100, height: 600 }, words: 400 }],
    async ({ hover, rect }) => {
      await hover(0);
      const { y, height } = await rect();
      assert.equal(height, 320);
      assert.equal(y + height, 692);
    },
  );

  withBlocks(
    "the popover's last place does not narrow the next one",
    [
      { rect: { x: 900, y: 100, width: 200, height: 30 }, words: 60 },
      { rect: { x: 100, y: 100, width: 500, height: 30 }, words: 60 },
    ],
    async ({ hover, rect }) => {
      await hover(1);
      const expected = await rect();
      await hover(0);
      await hover(1);
      assert.deepEqual(await rect(), expected);
      assert.equal(expected.width, 500);
    },
  );

  withBlocks(
    "placing the popover again keeps its scroll position",
    [{ rect: { x: 50, y: 50, width: 1100, height: 600 }, words: 600 }],
    async ({ page, body, hover }) => {
      await hover(0);
      await body.evaluate((el) => { el.scrollTop = 120; });
      await page.evaluate(() => window.popover.reposition());
      assert.equal(await body.evaluate((el) => el.scrollTop), 120);
    },
  );
}
