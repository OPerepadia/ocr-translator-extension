import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium, firefox } from "@playwright/test";
import { transformWithOxc } from "vite";

const contentDir = new URL("../../../src/entrypoints/content/", import.meta.url);
const css = await readFile(new URL("style.css", contentDir), "utf8");

// The content modules are compiled into one script. Their imports are dropped,
// so each test lists the files it needs, in dependency order.
async function compile(files, name, stubs = []) {
  const sources = await Promise.all(
    files.map((file) => readFile(new URL(file, contentDir), "utf8")),
  );
  const { code } = await transformWithOxc(
    ["const t = (key: string) => key;", ...stubs, ...sources]
      .join("\n")
      .replace(/^import[\s\S]*?from\s+["'][^"']+["'];\n/gm, ""),
    `${name}.ts`,
  );
  return code;
}

const panelCode = await compile(["icons.ts", "live-layout.ts", "live-panel.ts"], "live-panel", [
  "const languageName = (code: string) => `Language ${code}`;",
]);
const selectionCode = await compile(["image-picker.ts", "selection-overlay.ts"], "selection");
const modalCode = await compile(["modal-ui.ts"], "modal-ui");

const svg =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/%3E";

// The UI lives in a shadow root, with the extension's stylesheet.
const uiSetup = `
  const host = document.createElement("div");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = ${JSON.stringify(css)};
  const container = document.createElement("div");
  shadow.append(style, container);
  window.settle = () =>
    Promise.all(
      shadow
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished),
    );
`;

async function withPage(browserType, name, viewport, run) {
  const browser = await browserType.launch({
    headless: true,
    executablePath: process.env[`${name.toUpperCase()}_TEST_EXECUTABLE`],
  });
  try {
    const page = await browser.newPage({ viewport });
    await run(page);
  } finally {
    await browser.close();
  }
}

const box = (page, selector) => page.locator(selector).boundingBox();

// The panel fades in, scaling slightly. Measure it once that is over; looping
// animations such as the status dot never end, so they are left out.
const settle = (page) => page.evaluate(() => window.settle());

function overlaps(a, b) {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

for (const [name, browserType] of Object.entries({ chromium, firefox })) {
  test(`${name}: the live panel sits beside its region and shows each state`, async () => {
    await withPage(browserType, name, { width: 800, height: 600 }, async (page) => {
      await page.setContent(`<body style="margin:0"></body>`);
      await page.addScriptTag({
        type: "module",
        content: `${panelCode}
          ${uiSetup}
          window.calls = [];
          window.show = (region) => {
            window.panel?.dispose();
            window.panel = showLivePanel(container, region, {
              onPause: () => calls.push("pause"),
              onResume: () => calls.push("resume"),
              onSelectNewRegion: () => calls.push("select"),
              onRetry: () => calls.push("retry"),
              onClose: () => calls.push("close"),
            });
          };
          window.pageClicks = 0;
          document.addEventListener("click", () => window.pageClicks++);
          document.addEventListener("dblclick", () => window.pageClicks++);
        `,
      });
      await page.waitForFunction(() => Boolean(window.show));
      const show = (region) => page.evaluate((region) => window.show(region), region);
      const render = (state) => page.evaluate((state) => window.panel.render(state), state);
      const text = (selector) => page.locator(selector).textContent();
      const frame = ".ocr-translate-live-region";
      const panel = ".ocr-translate-live";

      // Below the region, outside the frame drawn around it, at its default size.
      const region = { x: 100, y: 100, width: 600, height: 80 };
      await show(region);
      await settle(page);
      assert.equal(overlaps(await box(page, panel), await box(page, frame)), false);
      const { width, height } = await box(page, panel);
      assert.deepEqual({ width, height }, { width: 480, height: 180 });
      assert.ok((await box(page, panel)).y >= 180 + 12);
      assert.deepEqual(await page.evaluate(() => window.panel.getMask()), []);
      // The frame stays clear of the pixels that are read.
      assert.deepEqual(await box(page, frame), { x: 96, y: 96, width: 608, height: 88 });

      // Above a region at the bottom edge.
      await show({ x: 100, y: 500, width: 600, height: 70 });
      const above = await box(page, panel);
      assert.ok(above.y + above.height <= 500 - 12 + 1);

      await show(region);
      const onScreen = (line) => ({ status: "running", lines: [line], line });
      const original = page.locator(".ocr-translate-live-original");
      const statusNote = page.locator(".ocr-translate-live-note");
      await render(onScreen({ original: "Hello there", translation: "Bonjour", state: "ready" }));
      assert.equal(await text(".ocr-translate-live-translation"), "Bonjour");
      assert.equal(await original.isVisible(), false);
      assert.equal(await statusNote.isVisible(), false);

      await page.locator(".ocr-translate-live-actions button").nth(0).click();
      assert.equal(await original.isVisible(), true);
      assert.equal(await text(".ocr-translate-live-original"), "Hello there");

      await render(onScreen({ original: "Hello there", state: "pending" }));
      assert.equal(await text(".ocr-translate-live-translation"), "Hello there");
      assert.equal(await page.locator(".ocr-translate-live-line-note").isVisible(), false);

      await render(onScreen({ original: "Hello there", state: "failed", error: "HTTP 429" }));
      assert.equal(await text(".ocr-translate-live-line-note"), "HTTP 429");

      // A line whose translation was cancelled shows what was read, with no note.
      await render(onScreen({ original: "Hello there", state: "skipped" }));
      assert.equal(await text(".ocr-translate-live-translation"), "Hello there");
      assert.equal(await page.locator(".ocr-translate-live-line-note").isVisible(), false);

      await render({ status: "running", lines: [] });
      assert.equal(await text(".ocr-translate-live-note"), "liveWaitingForText");

      // The languages show once they are known, with their names to hover.
      const languages = page.locator(".ocr-translate-live-languages");
      assert.equal(await languages.isVisible(), false);
      await render({ status: "running", lines: [], sourceLang: "en", targetLang: "uk" });
      assert.equal(await languages.textContent(), "EN → UK");
      assert.equal(await languages.getAttribute("title"), "Language en → Language uk");
      // They sit right after the title, with the buttons on the far side.
      const title = await box(page, ".ocr-translate-live-title");
      const beside = await languages.boundingBox();
      const buttons = await box(page, ".ocr-translate-live-actions");
      const gap = beside.x - (title.x + title.width);
      assert.ok(gap >= 0 && gap <= 12, JSON.stringify({ title, beside }));
      assert.ok(buttons.x - (beside.x + beside.width) > 20, JSON.stringify({ beside, buttons }));
      await render({ status: "running", lines: [], sourceLang: "zh-cn", targetLang: "uk" });
      assert.equal(await languages.textContent(), "ZH-CN → UK");
      // Without a detected source there is only the target.
      await render({ status: "running", lines: [], targetLang: "uk" });
      assert.equal(await languages.textContent(), "→ UK");
      assert.equal(await languages.getAttribute("title"), "? → Language uk");
      await render({ status: "running", lines: [], sourceLang: "en", targetLang: "uk" });

      // Pause becomes resume while paused.
      await page.locator(".ocr-translate-live-actions button").nth(1).click();
      await render({ status: "paused", lines: [] });
      assert.equal(await text(".ocr-translate-live-note"), "livePaused");
      await page.locator(".ocr-translate-live-actions button").nth(1).click();

      await render({ status: "error", lines: [], error: "worker crashed" });
      assert.equal(await text(".ocr-translate-live-note"), "worker crashed");
      assert.equal(await page.locator(".ocr-translate-live-actions button").nth(1).isDisabled(), true);
      await page.locator(".ocr-translate-live-retry").click();

      await page.locator(".ocr-translate-live-actions button").nth(2).click();
      await page.locator(".ocr-translate-live-actions button").nth(3).click();
      assert.deepEqual(await page.evaluate(() => window.calls), [
        "pause",
        "resume",
        "retry",
        "select",
        "close",
      ]);

      // Clicks on the panel do not reach the page, where a video player would
      // treat them as play, pause or full screen.
      await page.locator(".ocr-translate-live-title").dblclick();
      assert.equal(await page.evaluate(() => window.pageClicks), 0);
    });
  });

  test(`${name}: the live panel keeps earlier lines above the newest`, async () => {
    await withPage(browserType, name, { width: 800, height: 600 }, async (page) => {
      await page.setContent(`<body style="margin:0"></body>`);
      await page.addScriptTag({
        type: "module",
        content: `${panelCode}
          ${uiSetup}
          window.panel = showLivePanel(container, { x: 100, y: 100, width: 600, height: 80 }, {
            onPause() {}, onResume() {}, onSelectNewRegion() {}, onRetry() {}, onClose() {},
          });
          const lineAt = (number) => ({
            original: "Line " + number,
            translation: "Translated line " + number,
            state: "ready",
          });
          // "tail" replaces the newest lines. Reports, right after drawing,
          // whether the lines slide and the newest fades in (both only show
          // while the animations run), and where the line above the newest is.
          window.showLines = (count, { onScreen = true, tail = [] } = {}) => {
            const lines = Array.from({ length: count }, (_, index) => lineAt(index + 1));
            lines.splice(count - tail.length, tail.length, ...tail);
            window.panel.render({
              status: "running",
              lines,
              line: onScreen ? lines.at(-1) : undefined,
            });
            const views = container.querySelectorAll(".ocr-translate-live-line");
            return {
              slid: container.querySelector(".ocr-translate-live-track").getAnimations().length > 0,
              faded: views[views.length - 1].getAnimations().length > 0,
              aboveY: views.length > 1 ? views[views.length - 2].getBoundingClientRect().y : 0,
            };
          };
        `,
      });
      await page.waitForFunction(() => Boolean(window.panel));
      await settle(page);
      const showLines = async (count, options) => {
        const result = await page.evaluate(
          ([count, options]) => window.showLines(count, options),
          [count, options],
        );
        await settle(page);
        return result;
      };
      const list = page.locator(".ocr-translate-live-lines");
      const scroll = () =>
        list.evaluate((element) => ({
          top: element.scrollTop,
          end: element.scrollHeight - element.clientHeight,
        }));
      const lines = page.locator(".ocr-translate-live-line");
      const translationOf = (line) =>
        line.locator(".ocr-translate-live-translation").textContent();
      const near = (actual, expected) => Math.abs(actual - expected) <= 1;
      const atEnd = async () => {
        const { top, end } = await scroll();
        return near(top, end);
      };

      await showLines(20);
      assert.equal(await lines.count(), 20);
      // The panel keeps its size and the lines scroll, with the newest at the
      // bottom and in view.
      assert.equal((await box(page, ".ocr-translate-live")).height, 180);
      assert.ok((await scroll()).end > 0, JSON.stringify(await scroll()));
      assert.equal(await atEnd(), true);
      assert.equal(await translationOf(lines.first()), "Translated line 1");
      assert.equal(await translationOf(lines.last()), "Translated line 20");
      const current = page.locator(".ocr-translate-live-line.is-current");
      assert.equal(await current.count(), 1);
      assert.equal(await translationOf(current), "Translated line 20");

      // Lines already shown are updated in place, not drawn again.
      await lines.first().evaluate((element) => (element.dataset.marked = "yes"));

      // The button that jumps to the newest line shows only when scrolled up.
      const latest = page.locator(".ocr-translate-live-latest");
      assert.equal(await latest.isVisible(), false);

      // Scrolled up to read, the lines in view stay put as lines come in below.
      await list.evaluate((element) => (element.scrollTop = 0));
      // The scroll event comes a frame later.
      await latest.waitFor({ state: "visible" });
      await settle(page);
      const before = await lines.first().boundingBox();
      const unwatched = await showLines(21);
      assert.equal(unwatched.slid || unwatched.faded, false);
      assert.equal((await scroll()).top, 0);
      assert.deepEqual(await lines.first().boundingBox(), before);
      assert.equal(await lines.first().getAttribute("data-marked"), "yes");
      assert.equal(await latest.isVisible(), true);

      // The button sits over the list, and is no part of the keyboard or
      // screen reader's way.
      const listBox = await box(page, ".ocr-translate-live-lines");
      const latestBox = await latest.boundingBox();
      assert.ok(latestBox.y + latestBox.height <= listBox.y + listBox.height);
      assert.ok(latestBox.y >= listBox.y);
      assert.equal(await latest.getAttribute("aria-hidden"), "true");
      assert.equal(await latest.getAttribute("tabindex"), "-1");

      // Clicking it shows the newest line, and the button goes away.
      await latest.click();
      await settle(page);
      assert.equal(await atEnd(), true);
      assert.equal(await latest.isVisible(), false);

      // At the end, it follows the newest line, sliding it in.
      const following = await showLines(22);
      assert.equal(following.slid, true);
      assert.equal(following.faded, true);
      assert.equal(await atEnd(), true);
      assert.equal(await translationOf(lines.last()), "Translated line 22");

      // The lines start where they were, so nothing jumps: the one above the
      // newest has moved up only once the slide is over.
      const settled = (await lines.nth(20).boundingBox()).y;
      assert.ok(settled < following.aboveY - 10, JSON.stringify({ settled, following }));

      // Earlier lines are faded, the newest is not.
      const opacityOf = (line) =>
        line.evaluate((element) => Number(getComputedStyle(element).opacity));
      assert.equal(await opacityOf(lines.last()), 1);
      assert.ok((await opacityOf(lines.nth(20))) < 1);

      // Once the region is empty, no line is marked as the one on screen, and
      // the newest line stays as it was.
      await showLines(22, { onScreen: false });
      assert.equal(await current.count(), 0);
      assert.equal(await lines.count(), 22);
      assert.equal(await opacityOf(lines.last()), 1);

      // Only the newest line says it is already in the target language.
      await showLines(24, {
        tail: [
          { original: "Line 23", state: "same-language" },
          { original: "Line 24", state: "same-language" },
        ],
      });
      const notes = page.locator(".ocr-translate-live-line-note:visible");
      assert.equal(await notes.count(), 1);
      assert.equal(await notes.textContent(), "panelAlreadyInTargetLanguage");

      // A line waiting for its translation is as tall as a translated one, so
      // the lines above it stay put when the translation comes.
      await showLines(25, { tail: [{ original: "Line 25", state: "pending" }] });
      const pendingY = (await lines.nth(23).boundingBox()).y;
      const ready = await showLines(25);
      assert.ok(near(ready.aboveY, pendingY), JSON.stringify({ pendingY, ready }));
      assert.equal(ready.slid, false);

      // A translation that is taller pushes the lines above it up. They start
      // where they were and slide.
      const long = "Translated line 25 ".repeat(12);
      const tall = await showLines(25, {
        tail: [{ original: "Line 25", translation: long, state: "ready" }],
      });
      assert.equal(tall.slid, true);
      assert.ok(near(tall.aboveY, ready.aboveY), JSON.stringify({ ready, tall }));
      assert.equal(await atEnd(), true);

      await page.emulateMedia({ reducedMotion: "reduce" });
      const reduced = await showLines(26);
      assert.equal(reduced.slid || reduced.faded, false);
      assert.equal(await atEnd(), true);
    });
  });

  test(`${name}: the live panel resizes from its corner`, async () => {
    await withPage(browserType, name, { width: 800, height: 600 }, async (page) => {
      await page.setContent(`<body style="margin:0"></body>`);
      await page.addScriptTag({
        type: "module",
        content: `${panelCode}
          ${uiSetup}
          window.panel = showLivePanel(container, { x: 100, y: 100, width: 600, height: 80 }, {
            onPause() {}, onResume() {}, onSelectNewRegion() {}, onRetry() {}, onClose() {},
          });
        `,
      });
      await page.waitForFunction(() => Boolean(window.panel));
      await settle(page);
      const panel = () => box(page, ".ocr-translate-live");
      // Pointer positions stay inside the viewport: Firefox reports odd
      // coordinates for synthetic moves outside it.
      const dragGripTo = async (toX, toY) => {
        const grip = await box(page, ".ocr-translate-live-resize");
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
        await page.mouse.down();
        await page.mouse.move(toX, toY, { steps: 5 });
        await page.mouse.up();
      };
      const dragGrip = async (dx, dy) => {
        const grip = await box(page, ".ocr-translate-live-resize");
        await dragGripTo(grip.x + grip.width / 2 + dx, grip.y + grip.height / 2 + dy);
      };
      const near = (actual, expected) => Math.abs(actual - expected) <= 1;

      const start = await panel();
      await dragGrip(140, 60);
      const grown = await panel();
      const where = JSON.stringify({ start, grown });
      assert.ok(near(grown.width, start.width + 140), where);
      assert.ok(near(grown.height, start.height + 60), where);
      assert.ok(near(grown.x, start.x) && near(grown.y, start.y), where);

      // There is no limit but the viewport.
      await dragGripTo(799, 599);
      const largest = await panel();
      assert.ok(near(largest.x + largest.width, 800 - 8), JSON.stringify(largest));
      assert.ok(near(largest.y + largest.height, 600 - 8), JSON.stringify(largest));

      // With the languages shown, a bar that is a little short of room shrinks
      // the title and leaves the languages whole.
      await page.evaluate(() =>
        window.panel.render({ status: "running", lines: [], sourceLang: "en", targetLang: "uk" }),
      );
      const wide = {
        title: (await box(page, ".ocr-translate-live-title")).width,
        languages: (await box(page, ".ocr-translate-live-languages")).width,
      };
      await dragGripTo(start.x + 300, start.y + 100);
      const narrow = {
        title: (await box(page, ".ocr-translate-live-title")).width,
        languages: (await box(page, ".ocr-translate-live-languages")).width,
      };
      assert.ok(narrow.title < wide.title - 5, JSON.stringify({ wide, narrow }));
      assert.ok(Math.abs(narrow.languages - wide.languages) < 0.1, JSON.stringify({ wide, narrow }));

      // It stays big enough for the title bar and a line.
      await dragGripTo(start.x, start.y);
      const smallest = await panel();
      assert.deepEqual(
        { width: smallest.width, height: smallest.height },
        { width: 220, height: 96 },
      );

      // Even at that size the buttons and the languages fit in the title bar,
      // and the long pair gives way before the buttons do.
      await page.evaluate(() =>
        window.panel.render({ status: "running", lines: [], sourceLang: "zh-cn", targetLang: "uk" }),
      );
      const bar = await box(page, ".ocr-translate-live-topbar");
      const close = await box(page, ".ocr-translate-live-actions button:last-child");
      assert.ok(close.x + close.width <= bar.x + bar.width, JSON.stringify({ bar, close }));
      const label = await box(page, ".ocr-translate-live-languages");
      assert.ok(label.width > 20, JSON.stringify(label));

      // A new size stays when the window changes.
      await dragGrip(100, 100);
      const resized = await panel();
      await page.setViewportSize({ width: 900, height: 700 });
      await page.waitForTimeout(100);
      const after = await panel();
      assert.deepEqual(
        { width: after.width, height: after.height },
        { width: resized.width, height: resized.height },
      );
    });
  });

  test(`${name}: the live panel masks the part of the region it covers`, async () => {
    await withPage(browserType, name, { width: 800, height: 600 }, async (page) => {
      await page.setContent(`<body style="margin:0"></body>`);
      await page.addScriptTag({
        type: "module",
        content: `${panelCode}
          ${uiSetup}
          window.panel = showLivePanel(container, { x: 10, y: 10, width: 780, height: 580 }, {
            onPause() {}, onResume() {}, onSelectNewRegion() {}, onRetry() {}, onClose() {},
          });
        `,
      });
      await page.waitForFunction(() => Boolean(window.panel));
      await settle(page);
      const panel = await box(page, ".ocr-translate-live");
      const [mask] = await page.evaluate(() => window.panel.getMask());

      // No room beside a region this large, so the panel covers part of it.
      assert.ok(mask);
      assert.ok(mask.x <= panel.x && mask.y <= panel.y);
      assert.ok(mask.x + mask.width >= panel.x + panel.width);
      assert.ok(mask.y + mask.height >= panel.y + panel.height);

      // Dragging it moves the panel and the mask with it.
      const grip = { x: panel.x + 60, y: panel.y + 14 };
      await page.mouse.move(grip.x, grip.y);
      await page.mouse.down();
      await page.mouse.move(grip.x + 120, grip.y + 150, { steps: 5 });
      await page.mouse.up();
      const moved = await box(page, ".ocr-translate-live");
      const where = JSON.stringify({ panel, moved });
      assert.ok(Math.abs(moved.x - (panel.x + 120)) <= 1, where);
      assert.ok(Math.abs(moved.y - (panel.y + 150)) <= 1, where);
      const [movedMask] = await page.evaluate(() => window.panel.getMask());
      assert.ok(movedMask.x <= moved.x && movedMask.y <= moved.y);

      // It cannot be dragged out of the viewport.
      await page.mouse.move(moved.x + 60, moved.y + 14);
      await page.mouse.down();
      await page.mouse.move(-500, -500, { steps: 5 });
      await page.mouse.up();
      const clamped = await box(page, ".ocr-translate-live");
      assert.ok(clamped.x >= 0 && clamped.y >= 0);
    });
  });

  test(`${name}: live selection ignores images and uses its own labels`, async () => {
    await withPage(browserType, name, { width: 800, height: 600 }, async (page) => {
      await page.setContent(`
        <body style="margin:0">
          <img src="${svg}" style="position:absolute; left:100px; top:150px; width:300px; height:200px">
        </body>
      `);
      await page.addScriptTag({
        type: "module",
        content: `${selectionCode}
          ${uiSetup}
          window.start = () => {
            window.selection = "pending";
            startSelectionOverlay(container, true, {
              pickImages: false,
              hint: "LIVE HINT",
              confirmLabel: "LIVE START",
            }).then((result) => { window.selection = result; });
          };
        `,
      });
      await page.waitForFunction(() => Boolean(window.start));
      await page.evaluate(() => window.start());
      await page.locator(".ocr-translate-selection-overlay").waitFor();

      assert.match(await page.locator(".ocr-translate-selection-hint").textContent(), /^LIVE HINT/);

      // Over the image: no image highlight, and a click does not pick it.
      await page.mouse.move(250, 250);
      assert.equal(await page.locator(".ocr-translate-image-picker-frame").isHidden(), true);
      await page.mouse.down();
      await page.mouse.move(380, 330, { steps: 5 });
      await page.mouse.up();

      const confirm = page.locator(".ocr-translate-selection-run");
      assert.equal(await confirm.textContent(), "LIVE START");
      await confirm.click();
      await page.waitForFunction(() => window.selection !== "pending");
      const selection = await page.evaluate(() => window.selection);
      assert.equal(selection.kind, "area");
      assert.deepEqual(selection.rect, { x: 250, y: 250, width: 130, height: 80 });
    });
  });

  test(`${name}: the UI follows a full screen container and returns afterwards`, async (context) => {
    await withPage(browserType, name, { width: 800, height: 600 }, async (page) => {
      await page.setContent(`
        <body style="margin:0">
          <div id="stage" style="position:absolute; left:50px; top:50px; width:400px; height:300px; background:#468">
            <video id="video" style="width:100%; height:100%"></video>
          </div>
          <button id="fullscreen-stage" onclick="document.getElementById('stage').requestFullscreen()">stage</button>
          <button id="fullscreen-video" onclick="document.getElementById('video').requestFullscreen()">video</button>
        </body>
      `);
      await page.addScriptTag({
        type: "module",
        content: `${modalCode}
          ${uiSetup}
          // A small spot at the centre, so the buttons stay clickable.
          const marker = document.createElement("div");
          marker.style.cssText =
            "position:fixed; left:370px; top:270px; width:60px; height:60px; background:#f0f";
          container.append(marker);
          window.stop = watchFullscreen(host);
          window.parentOf = () => host.parentElement.id || host.parentElement.tagName;
          window.uiIsOnTop = () => document.elementFromPoint(400, 300) === host;
        `,
      });
      await page.waitForFunction(() => Boolean(window.stop));
      const parent = () => page.evaluate(() => window.parentOf());
      const onTop = () => page.evaluate(() => window.uiIsOnTop());

      await page.click("#fullscreen-stage");
      try {
        await page.waitForFunction(() => document.fullscreenElement?.id === "stage", null, { timeout: 5000 });
      } catch {
        context.skip(`${name} does not enter full screen in this environment`);
        return;
      }
      // The move happens when the page's fullscreenchange event fires.
      await page.waitForFunction(() => window.parentOf() === "stage");
      assert.equal(await onTop(), true);

      await page.evaluate(() => document.exitFullscreen());
      await page.waitForFunction(() => !document.fullscreenElement);
      await page.waitForFunction(() => window.parentOf() === "BODY");
      assert.equal(await onTop(), true);

      // A video draws only its own picture, so the UI stays where it was.
      await page.click("#fullscreen-video");
      await page.waitForFunction(() => document.fullscreenElement?.id === "video");
      await page.waitForTimeout(300);
      assert.equal(await parent(), "BODY");
    });
  });
}
