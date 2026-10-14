import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { Builder } from "selenium-webdriver";
import * as firefox from "selenium-webdriver/firefox.js";

// Live translation reads a video from its own frames, so the panel can cover
// the subtitles. This runs the built extension against a page with a real video
// element, which plays a canvas that draws burned-in subtitles. A local server
// stands in for the translation endpoint and answers "[uk] <text>".

const SUBTITLE_REGION = { x1: 190, y1: 470, x2: 1090, y2: 590 };

// The video is 1000 by 560, drawn at the same size on the page. Something is
// always moving behind the subtitles, as in a real video.
const VIDEO_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #111; }
  #stage { position: absolute; left: 140px; top: 40px; width: 1000px; height: 560px; background: #000; }
  #video { position: absolute; inset: 0; width: 100%; height: 100%; }
</style></head><body>
<div id="stage"><video id="video" muted playsinline></video></div>
<script>
  const canvas = document.createElement("canvas");
  canvas.width = 1000;
  canvas.height = 560;
  const context = canvas.getContext("2d");
  let lines = [];

  function draw() {
    const offset = ((Date.now() % 6000) / 6000) * canvas.width * 3;
    const gradient = context.createLinearGradient(-offset, 0, canvas.width * 4 - offset, 0);
    gradient.addColorStop(0, "#1d3557");
    gradient.addColorStop(0.33, "#457b9d");
    gradient.addColorStop(0.66, "#e63946");
    gradient.addColorStop(1, "#1d3557");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.textAlign = "center";
    context.font = "bold 34px sans-serif";
    context.lineJoin = "round";
    context.lineWidth = 6;
    lines.forEach((line, index) => {
      const y = canvas.height - 36 - (lines.length - 1 - index) * 42.5;
      context.strokeStyle = "#000";
      context.strokeText(line, canvas.width / 2, y);
      context.fillStyle = "#fff";
      context.fillText(line, canvas.width / 2, y);
    });
  }

  window.setSubtitle = (next) => { lines = next; };
  draw();
  setInterval(draw, 40);
  const video = document.getElementById("video");
  video.srcObject = canvas.captureStream(25);
  video.play();
</script></body></html>`;

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  return { server, port: server.address().port };
}

// An OpenAI-compatible endpoint that translates every segment to "[uk] text".
async function startTranslationServer() {
  const requests = [];
  const { server, port } = await listen((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const payload = JSON.parse(body);
      const { segments } = JSON.parse(payload.messages.at(-1).content);
      for (const segment of segments) {
        requests.push(segment.text);
      }
      const translations = segments.map(({ id, text }) => ({ id, text: `[uk] ${text}` }));
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ translations }) } }],
        }),
      );
    });
  });
  return { server, port, requests };
}

async function startPageServer() {
  const { server, port } = await listen((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(VIDEO_PAGE);
  });
  return { server, port };
}

test("reads the subtitles of a video from under the panel", {
  timeout: 240_000,
}, async () => {
  const extensionPath = resolve(".output/firefox-mv3");
  const manifest = JSON.parse(
    await readFile(resolve(extensionPath, "manifest.json"), "utf8"),
  );
  const extensionId = manifest.browser_specific_settings.gecko.id;
  const extensionUuid = extensionId.slice(1, -1);
  const extensionUrl = `moz-extension://${extensionUuid}/popup.html`;
  const options = new firefox.Options()
    .addArguments("-headless", "-width=1280", "-height=720")
    .setPreference(
      "extensions.webextensions.uuids",
      JSON.stringify({ [extensionId]: extensionUuid }),
    )
    .setPreference("media.autoplay.default", 0)
    .setPreference("media.volume_scale", "0.0");
  if (process.env.FIREFOX_BIN) {
    options.setBinary(process.env.FIREFOX_BIN);
  }
  process.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = "1";

  const translation = await startTranslationServer();
  const page = await startPageServer();
  const pageUrl = `http://127.0.0.1:${page.port}/`;
  const driver = await new Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(options)
    .build();

  const inPage = (script, ...args) => driver.executeScript(script, ...args);
  const shadowText = (selector) =>
    inPage(
      (selector) =>
        document
          .querySelector("ocr-translate-ui")
          ?.shadowRoot?.querySelector(selector)?.textContent ?? null,
      selector,
    );
  // The text of the newest line in the panel.
  const latestTranslation = () =>
    inPage(() => {
      const lines = document
        .querySelector("ocr-translate-ui")
        ?.shadowRoot?.querySelectorAll(".ocr-translate-live-translation");
      return lines?.length ? lines[lines.length - 1].textContent : null;
    });
  const waitForTranslation = async (expected, timeout = 120_000) => {
    const deadline = Date.now() + timeout;
    let shown = null;
    while (Date.now() < deadline) {
      shown = await latestTranslation();
      if (shown === expected) {
        return;
      }
      await new Promise((done) => setTimeout(done, 500));
    }
    assert.equal(shown, expected);
  };

  try {
    await driver.manage().setTimeouts({ pageLoad: 30_000, script: 90_000 });
    await driver.installAddon(extensionPath, true);

    // A temporary install is not granted its host permissions, as an install
    // from the add-on store is. Without them the content script does not run.
    await driver.setContext(firefox.Context.CHROME);
    await driver.executeAsyncScript(function (id) {
      const done = arguments[arguments.length - 1];
      void (async () => {
        const { ExtensionPermissions } = ChromeUtils.importESModule(
          "resource://gre/modules/ExtensionPermissions.sys.mjs",
        );
        const { extension } = WebExtensionPolicy.getByID(id);
        await ExtensionPermissions.add(
          id,
          { permissions: [], origins: ["<all_urls>"] },
          extension,
        );
        done();
      })();
    }, extensionId);
    await driver.setContext(firefox.Context.CONTENT);

    await driver.get(pageUrl);
    const pageTab = await driver.getWindowHandle();
    // Let the content script finish starting.
    await new Promise((done) => setTimeout(done, 1000));

    // Settings, and the command that starts live translation, come from an
    // extension page, as the popup would send them.
    await driver.switchTo().newWindow("tab");
    await driver.setContext(firefox.Context.CHROME);
    await driver.executeScript(function (url) {
      gBrowser.selectedBrowser.loadURI(Services.io.newURI(url), {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
    }, extensionUrl);
    await driver.setContext(firefox.Context.CONTENT);
    await driver.wait(
      async () => (await driver.getCurrentUrl()) === extensionUrl,
      10_000,
    );
    const started = await driver.executeAsyncScript(
      function (port, pageUrl) {
        const done = arguments[arguments.length - 1];
        void (async () => {
          try {
            await browser.storage.local.set({
              settings: {
                ocr: { providerId: "paddle", sourceLang: "en" },
                translation: {
                  providerId: "openai",
                  targetLang: "uk",
                  llm: { baseUrl: `http://127.0.0.1:${port}/v1`, model: "test" },
                },
              },
            });
            // A match pattern cannot take the port of the page server.
            const tabs = await browser.tabs.query({});
            const tab = tabs.find((candidate) => candidate.url?.startsWith(pageUrl));
            await browser.tabs.sendMessage(
              tab.id,
              { type: "START_LIVE_SELECTION" },
              { frameId: 0 },
            );
            done({ ok: true });
          } catch (error) {
            done({ error: error instanceof Error ? error.message : String(error) });
          }
        })();
      },
      translation.port,
      pageUrl,
    );
    assert.equal(started.error, undefined);

    // Back on the page, select the area with the subtitles.
    await driver.switchTo().window(pageTab);
    await driver.wait(
      async () =>
        inPage(
          () =>
            Boolean(
              document
                .querySelector("ocr-translate-ui")
                ?.shadowRoot?.querySelector(".ocr-translate-selection-overlay"),
            ),
        ),
      10_000,
    );
    const { x1, y1, x2, y2 } = SUBTITLE_REGION;
    await driver
      .actions({ async: true })
      .move({ x: x1, y: y1, origin: "viewport" })
      .press()
      .move({ x: x2, y: y2, origin: "viewport", duration: 300 })
      .release()
      .perform();
    await driver.wait(
      async () => (await shadowText(".ocr-translate-live-title")) !== null,
      10_000,
    );

    // Cover the selected region with the panel.
    const drag = await inPage(() => {
      const shadow = document.querySelector("ocr-translate-ui").shadowRoot;
      const title = shadow.querySelector(".ocr-translate-live-title").getBoundingClientRect();
      const panel = shadow.querySelector(".ocr-translate-live").getBoundingClientRect();
      const region = shadow.querySelector(".ocr-translate-live-region").getBoundingClientRect();
      return {
        x: Math.round(title.x + title.width / 2),
        y: Math.round(title.y + title.height / 2),
        dx: Math.round(region.x + region.width / 2 - (panel.x + panel.width / 2)),
        dy: Math.round(region.y + region.height / 2 - (panel.y + panel.height / 2)),
      };
    });
    await driver
      .actions({ async: true })
      .move({ x: drag.x, y: drag.y, origin: "viewport" })
      .press()
      .move({ x: drag.x + drag.dx, y: drag.y + drag.dy, origin: "viewport", duration: 300 })
      .release()
      .perform();
    // Where the subtitle is drawn, the panel is on top now.
    assert.equal(
      await inPage(() => {
        const region = document.querySelector("ocr-translate-ui").shadowRoot
          .querySelector(".ocr-translate-live-region").getBoundingClientRect();
        return document.elementFromPoint(region.x + region.width / 2, region.y + region.height / 2)?.localName;
      }),
      "ocr-translate-ui",
    );

    await inPage(() => window.setSubtitle(["The weather is nice today."]));
    await waitForTranslation("[uk] The weather is nice today.");

    await inPage(() => window.setSubtitle(["See you tomorrow."]));
    await waitForTranslation("[uk] See you tomorrow.");
    assert.deepEqual(translation.requests, [
      "The weather is nice today.",
      "See you tomorrow.",
    ]);
  } finally {
    await driver.quit();
    translation.server.close();
    page.server.close();
  }
});
