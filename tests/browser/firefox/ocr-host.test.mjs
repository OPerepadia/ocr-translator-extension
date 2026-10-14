import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { Builder, By, Origin } from "selenium-webdriver";
import * as firefox from "selenium-webdriver/firefox.js";

test("initializes the Firefox OCR host and recognizes data URLs and iframe blobs", {
  timeout: 120_000,
}, async () => {
  const extensionPath = resolve(".output/firefox-mv3");
  const manifest = JSON.parse(
    await readFile(resolve(extensionPath, "manifest.json"), "utf8"),
  );
  const extensionId = manifest.browser_specific_settings.gecko.id;
  const extensionUuid = extensionId.slice(1, -1);
  const extensionUrl = `moz-extension://${extensionUuid}/popup.html`;
  const options = new firefox.Options()
    .addArguments("-headless")
    .setPreference(
      "extensions.webextensions.uuids",
      JSON.stringify({ [extensionId]: extensionUuid }),
    );
  if (process.env.FIREFOX_BIN) {
    options.setBinary(process.env.FIREFOX_BIN);
  }
  process.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = "1";

  const driver = await new Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(options)
    .build();

  try {
    await driver.manage().setTimeouts({
      pageLoad: 30_000,
      script: 90_000,
    });
    await driver.installAddon(extensionPath, true);
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

    const result = await driver.executeAsyncScript(function () {
      const done = arguments[arguments.length - 1];
      void (async () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = 400;
          canvas.height = 192;
          const drawing = canvas.getContext("2d");
          if (!drawing) {
            throw new Error("Canvas 2D is unavailable.");
          }
          const runOcrCase = async ({
            lines,
            fontSize,
            sourceLang,
            targetLang,
            requestId,
          }) => {
            drawing.fillStyle = "white";
            drawing.fillRect(0, 0, canvas.width, canvas.height);
            drawing.fillStyle = "black";
            drawing.font = `bold ${fontSize}px sans-serif`;
            drawing.textBaseline = "middle";
            drawing.fillText(lines[0], 16, 48);
            drawing.fillText(lines[1], 16, 144);

            await browser.storage.local.set({
              settings: {
                ocr: { providerId: "paddle", sourceLang },
                translation: {
                  providerId: "google",
                  targetLang,
                  llm: { baseUrl: "http://localhost:8080/v1" },
                },
              },
            });
            return browser.runtime.sendMessage({
              type: "OCR_TRANSLATE_REQUEST",
              requestId,
              imageUrl: canvas.toDataURL("image/png"),
            });
          };

          const response = await runOcrCase({
            lines: ["SAMPLE LINE", "SECOND LINE"],
            fontSize: 52,
            sourceLang: "en",
            targetLang: "en",
            requestId: "firefox-browser-smoke-test",
          });
          const autoResponse = await runOcrCase({
            lines: ["ПРОСТИЙ ТЕКСТ", "ДРУГИЙ РЯДОК"],
            fontSize: 44,
            sourceLang: "auto",
            targetLang: "uk",
            requestId: "firefox-script-classifier-test",
          });
          done({ response, autoResponse });
        } catch (error) {
          done({ error: error instanceof Error ? error.message : String(error) });
        }
      })();
    });

    assert.equal(result.error, undefined);
    assert.equal(
      result.response.ok,
      true,
      result.response.error?.message ?? "The OCR request failed.",
    );
    const ocr = result.response.value?.ocr;
    assert.equal(ocr?.imageHeight, 192);
    assert.equal(ocr?.imageWidth, 400);
    assert.equal(ocr?.providerMeta?.modelId, "v6-multi");
    assert.equal(
      ocr?.providerMeta?.grouping?.modelId,
      "comic-text-bubble-rtdetr-v4-s-int8",
    );
    assert.equal(ocr?.providerMeta?.grouping?.backend, "wasm");
    assert.ok(ocr?.blocks?.length >= 2);
    assert.match(ocr?.text ?? "", /sample/i);
    assert.ok(ocr?.providerMeta?.grouping?.groupCount > 0);

    assert.equal(
      result.autoResponse.ok,
      true,
      result.autoResponse.error?.message ?? "The auto OCR request failed.",
    );
    const autoOcr = result.autoResponse.value?.ocr;
    assert.equal(autoOcr?.providerMeta?.modelId, "cyrillic-v5");
    assert.equal(
      autoOcr?.providerMeta?.autoSelection?.method,
      "script-classifier",
    );
    assert.equal(
      autoOcr?.providerMeta?.autoSelection?.scriptDetection?.script,
      "cyrillic",
    );
    assert.ok(autoOcr?.blocks?.length >= 2);
    await checkBlobImageInFrame(driver);
  } finally {
    await driver.quit();
  }
});

async function checkBlobImageInFrame(driver) {
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(request.url === "/frame"
      ? '<!doctype html><img id="sample" style="position:absolute;left:12vw;top:12vh;width:40vw;height:36vh">'
      // A cross-origin frame, so Firefox runs it in a process of its own.
      : `<!doctype html><body style="background:blue"><iframe src="http://localhost:${server.address().port}/frame" style="position:fixed;left:60vw;top:45vh;width:36vw;height:50vh;border:0"></iframe>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    await driver.manage().window().setRect({ width: 1280, height: 1000 });
    await driver.executeAsyncScript(function () {
      const done = arguments[arguments.length - 1];
      browser.storage.local.set({
        uiLocale: "en",
        displayMode: "panel",
        settings: {
          ocr: { providerId: "paddle", sourceLang: "en" },
          translation: { providerId: "google", targetLang: "en" },
        },
      }).then(done);
    });
    const control = await driver.getWindowHandle();
    await driver.switchTo().newWindow("tab");
    const page = await driver.getWindowHandle();
    await driver.get(url);
    await driver.switchTo().frame(await driver.findElement(By.css("iframe")));
    await driver.executeAsyncScript(function () {
      const done = arguments[arguments.length - 1];
      const canvas = document.createElement("canvas");
      canvas.width = 600;
      canvas.height = 400;
      const drawing = canvas.getContext("2d");
      drawing.fillStyle = "white";
      drawing.fillRect(0, 0, 600, 400);
      drawing.fillStyle = "black";
      drawing.font = "bold 80px sans-serif";
      drawing.fillText("SAMPLE", 60, 150);
      drawing.fillText("TEXT", 60, 310);
      canvas.toBlob((blob) => {
        const image = document.querySelector("#sample");
        image.onload = () => done();
        image.src = URL.createObjectURL(blob);
      });
    });

    const imageBounds = await driver.executeScript(() =>
      document.querySelector("#sample").getBoundingClientRect().toJSON(),
    );
    await driver.switchTo().defaultContent();
    const frameBounds = await driver.executeScript(() =>
      document.querySelector("iframe").getBoundingClientRect().toJSON(),
    );

    await driver.switchTo().window(control);
    const started = await driver.executeAsyncScript(function (url) {
      const done = arguments[arguments.length - 1];
      browser.tabs.query({}).then((tabs) => {
        const tab = tabs.find((tab) => tab.url === url);
        return browser.tabs.sendMessage(
          tab.id,
          { type: "START_SELECTION" },
          { frameId: 0 },
        );
      }).then(() => done(true), (error) => done(String(error)));
    }, url);
    assert.equal(started, true);
    await driver.switchTo().window(page);
    await driver.wait(async () => driver.executeScript(() =>
      Boolean(document.querySelector("ocr-translate-ui")?.shadowRoot.querySelector(".ocr-translate-selection-overlay")),
    ), 10_000);
    // Firefox hit-tests against the last painted frame.
    await driver.executeAsyncScript(function () {
      const done = arguments[arguments.length - 1];
      requestAnimationFrame(() => requestAnimationFrame(done));
    });
    // Region selection covers the page, so the top frame asks the iframe
    // for the image under the pointer.
    const point = {
      x: Math.round(frameBounds.x + imageBounds.x + imageBounds.width / 2),
      y: Math.round(frameBounds.y + imageBounds.y + imageBounds.height / 2),
    };
    await driver.actions().move({ ...point, origin: Origin.VIEWPORT }).perform();
    await driver.wait(async () => driver.executeScript(() => {
      const outline = document.querySelector("ocr-translate-ui")?.shadowRoot
        .querySelector(".ocr-translate-image-picker-frame");
      return Boolean(outline && !outline.hidden);
    }), 10_000, "The iframe image should be outlined");
    await driver.actions().click().perform();
    await driver.switchTo().frame(await driver.findElement(By.css("iframe")));
    await driver.wait(async () => {
      const text = await driver.executeScript(() =>
        document.querySelector("ocr-translate-ui")?.shadowRoot.querySelector("textarea")?.value,
      );
      return /SAMPLE\s+TEXT/.test(text ?? "");
    }, 30_000, "The iframe blob should be recognized as SAMPLE TEXT");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
