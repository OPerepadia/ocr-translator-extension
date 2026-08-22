import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { Builder } from "selenium-webdriver";
import * as firefox from "selenium-webdriver/firefox.js";

test("initializes the Firefox OCR host and runs local recognition", {
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
          drawing.fillStyle = "white";
          drawing.fillRect(0, 0, canvas.width, canvas.height);
          drawing.fillStyle = "black";
          drawing.font = "bold 52px sans-serif";
          drawing.textBaseline = "middle";
          drawing.fillText("SAMPLE LINE", 16, 48);
          drawing.fillText("SECOND LINE", 16, 144);

          await browser.storage.local.set({
            settings: {
              ocr: { providerId: "paddle", sourceLang: "en" },
              translation: {
                providerId: "google",
                targetLang: "en",
                llm: { baseUrl: "http://localhost:8080/v1" },
              },
            },
          });
          const response = await browser.runtime.sendMessage({
            type: "OCR_TRANSLATE_REQUEST",
            requestId: "firefox-browser-smoke-test",
            imageUrl: canvas.toDataURL("image/png"),
          });
          done({ response });
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
    assert.equal(ocr?.providerMeta?.grouping?.confidenceThreshold, 0.4);
    assert.equal(ocr?.providerMeta?.grouping?.nmsIouThreshold, 0.25);
    assert.ok(ocr?.blocks?.length >= 2);
    assert.match(ocr?.text ?? "", /sample/i);
    assert.ok(ocr?.providerMeta?.grouping?.groupCount > 0);
  } finally {
    await driver.quit();
  }
});
