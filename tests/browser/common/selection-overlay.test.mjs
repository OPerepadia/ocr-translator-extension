import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium, firefox } from "@playwright/test";
import { transformWithOxc } from "vite";

const contentDir = new URL("../../../src/entrypoints/content/", import.meta.url);
const pickerSource = await readFile(new URL("image-picker.ts", contentDir), "utf8");
const frameSource = await readFile(new URL("frame-images.ts", contentDir), "utf8");
const selectionSource = await readFile(new URL("selection-overlay.ts", contentDir), "utf8");
const css = await readFile(new URL("style.css", contentDir), "utf8");
const { code } = await transformWithOxc(
  ["const t = (key: string) => key;", pickerSource, frameSource, selectionSource]
    .join("\n")
    .replace(/^import .*;\n/gm, ""),
  "selection-overlay.ts",
);
const svg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/%3E";
const whiteSvg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'%3E%3Crect width='10' height='10' fill='white'/%3E%3C/svg%3E";

// Firefox hit-tests against the last painted frame, so a pointer move right
// after an overlay appears can still reach the page.
const nextPaint = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

for (const [name, browserType] of Object.entries({ chromium, firefox })) {
  test(`${name}: region selection picks a hovered image on click`, async () => {
    const browser = await browserType.launch({
      headless: true,
      executablePath: process.env[`${name.toUpperCase()}_TEST_EXECUTABLE`],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.setContent(`
        <body style="margin:0; height:3000px">
          <img id="photo" src="${svg}" style="position:absolute; left:100px; top:150px; width:300px; height:200px">
          <div id="cover" style="position:absolute; left:100px; top:150px; width:300px; height:200px"></div>
          <img id="icon" src="${svg}" style="position:absolute; left:500px; top:150px; width:16px; height:16px">
          <img id="passive" src="${svg}" style="position:absolute; left:600px; top:150px; width:100px; height:100px; pointer-events:none">
          <div style="position:absolute; left:450px; top:400px; width:100px; height:100px; overflow:hidden">
            <img id="clipped" src="${svg}" style="position:absolute; left:150px; top:0; width:100px; height:100px">
          </div>
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

          // A page component with an image two shadow roots deep.
          const outer = document.createElement("div");
          outer.style.cssText = "position:absolute; left:100px; top:420px; width:200px; height:120px";
          const inner = document.createElement("div");
          const image = document.createElement("img");
          image.id = "shadowed";
          image.src = ${JSON.stringify(svg)};
          image.style.cssText = "display:block; width:200px; height:120px";
          inner.attachShadow({ mode: "open" }).append(image);
          outer.attachShadow({ mode: "open" }).append(inner);
          document.body.append(outer);

          window.release = releaseSelectionDim;
          window.start = (adjust) => {
            window.selection = "pending";
            startSelectionOverlay(container, adjust).then((result) => {
              window.selection = result?.kind === "image"
                ? { kind: "image", id: result.image.id }
                : result;
            });
          };
        `,
      });
      await page.waitForFunction(() => Boolean(window.start));
      const frame = page.locator(".ocr-translate-image-picker-frame");
      const start = async (adjust) => {
        await page.evaluate((adjust) => window.start(adjust), adjust);
        await nextPaint(page);
      };
      const settled = async () => {
        await page.waitForFunction(() => window.selection !== "pending");
        return page.evaluate(() => window.selection);
      };

      await start(true);
      await page.mouse.move(250, 250);
      assert.deepEqual(await frame.boundingBox(), { x: 100, y: 150, width: 300, height: 200 });

      // Icons are too small to offer, and empty space shows nothing.
      await page.mouse.move(508, 158);
      assert.equal(await frame.isVisible(), false);
      await page.mouse.move(600, 400);
      assert.equal(await frame.isVisible(), false);

      // Hit testing skips images with pointer-events: none.
      await page.mouse.move(650, 200);
      assert.equal(await frame.isVisible(), false);

      // Clipped out by its container.
      await page.mouse.move(650, 450);
      assert.equal(await frame.isVisible(), false);

      // A lightbox hides the page behind its backdrop.
      await page.evaluate((src) => {
        const lightbox = document.createElement("div");
        lightbox.id = "lightbox";
        lightbox.style.cssText = "position:fixed; inset:0; background:rgba(0, 0, 0, 0.9)";
        const image = document.createElement("img");
        image.src = src;
        image.style.cssText = "position:absolute; left:250px; top:300px; width:200px; height:150px";
        lightbox.append(image);
        document.body.append(lightbox);
      }, svg);
      await page.mouse.move(150, 200);
      assert.equal(await frame.isVisible(), false);
      await page.mouse.move(300, 320);
      assert.deepEqual(await frame.boundingBox(), { x: 250, y: 300, width: 200, height: 150 });
      await page.evaluate(() => document.querySelector("#lightbox").remove());

      // The page scrolling under a still pointer moves the image away.
      await page.mouse.move(250, 250);
      assert.equal(await frame.isVisible(), true);
      await page.evaluate(() => window.scrollTo(0, 300));
      await frame.waitFor({ state: "hidden" });
      await page.evaluate(() => window.scrollTo(0, 0));
      await frame.waitFor({ state: "visible" });

      // A drag too small for an area falls back to the hover.
      await page.mouse.down();
      await page.mouse.move(260, 260, { steps: 3 });
      assert.equal(await frame.isVisible(), false);
      await page.mouse.up();
      assert.equal(await frame.isVisible(), true);
      assert.equal(await page.evaluate(() => window.selection), "pending");

      // A click picks the image without the adjust step.
      await page.mouse.click(250, 250);
      assert.deepEqual(await settled(), { kind: "image", id: "photo" });
      assert.equal(await frame.isVisible(), false);
      await page.evaluate(() => window.release());

      // Images inside open shadow roots.
      await start(true);
      await page.mouse.move(200, 480);
      assert.deepEqual(await frame.boundingBox(), { x: 100, y: 420, width: 200, height: 120 });
      await page.mouse.click(200, 480);
      assert.deepEqual(await settled(), { kind: "image", id: "shadowed" });
      await page.evaluate(() => window.release());

      // A drag that starts on an image still selects an area.
      await start(false);
      await page.mouse.move(150, 200);
      await page.mouse.down();
      await page.mouse.move(350, 320, { steps: 5 });
      assert.equal(await frame.isVisible(), false);
      await page.mouse.up();
      assert.deepEqual(await settled(), {
        kind: "area",
        rect: { x: 150, y: 200, width: 200, height: 120 },
      });
      await page.evaluate(() => window.release());

      // An area being adjusted takes priority over image hover.
      await start(true);
      await page.mouse.move(450, 400);
      await page.mouse.down();
      await page.mouse.move(600, 500, { steps: 5 });
      await page.mouse.up();
      await page.mouse.move(250, 250);
      assert.equal(await frame.isVisible(), false);
      await page.keyboard.press("Escape");
      assert.equal(await settled(), null);
      assert.equal(await page.locator(".ocr-translate-selection-overlay").count(), 0);
    } finally {
      await browser.close();
    }
  });

  test(`${name}: touch selection does not activate the page and controls remain tappable`, async () => {
    const browser = await browserType.launch({
      headless: true,
      executablePath: process.env[`${name.toUpperCase()}_TEST_EXECUTABLE`],
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 800, height: 600 },
        hasTouch: true,
      });
      await page.setContent(`
        <body style="margin:0">
          <a href="#post"><img id="photo" src="${svg}" style="position:absolute; left:100px; top:150px; width:300px; height:200px"></a>
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
          window.pageClicks = 0;
          document.querySelector("a").addEventListener("click", () => window.pageClicks++);
          window.start = (adjust) => {
            window.selection = "pending";
            startSelectionOverlay(container, adjust).then((result) => {
              window.selection = result?.kind === "image"
                ? { kind: "image", id: result.image.id }
                : result;
            });
          };
        `,
      });
      await page.waitForFunction(() => Boolean(window.start));
      const start = async (adjust) => {
        await page.evaluate((adjust) => window.start(adjust), adjust);
        await nextPaint(page);
      };
      const settled = async () => {
        await page.waitForFunction(() => window.selection !== "pending");
        return page.evaluate(() => window.selection);
      };

      for (const adjust of [true, false]) {
        await start(adjust);
        await page.touchscreen.tap(250, 250);
        assert.deepEqual(await settled(), { kind: "image", id: "photo" });
        assert.equal(await page.evaluate(() => window.pageClicks), 0);
        assert.equal(await page.evaluate(() => location.hash), "");
      }

      for (const action of ["run", "cancel"]) {
        await start(true);
        await page.mouse.move(450, 150);
        await page.mouse.down();
        await page.mouse.move(650, 350, { steps: 5 });
        await page.mouse.up();
        await page.locator(`.ocr-translate-selection-${action}`).tap();
        assert.deepEqual(await settled(), action === "run"
          ? { kind: "area", rect: { x: 450, y: 150, width: 200, height: 200 } }
          : null);
      }

      await nextPaint(page);
      await page.touchscreen.tap(250, 250);
      assert.equal(await page.evaluate(() => window.pageClicks), 1);
      assert.equal(await page.evaluate(() => location.hash), "#post");
    } finally {
      await browser.close();
    }
  });

  test(`${name}: region selection picks an image inside an iframe`, async () => {
    const browser = await browserType.launch({
      headless: true,
      executablePath: process.env[`${name.toUpperCase()}_TEST_EXECUTABLE`],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      const srcdoc = (html) => html.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
      const nested = `
        <body style="margin:0">
          <img id="tall" src="${svg}" style="position:absolute; left:10px; top:10px; width:100px; height:200px">
        </body>
      `;
      const outer = `
        <body style="margin:0">
          <img id="wide" src="${svg}" style="position:absolute; left:20px; top:30px; width:200px; height:100px">
          <iframe name="2" srcdoc="${srcdoc(nested)}" style="position:absolute; left:250px; top:150px; width:120px; height:100px; border:0"></iframe>
        </body>
      `;
      const scaled = `
        <body style="margin:0">
          <img id="square" src="${svg}" style="position:absolute; left:40px; top:40px; width:100px; height:100px">
        </body>
      `;
      await page.setContent(`
        <body style="margin:0">
          <iframe name="1" srcdoc="${srcdoc(outer)}" style="position:absolute; left:100px; top:100px; width:400px; height:300px; border:5px solid; padding:10px"></iframe>
          <iframe name="3" srcdoc="${srcdoc(scaled)}" style="position:absolute; left:550px; top:100px; width:200px; height:200px; border:0; transform:scale(0.5); transform-origin:0 0"></iframe>
          <iframe srcdoc="${srcdoc(scaled)}" style="position:absolute; left:550px; top:300px; width:200px; height:200px; border:0"></iframe>
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
          // Stands in for the background, which adds the frame ID.
          window.receive = receiveFrameImage;
          window.release = releaseSelectionDim;
          window.outline = () => {
            const frame = container.querySelector(".ocr-translate-image-picker-frame");
            if (!frame || frame.hidden) {
              return null;
            }
            const { x, y, width, height } = frame.getBoundingClientRect();
            return { x, y, width, height };
          };
          window.start = () => {
            window.selection = "pending";
            startSelectionOverlay(container, false).then((result) => {
              window.selection = result;
            });
          };
        `,
      });
      // The last iframe has no content script, so it never answers.
      for (const frameName of ["1", "2", "3"]) {
        await page.frame({ name: frameName }).addScriptTag({
          type: "module",
          content: `${code}
            window.addEventListener("message", (event) => {
              answerFrameImageProbe(event, undefined, (answer) =>
                window.top.receive({ ...answer, frameId: Number(window.name) }),
              );
            });
            window.imageAt = (point) => findImageAtPoint(point.x, point.y)?.id;
          `,
        });
      }
      await page.waitForFunction(() => Boolean(window.start));
      const start = async () => {
        await page.evaluate(() => window.start());
        await nextPaint(page);
      };
      const settled = async () => {
        await page.waitForFunction(() => window.selection !== "pending");
        return page.evaluate(() => window.selection);
      };
      const outlineAt = async (x, y, expected) => {
        await page.mouse.move(x, y);
        await page.waitForFunction(
          (expected) => JSON.stringify(window.outline()) === JSON.stringify(expected),
          expected,
        );
      };

      await start();

      // The iframe's border and padding offset its page.
      await outlineAt(200, 200, { x: 135, y: 145, width: 200, height: 100 });
      await outlineAt(150, 380, null);
      // A nested iframe clips the image to its own viewport.
      await outlineAt(400, 300, { x: 375, y: 275, width: 100, height: 90 });
      // A scaled iframe scales its page.
      await outlineAt(590, 140, { x: 570, y: 120, width: 50, height: 50 });
      await outlineAt(650, 350, null);
      // Hover resumes after an iframe that never answers.
      await outlineAt(200, 200, { x: 135, y: 145, width: 200, height: 100 });

      // A drag that starts on an iframe image still selects an area.
      await page.mouse.down();
      await page.mouse.move(300, 300, { steps: 5 });
      await page.mouse.up();
      assert.deepEqual(await settled(), {
        kind: "area",
        rect: { x: 200, y: 200, width: 100, height: 100 },
      });
      await page.evaluate(() => window.release());

      // A click picks the image in the frame that found it. That frame shows
      // the result, so no dim stays behind in the top frame.
      await start();
      await outlineAt(400, 300, { x: 375, y: 275, width: 100, height: 90 });
      await page.mouse.click(400, 300);
      const selection = await settled();
      assert.deepEqual(selection, {
        kind: "frame-image",
        image: {
          frameId: 2,
          rect: { x: 375, y: 275, width: 100, height: 90 },
          point: { x: 35, y: 35 },
        },
      });
      assert.equal(await page.locator(".ocr-translate-selection-overlay").count(), 0);
      assert.equal(
        await page.frame({ name: "2" }).evaluate((point) => window.imageAt(point), selection.image.point),
        "tall",
      );
    } finally {
      await browser.close();
    }
  });

  test(`${name}: the selection dim stays out of the captured region`, async () => {
    const browser = await browserType.launch({
      headless: true,
      executablePath: process.env[`${name.toUpperCase()}_TEST_EXECUTABLE`],
    });
    try {
      // Fractional scaling puts box edges between device pixels.
      const page = await browser.newPage({
        viewport: { width: 800, height: 600 },
        deviceScaleFactor: 1.5,
      });
      await page.setContent(`
        <body style="margin:0; background:white">
          <img id="photo" src="${whiteSvg}" style="position:absolute; left:400.4px; top:300.6px; width:201.4px; height:151.2px">
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
          window.release = releaseSelectionDim;
          window.start = () => {
            window.selection = "pending";
            startSelectionOverlay(container, false).then((result) => {
              window.selection = result?.kind === "image"
                ? { kind: "image", rect: result.image.getBoundingClientRect().toJSON() }
                : result;
            });
          };
        `,
      });
      await page.waitForFunction(() => Boolean(window.start));
      const start = async () => {
        await page.evaluate(() => window.start());
        await nextPaint(page);
      };
      const settled = async () => {
        await page.waitForFunction(() => window.selection !== "pending");
        return page.evaluate(() => window.selection);
      };
      // Crop a screenshot the way captureVisibleArea does; the page is white,
      // so any darker pixel is dim that leaked in.
      const darkest = async (rect) => {
        const data = (await page.screenshot()).toString("base64");
        return page.evaluate(async ({ data, rect }) => {
          const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
          const bitmap = await createImageBitmap(blob);
          const dprX = bitmap.width / innerWidth;
          const dprY = bitmap.height / innerHeight;
          const x = Math.max(0, Math.round(rect.x * dprX));
          const y = Math.max(0, Math.round(rect.y * dprY));
          const width = Math.max(1, Math.round(rect.width * dprX));
          const height = Math.max(1, Math.round(rect.height * dprY));
          const context = new OffscreenCanvas(width, height).getContext("2d");
          context.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
          const pixels = context.getImageData(0, 0, width, height).data;
          let min = 255;
          for (let index = 0; index < pixels.length; index += 4) {
            min = Math.min(min, pixels[index], pixels[index + 1], pixels[index + 2]);
          }
          return min;
        }, { data, rect });
      };

      for (const [startX, startY, endX, endY] of [
        [100, 100, 301, 201],
        [101, 101, 302, 202],
        [100.3, 100.7, 301.6, 201.2],
      ]) {
        await start();
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(endX, endY, { steps: 5 });
        await page.mouse.up();
        const { rect } = await settled();
        assert.equal(await darkest(rect), 255, JSON.stringify(rect));
        await page.evaluate(() => window.release());
      }

      await start();
      await page.mouse.move(500, 375);
      await page.mouse.click(500, 375);
      const { rect } = await settled();
      assert.equal(await darkest(rect), 255, JSON.stringify(rect));
    } finally {
      await browser.close();
    }
  });
}
