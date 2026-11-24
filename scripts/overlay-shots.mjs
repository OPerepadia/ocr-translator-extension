#!/usr/bin/env node
// Runs the built extension over images and saves a screenshot of the translation
// overlay and the state of its cards. A local server stands in for the
// translator and answers with filler text, so nothing is sent out.
//
// Compare two builds by running each and passing the first result as --base:
//
//   npm run build:chrome
//   node scripts/overlay-shots.mjs path/to/images -o .output/shots/before
//   # change the code
//   npm run build:chrome
//   node scripts/overlay-shots.mjs path/to/images -o .output/shots/after --base .output/shots/before
//
// The output folder gets a PNG per image and results.json. With --base it also
// gets compare/, with the changed images side by side (needs ImageMagick).
// Do not use test-results/: Playwright empties it.

import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const USAGE = `Usage: node scripts/overlay-shots.mjs <images or folders> [options]
  -o, --out DIR        output folder (default .output/shots/latest)
  -b, --base DIR       earlier output folder to compare with
      --browser NAME   chrome or firefox (default chrome)
      --ext DIR        extension build (default the one in .output)
      --model NAME     paddle or paddle-manga (default paddle)
      --width PX       displayed image width (default 800)
      --length N       filler letters per CJK character (default 1.8)
      --text TEXT      use this translation for every paragraph instead
      --target LANG    target language (default de)`;

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", short: "o", default: ".output/shots/latest" },
    base: { type: "string", short: "b" },
    browser: { type: "string", default: "chrome" },
    ext: { type: "string" },
    model: { type: "string", default: "paddle" },
    width: { type: "string", default: "800" },
    length: { type: "string", default: "1.8" },
    text: { type: "string" },
    target: { type: "string", default: "de" },
    help: { type: "boolean", short: "h" },
  },
});
if (options.help || positionals.length === 0 || !["chrome", "firefox"].includes(options.browser)) {
  console.log(USAGE);
  process.exit(options.help ? 0 : 1);
}

const TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const RESULT_TIMEOUT_MS = 60_000;
const width = Number(options.width);
const out = resolve(options.out);
const extension = resolve(options.ext ?? `.output/${options.browser}-mv3`);

async function findImages(path, root = path) {
  if ((await stat(path)).isDirectory()) {
    const names = (await readdir(path)).sort();
    return (await Promise.all(names.map((name) => findImages(join(path, name), root)))).flat();
  }
  const name = path === root ? basename(path) : relative(root, path).split(sep).join("-");
  return TYPES[extname(path).toLowerCase()] ? [{ path, name }] : [];
}

const FILLER = "the sample line shows how a plain translated text would look on this card when it is placed over some other words".split(" ");

function translate(text) {
  if (options.text) {
    return options.text;
  }
  const isCjk = /[　-鿿가-힯＀-￯]/;
  const length = [...text].reduce(
    (sum, char) => sum + (isCjk.test(char) ? Number(options.length) : 1), 0);
  const words = [];
  for (let at = text.length; words.join(" ").length < length; at++) {
    words.push(FILLER[at % FILLER.length]);
  }
  return words.join(" ");
}

// Serves the page, its image and an OpenAI-compatible translation endpoint.
async function startServer() {
  const state = { image: undefined };
  const server = createServer(async (request, response) => {
    if (request.url.startsWith("/v1")) {
      let body = "";
      for await (const chunk of request) body += chunk;
      const { segments } = JSON.parse(JSON.parse(body).messages.at(-1).content);
      const translations = segments.map(({ id, text }) => ({ id, text: translate(text) }));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ translations }) } }],
      }));
    } else if (request.url.startsWith("/image")) {
      response.setHeader("content-type", TYPES[extname(state.image).toLowerCase()]);
      response.setHeader("cache-control", "no-store");
      response.end(await readFile(state.image));
    } else {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><body style="margin:0;background:#888">
        <img src="/image" style="display:block;width:${width}px">`);
    }
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  return { state, server, url: `http://127.0.0.1:${server.address().port}/` };
}

// Functions below run in the browser.

function readCards() {
  const overlay = document.querySelector("ocr-translate-ui")?.shadowRoot;
  const rect = (element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return [x, y, width, height].map(Math.round);
  };
  return {
    ready: Boolean(overlay?.querySelector(".ocr-translate-overlay-snapshot")),
    cards: [...(overlay?.querySelectorAll(".ocr-translate-overlay-translation-box") ?? [])].map(
      (box) => ({
        text: box.textContent,
        box: rect(box),
        panel: rect(box.firstElementChild),
        font: box.style.fontSize,
        background: box.style.getPropertyValue("--ocr-text-background"),
        vertical: box.firstElementChild.classList.contains("is-vertical-source"),
        extended: box.classList.contains("is-extended"),
        truncated: Boolean(box.querySelector(".ocr-translate-overlay-truncation-marker")),
      }),
    ),
  };
}

// Works for both engines: each API returns promises in MV3.
async function setUp({ model, target, baseUrl }) {
  await (globalThis.browser ?? chrome).storage.local.set({
    uiLocale: "en",
    displayMode: "overlay",
    settings: {
      ocr: { providerId: model, sourceLang: "auto" },
      translation: { providerId: "openai", targetLang: target, llm: { baseUrl, model: "test" } },
    },
  });
}

async function startTranslation(url) {
  const { tabs } = globalThis.browser ?? chrome;
  const tab = (await tabs.query({})).find((candidate) => candidate.url?.startsWith(url));
  await tabs.sendMessage(
    tab.id,
    { type: "START_IMAGE_TRANSLATION", imageUrl: `${url}image` },
    { frameId: 0 },
  );
}

async function launchChrome() {
  const { chromium } = await import("@playwright/test");
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const context = await chromium.launchPersistentContext("", {
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    headless: true,
    viewport: { width: width + 100, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  const page = await context.newPage();
  return {
    inExtension: (fn, arg) => extensionPage.evaluate(fn, arg),
    inPage: (fn) => page.evaluate(fn),
    open: (url) => page.goto(url, { waitUntil: "load" }),
    resize: (height) => page.setViewportSize({ width: width + 100, height }),
    screenshot: (path) => page.screenshot({ path }),
    close: () => context.close(),
  };
}

async function launchFirefox() {
  const { Builder } = await import("selenium-webdriver");
  const firefox = await import("selenium-webdriver/firefox.js");
  const manifest = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8"));
  const id = manifest.browser_specific_settings.gecko.id;
  const uuid = id.slice(1, -1);
  const browserOptions = new firefox.Options()
    .addArguments("-headless")
    .setPreference("extensions.webextensions.uuids", JSON.stringify({ [id]: uuid }));
  if (process.env.FIREFOX_BIN) {
    browserOptions.setBinary(process.env.FIREFOX_BIN);
  }
  process.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = "1";
  const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(browserOptions).build();
  await driver.manage().setTimeouts({ pageLoad: 30_000, script: 90_000 });
  await driver.installAddon(extension, true);
  // A temporary install is not granted its host permissions.
  await driver.setContext(firefox.Context.CHROME);
  await driver.executeAsyncScript(function (id) {
    const done = arguments[arguments.length - 1];
    const { ExtensionPermissions } = ChromeUtils.importESModule(
      "resource://gre/modules/ExtensionPermissions.sys.mjs",
    );
    const { extension } = WebExtensionPolicy.getByID(id);
    ExtensionPermissions.add(id, { permissions: [], origins: ["<all_urls>"] }, extension).then(done);
  }, id);
  await driver.setContext(firefox.Context.CONTENT);
  const pageTab = await driver.getWindowHandle();
  await driver.switchTo().newWindow("tab");
  const extensionTab = await driver.getWindowHandle();
  const extensionUrl = `moz-extension://${uuid}/popup.html`;
  await driver.setContext(firefox.Context.CHROME);
  await driver.executeScript(function (url) {
    gBrowser.selectedBrowser.loadURI(Services.io.newURI(url), {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  }, extensionUrl);
  await driver.setContext(firefox.Context.CONTENT);
  await driver.wait(async () => (await driver.getCurrentUrl()) === extensionUrl, 10_000);
  await driver.switchTo().window(pageTab);
  return {
    async inExtension(fn, arg) {
      await driver.switchTo().window(extensionTab);
      const error = await driver.executeAsyncScript(
        `const done = arguments[arguments.length - 1];
        (${fn})(arguments[0]).then(() => done(null), (error) => done(String(error)));`,
        arg,
      );
      await driver.switchTo().window(pageTab);
      if (error) throw new Error(error);
    },
    inPage: (fn) => driver.executeScript(fn),
    open: (url) => driver.get(url),
    // The window is taller than the page by the browser's own bars.
    resize: (height) => driver.manage().window().setRect({ width: width + 100, height: height + 100 }),
    screenshot: async (path) => writeFile(path, Buffer.from(await driver.takeScreenshot(), "base64")),
    close: () => driver.quit(),
  };
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function shoot(browser, { state, url }, image) {
  state.image = image.path;
  await browser.open(url);
  const height = await browser.inPage(() =>
    Math.ceil(document.querySelector("img").getBoundingClientRect().height));
  await browser.resize(Math.max(600, height));
  // Let the content script finish starting.
  await pause(500);
  await browser.inExtension(startTranslation, url);
  const deadline = Date.now() + RESULT_TIMEOUT_MS;
  while ((await browser.inPage(readCards)).cards.length === 0) {
    if (Date.now() > deadline) {
      throw new Error("no translation cards");
    }
    await pause(250);
  }
  // The snapshot sets the card colors and may come a little later.
  for (let i = 0; i < 12 && !(await browser.inPage(readCards)).ready; i++) {
    await pause(250);
  }
  await pause(400);
  await browser.screenshot(join(out, `${image.name}.png`));
  return (await browser.inPage(readCards)).cards;
}

// How many cards reach over the text of another one, past its padding.
function countOverlaps(cards) {
  const depth = (a, b) =>
    Math.min(...[0, 1].map((i) =>
      Math.min(a[i] + a[i + 2], b[i] + b[i + 2]) - Math.max(a[i], b[i])));
  return cards.filter((card) =>
    cards.some((other) => other !== card && depth(card.box, other.panel) > 5)).length;
}

function summarize(cards) {
  return {
    cards: cards.length,
    vertical: cards.filter((card) => card.vertical).length,
    extended: cards.filter((card) => card.extended).length,
    truncated: cards.filter((card) => card.truncated).length,
    overlapping: countOverlaps(cards),
  };
}

function total(summaries) {
  return summaries.reduce((sum, next) =>
    Object.fromEntries(Object.keys(next).map((key) => [key, (sum[key] ?? 0) + next[key]])), {});
}

async function compare(results) {
  const base = resolve(options.base);
  const before = JSON.parse(await readFile(join(base, "results.json"), "utf8"));
  const names = Object.keys(results).filter((name) => before[name]);
  const changed = [];
  for (const name of names) {
    const [a, b] = await Promise.all(
      [base, out].map((folder) => readFile(join(folder, `${name}.png`))));
    if (!a.equals(b)) changed.push(name);
  }
  await mkdir(join(out, "compare"), { recursive: true });
  for (const name of changed) {
    const [a, b] = [summarize(before[name]), summarize(results[name])];
    const diff = Object.keys(a)
      .filter((key) => a[key] !== b[key])
      .map((key) => `${key} ${a[key]} -> ${b[key]}`);
    console.log(`changed: ${name}  ${diff.join(", ")}`);
    try {
      execFileSync("magick", [
        join(base, `${name}.png`), join(out, `${name}.png`),
        "+append", join(out, "compare", `${name}.png`),
      ]);
    } catch (error) {
      console.log(`  no side-by-side image: ${error.message.split("\n")[0]}`);
    }
  }
  console.log(`\n${changed.length} of ${names.length} images changed`);
  console.table({
    before: total(names.map((name) => summarize(before[name]))),
    after: total(names.map((name) => summarize(results[name]))),
  });
}

const images = (await Promise.all(positionals.map((path) => findImages(resolve(path))))).flat();
await mkdir(out, { recursive: true });
const server = await startServer();
const browser = await (options.browser === "firefox" ? launchFirefox() : launchChrome());
const results = {};
const failed = [];
try {
  await browser.inExtension(setUp, {
    model: options.model,
    target: options.target,
    baseUrl: `${server.url}v1`,
  });
  for (const [index, image] of images.entries()) {
    try {
      results[image.name] = await shoot(browser, server, image);
      console.log(`${index + 1}/${images.length} ${image.name}`, summarize(results[image.name]));
    } catch (error) {
      failed.push(image.name);
      console.log(`${index + 1}/${images.length} ${image.name} FAILED: ${error.message.split("\n")[0]}`);
    }
  }
} finally {
  await browser.close();
  server.server.closeAllConnections();
  server.server.close();
}
await writeFile(join(out, "results.json"), JSON.stringify(results, null, 1));
if (options.base) {
  await compare(results);
} else {
  console.table({ total: total(Object.values(results).map(summarize)) });
}
if (failed.length > 0) {
  console.log(`Failed: ${failed.join(", ")}`);
}
