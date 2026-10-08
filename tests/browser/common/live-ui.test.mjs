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

const panelStubs = [
  "const languageName = (code: string) => `Language ${code}`;",
  "const LIVE_TEXT_SCALES = [1];",
];
const panelCode = await compile(
  ["icons.ts", "live-layout.ts", "live-panel.ts"],
  "live-panel",
  panelStubs,
);
const fullscreenPanelCode = await compile(
  ["icons.ts", "live-layout.ts", "live-panel.ts", "modal-ui.ts"],
  "live-panel-fullscreen",
  panelStubs,
);
const selectionCode = await compile(["image-picker.ts", "selection-overlay.ts"], "selection");
const modalCode = await compile(["modal-ui.ts"], "modal-ui");
const regionCode = await compile(
  ["image-picker.ts", "overlay-layout.ts", "live-region.ts"],
  "live-region",
);

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
              onTextScaleChange() {},
            }, 1);
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
      assert.equal(await page.evaluate(() => window.panel.getMask()), undefined);
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

      await page.locator(".ocr-translate-live-actions > button").nth(0).click();
      assert.equal(await original.isVisible(), true);
      assert.equal(await text(".ocr-translate-live-original"), "Hello there");
      // The original sits above the translation.
      const shownOriginal = await box(page, ".ocr-translate-live-original");
      const shownTranslation = await box(page, ".ocr-translate-live-translation");
      assert.ok(shownOriginal.y + shownOriginal.height <= shownTranslation.y);

      // While the translation is on its way, the original waits above a note.
      await render(onScreen({ original: "Hello there", state: "pending" }));
      assert.equal(await original.isVisible(), true);
      assert.equal(await text(".ocr-translate-live-original"), "Hello there");
      assert.equal(await page.locator(".ocr-translate-live-translation").isVisible(), false);
      assert.equal(await text(".ocr-translate-live-waiting"), "statusTranslating");

      // With the original hidden, the line shows what was read in grey.
      await page.locator(".ocr-translate-live-actions > button").nth(0).click();
      assert.equal(await page.locator(".ocr-translate-live-waiting").isVisible(), false);
      assert.equal(await text(".ocr-translate-live-translation"), "Hello there");
      await page.locator(".ocr-translate-live-actions > button").nth(0).click();
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
      await page.locator(".ocr-translate-live-actions > button").nth(1).click();
      await render({ status: "paused", lines: [] });
      assert.equal(await text(".ocr-translate-live-note"), "");
      await page.locator(".ocr-translate-live-actions > button").nth(1).click();

      await render({ status: "error", lines: [], error: "worker crashed" });
      assert.equal(await text(".ocr-translate-live-note"), "worker crashed");
      assert.equal(await page.locator(".ocr-translate-live-actions > button").nth(1).isDisabled(), true);
      await page.locator(".ocr-translate-live-retry").click();

      await page.locator(".ocr-translate-live-actions > button").nth(2).click();
      await page.locator(".ocr-translate-live-actions > button").nth(3).click();
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
            onTextScaleChange() {},
          }, 1);
          const lineAt = (number) => ({
            original: "Line " + number,
            translation: "Translated line " + number,
            state: "ready",
          });
          // "tail" replaces the newest lines. Reports whether the newest line
          // fades right after drawing.
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
              faded: views[views.length - 1].getAnimations().some(
                (animation) => animation.animationName === "ocr-translate-live-line-in"
              ),
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
      const listBottom = await list.evaluate((element) => element.getBoundingClientRect().bottom);
      const bottomPadding = await list.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).paddingBottom)
      );
      const lastBox = await lines.last().boundingBox();
      assert.ok(near(listBottom - (lastBox.y + lastBox.height), bottomPadding));
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
      assert.equal(unwatched.faded, true);
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

      // At the end, it follows the newest line as it fades in.
      const following = await showLines(22);
      assert.equal(following.faded, true);
      assert.equal(await atEnd(), true);
      assert.equal(await translationOf(lines.last()), "Translated line 22");

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

      // Text already in the target language shows as it is, with no note.
      await showLines(24, {
        tail: [
          { original: "Line 23", state: "same-language" },
          { original: "Line 24", state: "same-language" },
        ],
      });
      assert.equal(await translationOf(lines.last()), "Line 24");
      assert.equal(await translationOf(lines.nth(22)), "Line 23");
      assert.equal(await page.locator(".ocr-translate-live-line-note:visible").count(), 0);

      // A line waiting for its translation is as tall as a translated one, so
      // the lines above it stay put when the translation comes.
      await showLines(25, { tail: [{ original: "Line 25", state: "pending" }] });
      const pendingY = (await lines.nth(23).boundingBox()).y;
      const ready = await showLines(25);
      assert.ok(near((await lines.nth(23).boundingBox()).y, pendingY));
      assert.equal(ready.faded, false);

      // A taller translation pushes the lines above it up without reanimating
      // the existing line.
      const long = "Translated line 25 ".repeat(12);
      const tall = await showLines(25, {
        tail: [{ original: "Line 25", translation: long, state: "ready" }],
      });
      assert.equal(tall.faded, false);
      assert.equal(await atEnd(), true);

      await page.emulateMedia({ reducedMotion: "reduce" });
      const reduced = await showLines(26);
      assert.equal(reduced.faded, false);
      assert.equal(await atEnd(), true);

      await showLines(27, {
        tail: [{ original: "Line 27", state: "failed", error: "FailureCode".repeat(40) }],
      });
      assert.equal(await list.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
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
            onTextScaleChange() {},
          }, 1);
          window.minSize = { width: PANEL_MIN_WIDTH, height: PANEL_MIN_HEIGHT };
        `,
      });
      await page.waitForFunction(() => Boolean(window.panel));
      await settle(page);
      const panel = () => box(page, ".ocr-translate-live");
      // Pointer positions stay inside the viewport: Firefox reports odd
      // coordinates for synthetic moves outside it.
      const dragGripTo = async (toX, toY) => {
        const grip = await box(page, ".ocr-translate-live-resize.is-se");
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
        await page.mouse.down();
        await page.mouse.move(toX, toY, { steps: 5 });
        await page.mouse.up();
      };
      const dragGrip = async (dx, dy) => {
        const grip = await box(page, ".ocr-translate-live-resize.is-se");
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
        await page.evaluate(() => window.minSize),
      );

      // Even at that size the buttons and the languages fit in the title bar,
      // and the long pair gives way before the buttons do.
      await page.evaluate(() =>
        window.panel.render({ status: "running", lines: [], sourceLang: "zh-cn", targetLang: "uk" }),
      );
      const bar = await box(page, ".ocr-translate-live-topbar");
      const close = await box(page, ".ocr-translate-live-actions > button:last-child");
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
            onTextScaleChange() {},
          }, 1);
        `,
      });
      await page.waitForFunction(() => Boolean(window.panel));
      await settle(page);
      const panel = await box(page, ".ocr-translate-live");
      const mask = await page.evaluate(() => window.panel.getMask());

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
      const movedMask = await page.evaluate(() => window.panel.getMask());
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

  test(`${name}: the live frame and panel go where the region moves`, async () => {
    await withPage(browserType, name, { width: 800, height: 600 }, async (page) => {
      await page.setContent(`<body style="margin:0"></body>`);
      await page.addScriptTag({
        type: "module",
        content: `${panelCode}
          ${uiSetup}
          window.panel = showLivePanel(container, { x: 100, y: 100, width: 600, height: 80 }, {
            onPause() {}, onResume() {}, onSelectNewRegion() {}, onRetry() {}, onClose() {},
            onTextScaleChange() {},
          }, 1);
        `,
      });
      await page.waitForFunction(() => Boolean(window.panel));
      await settle(page);
      const move = (region) => page.evaluate((region) => window.panel.moveRegion(region), region);
      const frame = () => box(page, ".ocr-translate-live-region");
      const panel = () => box(page, ".ocr-translate-live");
      const settledFrame = page.locator(".ocr-translate-live-region.is-settled");

      // The frame fades back after a while, and shows in full again once the
      // region moves.
      await settledFrame.waitFor({ timeout: 5000 });
      await move({ x: 50, y: 300, width: 400, height: 60 });
      assert.equal(await settledFrame.count(), 0);
      assert.deepEqual(await frame(), { x: 46, y: 296, width: 408, height: 68 });
      assert.ok((await panel()).y >= 360 + 12);
      assert.equal(await page.evaluate(() => window.panel.getMask()), undefined);

      // Scrolled out of view, the region leaves the panel at the nearest edge.
      await move({ x: 100, y: -300, width: 600, height: 80 });
      assert.equal((await panel()).y, 8);
      await move({ x: 100, y: 900, width: 600, height: 80 });
      const below = await panel();
      assert.equal(below.y + below.height, 600 - 8);

      // A panel the user moved stays put, and the frame still follows.
      await move({ x: 100, y: 100, width: 600, height: 80 });
      const start = await panel();
      await page.mouse.move(start.x + 60, start.y + 14);
      await page.mouse.down();
      await page.mouse.move(start.x + 60, start.y + 114, { steps: 5 });
      await page.mouse.up();
      const placed = await panel();
      await move({ x: 150, y: 50, width: 400, height: 60 });
      assert.deepEqual(await panel(), placed);
      assert.deepEqual(await frame(), { x: 146, y: 46, width: 408, height: 68 });

      await settledFrame.waitFor({ timeout: 5000 });
    });
  });

  test(`${name}: the live panel keeps its place in the lines in and out of full screen`, async (context) => {
    await withPage(browserType, name, { width: 800, height: 600 }, async (page) => {
      await page.setContent(`
        <body style="margin:0">
          <div id="stage" style="position:absolute; left:50px; top:50px; width:600px; height:300px; background:#468"></div>
          <button id="fullscreen" style="position:absolute; left:700px; top:10px"
            onclick="document.getElementById('stage').requestFullscreen()">full screen</button>
        </body>
      `);
      await page.addScriptTag({
        type: "module",
        content: `${fullscreenPanelCode}
          ${uiSetup}
          window.host = host;
          watchFullscreen(host);
          window.panel = showLivePanel(container, { x: 100, y: 150, width: 500, height: 60 }, {
            onPause() {}, onResume() {}, onSelectNewRegion() {}, onRetry() {}, onClose() {},
            onTextScaleChange() {},
          }, 1);
          window.showLines = (count) => {
            const lines = Array.from({ length: count }, (_, index) => ({
              original: "Line " + index,
              translation: "Hello " + index,
              state: "ready",
            }));
            window.panel.render({ status: "running", lines, line: lines.at(-1) });
          };
        `,
      });
      await page.waitForFunction(() => Boolean(window.panel));
      await settle(page);
      const list = page.locator(".ocr-translate-live-lines");
      const scrollTop = () => list.evaluate((element) => element.scrollTop);
      const atEnd = () =>
        list.evaluate(
          (element) => element.scrollTop >= element.scrollHeight - element.clientHeight - 1,
        );
      const latestButton = page.locator(".ocr-translate-live-latest.is-visible");

      // Enough lines that the list scrolls, with the newest in view.
      await page.evaluate(() => window.showLines(12));
      assert.ok((await scrollTop()) > 0);
      assert.equal(await atEnd(), true);

      await page.click("#fullscreen");
      try {
        await page.waitForFunction(() => document.fullscreenElement?.id === "stage", null, { timeout: 5000 });
      } catch {
        context.skip(`${name} does not enter full screen in this environment`);
        return;
      }
      await page.waitForFunction(() => window.host.parentElement.id === "stage");
      // The newest line stays in view, and so does the next one.
      assert.equal(await atEnd(), true);
      await page.evaluate(() => window.showLines(13));
      assert.equal(await atEnd(), true);
      assert.equal(await latestButton.count(), 0);

      // Lines the user scrolled up to read stay where they are.
      await list.evaluate((element) => {
        element.scrollTop = 40;
      });
      await page.evaluate(() => document.exitFullscreen());
      await page.waitForFunction(() => window.host.parentElement === document.body);
      // Firefox scrolls by fractions of a pixel.
      const isAt40 = async () => Math.abs((await scrollTop()) - 40) < 1;
      assert.equal(await isAt40(), true);
      await page.evaluate(() => window.showLines(14));
      assert.equal(await isAt40(), true);
      assert.equal(await latestButton.count(), 1);
    });
  });

  test(`${name}: a live region keeps to the picture it was selected on`, async (context) => {
    await withPage(browserType, name, { width: 800, height: 600 }, async (page) => {
      await page.setContent(`
        <body style="margin:0; height:2000px">
          <div id="stage" style="position:absolute; left:calc(50vw - 300px); top:50px; width:400px; height:300px">
            <video id="video" style="display:block; width:100%; height:100%"></video>
            <div style="position:absolute; left:0; right:0; bottom:10px; height:50px"></div>
          </div>
          <canvas id="game" width="160" height="90"
            style="position:absolute; left:550px; top:50px; width:200px; height:200px; object-fit:contain"></canvas>
          <p style="position:absolute; left:100px; top:400px; width:400px; height:100px">Hello there</p>
          <button id="fullscreen" onclick="document.getElementById('stage').requestFullscreen()">full screen</button>
        </body>
      `);
      await page.addScriptTag({
        type: "module",
        content: `${regionCode}
          ${uiSetup}
          window.follow = (rect) => {
            const moves = [];
            const region = followRegion(rect, host, (moved) => moves.push(moved));
            return { moves, measure: () => region.measure(), dispose: () => region.dispose() };
          };
          window.regions = {
            video: follow({ x: 150, y: 260, width: 300, height: 60 }),
            game: follow({ x: 560, y: 180, width: 180, height: 20 }),
            text: follow({ x: 120, y: 410, width: 300, height: 60 }),
          };
        `,
      });
      await page.waitForFunction(() => Boolean(window.regions));
      const measure = (name) => page.evaluate((name) => window.regions[name].measure(), name);
      // Waits for the region to report a move to `expected`, as it does on its
      // own when the page changes.
      const movesTo = (name, expected) =>
        page.waitForFunction(
          ([name, expected]) => {
            const last = window.regions[name].moves.at(-1);
            return (
              last &&
              ["x", "y", "width", "height"].every((key) => Math.abs(last[key] - expected[key]) < 0.5)
            );
          },
          [name, expected],
          { timeout: 5000 },
        );

      // A wider window moves the player, and the region goes with it.
      await page.setViewportSize({ width: 1000, height: 600 });
      await movesTo("video", { x: 250, y: 260, width: 300, height: 60 });

      // So does a larger player, in proportion.
      await page.evaluate(() => {
        Object.assign(document.getElementById("stage").style, { width: "800px", height: "600px" });
      });
      await movesTo("video", { x: 300, y: 470, width: 600, height: 120 });

      await page.evaluate(() => window.scrollTo(0, 100));
      await movesTo("video", { x: 300, y: 370, width: 600, height: 120 });

      // A picture drawn smaller than its element keeps its shape. The region
      // stays on the picture, which sits lower in a taller element.
      await page.evaluate(() => {
        document.getElementById("game").style.height = "300px";
      });
      await movesTo("game", { x: 560, y: 130, width: 180, height: 20 });

      // A region over anything else stays where it was selected.
      assert.deepEqual(await measure("text"), { x: 120, y: 410, width: 300, height: 60 });

      await page.evaluate(() => {
        window.scrollTo(0, 0);
        Object.assign(document.getElementById("stage").style, { width: "400px", height: "300px" });
      });
      await movesTo("video", { x: 250, y: 260, width: 300, height: 60 });
      await page.click("#fullscreen");
      try {
        await page.waitForFunction(() => document.fullscreenElement?.id === "stage", null, { timeout: 5000 });
      } catch {
        context.skip(`${name} does not enter full screen in this environment`);
        return;
      }
      const screen = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      await movesTo("video", {
        x: screen.width * 0.125,
        y: screen.height * 0.7,
        width: screen.width * 0.75,
        height: screen.height * 0.2,
      });
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
