import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium, firefox } from "@playwright/test";
import { transformWithOxc } from "vite";

const source = await readFile(new URL("../../src/entrypoints/content/overlay-selection.ts", import.meta.url), "utf8");
const { code } = await transformWithOxc(source, "overlay-selection.ts");
const css = await readFile(new URL("../../src/entrypoints/content/style.css", import.meta.url), "utf8");

for (const [name, browserType] of Object.entries({ chromium, firefox })) {
  test(`${name}: OCR dragging in a shadow root`, async () => {
    const browser = await browserType.launch({ headless: true,
      executablePath: process.env[`${name.toUpperCase()}_TEST_EXECUTABLE`],
    });
    try {
      const page = await browser.newPage();
      await page.setContent('<div id="host"></div>');
      await page.addScriptTag({ type: "module", content: `${code}\nwindow.startTextSelection = startTextSelection;` });
      await page.waitForFunction(() => Boolean(window.startTextSelection));
      await page.evaluate((styles) => {
        const root = document.querySelector("#host").attachShadow({ mode: "open" });
        const style = document.createElement("style");
        style.textContent = styles;
        root.append(style);
        const layer = document.createElement("div");
        layer.className = "ocr-translate-overlay-text-layer";
        layer.style.cssText = "left:100px;top:100px;width:160px;height:70px;--ocr-font:Arial";
        root.append(layer);
        for (const [line, text] of ["abcd", "ef"].entries()) {
          for (const [index, char] of [...text].entries()) {
            const span = document.createElement("span");
            span.className = "ocr-translate-overlay-text-layer-line";
            span.textContent = char;
            Object.assign(span.dataset, { x: `${index * 30}`, y: `${line * 40}`,
              width: "20", height: "20", line: `${line}`, character: "true" });
            span.style.cssText = `left:${index * 30}px;top:${line * 40}px;font-size:20px`;
            layer.append(span);
          }
        }
        let stop;
        const end = () => { stop?.(); stop = undefined; };
        layer.addEventListener("mousedown", (event) => {
          stop = window.startTextSelection(event, layer, window.selectionAngle ?? 0, end);
          window.prevented = event.defaultPrevented;
        });
        document.addEventListener("pointerup", end, true);
      }, css);
      const selected = () => page.evaluate(() => window.getSelection().toString().replace(/\s/g, ""));

      await page.mouse.move(101, 110);
      await page.mouse.down();
      await page.mouse.move(155, 110);
      assert.equal(await selected(), "ab");
      await page.mouse.move(215, 110);
      assert.equal(await selected(), "abcd");
      await page.mouse.move(155, 131);
      assert.equal(await selected(), "ab");
      await page.mouse.move(155, 150);
      assert.equal(await selected(), "abcdef");
      // Passing the end of a short line must not jump back to the longer line.
      await page.mouse.move(250, 150);
      assert.equal(await selected(), "abcdef");
      await page.mouse.up();
      await page.mouse.move(101, 110);
      assert.equal(await selected(), "abcdef");

      await page.mouse.move(215, 110);
      await page.mouse.down();
      await page.mouse.move(131, 110);
      assert.equal(await selected(), "bcd");
      await page.mouse.up();

      await page.mouse.dblclick(135, 110);
      assert.equal(await page.evaluate(() => window.prevented), false);
      assert.ok((await selected()).length > 0);
      await page.keyboard.down("Shift");
      await page.mouse.click(165, 110);
      await page.keyboard.up("Shift");
      assert.equal(await page.evaluate(() => window.prevented), false);

      for (const angle of [0, 0.25]) {
        await page.evaluate((rotation) => {
          window.selectionAngle = rotation;
          const layer = document.querySelector("#host").shadowRoot.querySelector(".ocr-translate-overlay-text-layer");
          layer.style.width = "70px";
          layer.style.height = "160px";
          layer.style.transform = `rotate(${rotation}rad)`;
          for (const span of layer.children) {
            const x = Number(span.dataset.line) === 0 ? 40 : 0;
            const y = Number(span.dataset.x);
            span.dataset.x = `${x}`;
            span.dataset.y = `${y}`;
            span.style.left = `${x}px`;
            span.style.top = `${y}px`;
            span.classList.add("is-vertical");
          }
        }, angle);
        const move = async (x, y) => {
          const dx = x - 35;
          const dy = y - 80;
          await page.mouse.move(135 + dx * Math.cos(angle) - dy * Math.sin(angle),
            180 + dx * Math.sin(angle) + dy * Math.cos(angle));
        };
        await move(50, 1);
        await page.mouse.down();
        await move(50, 115);
        assert.equal(await selected(), "abcd");
        await move(10, 55);
        assert.equal(await selected(), "abcdef");
        await page.mouse.up();
        // Restore horizontal coordinates before preparing the next variant.
        await page.evaluate(() => {
          const spans = document.querySelector("#host").shadowRoot.querySelectorAll("span");
          for (const span of spans) span.dataset.x = span.dataset.y;
        });
      }
    } finally {
      await browser.close();
    }
  });
}
