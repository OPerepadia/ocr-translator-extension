import { chromium, expect, test } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

// Correcting recognized text in the overlay translates it again and puts the
// correction on the text over the image.

declare const chrome: typeof import("wxt/browser").browser;

// A local translator that keeps the text it was sent.
async function startTranslator() {
  const received: string[][] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const { segments } = JSON.parse(JSON.parse(body).messages.at(-1).content) as {
      segments: Array<{ id: number; text: string }>;
    };
    received.push(segments.map(({ text }) => text));
    const translations = segments.map(({ id, text }) => ({ id, text: `<${text}>` }));
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ translations }) } }],
      }),
    );
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  return { received, server, baseUrl: `http://127.0.0.1:${port}/v1` };
}

test("corrects recognized text in the overlay", async () => {
  const extensionPath = resolve(".output/chrome-mv3");
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const translator = await startTranslator();
  const context = await chromium.launchPersistentContext("", {
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    headless: true,
    viewport: { width: 1000, height: 800 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    const worker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await worker.evaluate(
      (baseUrl) =>
        chrome.storage.local.set({
          uiLocale: "en",
          displayMode: "overlay",
          settings: {
            ocr: { providerId: "paddle", sourceLang: "en" },
            translation: {
              providerId: "openai",
              targetLang: "uk",
              llm: { baseUrl, model: "test" },
            },
          },
        }),
      translator.baseUrl,
    );

    const page = await context.newPage();
    const imageUrl = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 700;
      canvas.height = 500;
      const drawing = canvas.getContext("2d")!;
      drawing.fillStyle = "white";
      drawing.fillRect(0, 0, 700, 500);
      drawing.fillStyle = "black";
      drawing.font = "bold 64px sans-serif";
      drawing.fillText("SAMPLE", 60, 110);
      drawing.fillText("OTHER", 60, 430);
      return canvas.toDataURL("image/png");
    });
    await context.route("https://example.test/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><body style="margin:0"><img src="${imageUrl}"
          style="display:block; margin:80px 0 0 100px">`,
      }),
    );
    await page.goto("https://example.test/");
    await expect
      .poll(() =>
        worker.evaluate(async (imageUrl) => {
          const [tab] = await chrome.tabs.query({ url: "https://example.test/*" });
          try {
            await chrome.tabs.sendMessage(tab.id!, {
              type: "START_IMAGE_TRANSLATION",
              imageUrl,
            });
            return true;
          } catch {
            return false;
          }
        }, imageUrl),
      )
      .toBe(true);

    const cards = page.locator(".ocr-translate-overlay-translation-box");
    const frames = page.locator(".ocr-translate-overlay-frame-box");
    const popover = page.locator(".ocr-translate-overlay-popover");
    const editor = popover.getByRole("textbox", { name: "Source text" });
    const toggle = page.locator(".ocr-translate-overlay-mode-button");
    await expect(cards).toHaveText(["<SAMPLE>", "<OTHER>"], { timeout: 60_000 });
    expect(translator.received).toEqual([["SAMPLE", "OTHER"]]);

    // The editor shows the image instead of the card over it.
    await cards.first().hover();
    await popover.getByRole("button", { name: "Edit recognized text" }).click();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("SAMPLE");
    await expect(popover.getByRole("heading")).toHaveText("Edit recognized text");
    await expect(cards.first()).toBeHidden();
    await expect(frames.first()).toBeVisible();
    await expect(frames.first()).toHaveClass(/is-active/);
    await expect(toggle).toBeDisabled();
    // Only the edited block is marked, even when another one is hovered.
    const unmarked = "rgba(0, 0, 0, 0)";
    await expect(frames.first()).not.toHaveCSS("border-top-color", unmarked);
    await frames.nth(1).hover();
    await expect(frames.nth(1)).toHaveCSS("border-top-color", unmarked);
    await expect(frames.nth(1)).toHaveCSS("background-color", unmarked);

    // Escape and Shift act on the editor, not on the overlay.
    await editor.press("Shift");
    await expect(cards.first()).toBeHidden();
    await editor.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(popover).toBeVisible();
    await expect(cards.first()).toBeVisible();
    await expect(toggle).toBeEnabled();
    expect(translator.received).toHaveLength(1);

    await popover.getByRole("button", { name: "Edit recognized text" }).click();
    await editor.fill("EXAMPLE");
    await popover.getByRole("button", { name: "Save" }).click();
    await expect(cards).toHaveText(["<EXAMPLE>", "<OTHER>"]);
    await expect(cards.first()).toBeVisible();
    expect(translator.received.slice(1)).toEqual([["EXAMPLE", "OTHER"]]);

    // The correction is on the selectable text and stays for the next edit.
    await toggle.click();
    await expect(frames.nth(1)).not.toHaveCSS("border-top-color", unmarked);
    await expect(frames.first().locator(".ocr-translate-overlay-text-layer")).toHaveText(
      "EXAMPLE",
    );
    await expect(
      frames.nth(1).locator(".ocr-translate-overlay-text-layer"),
    ).toHaveText("OTHER");
    await frames.nth(1).hover();
    await popover.getByRole("button", { name: "Edit recognized text" }).click();
    await editor.fill("ANOTHER");
    await popover.getByRole("button", { name: "Save" }).click();
    await expect(cards).toHaveText(["<EXAMPLE>", "<ANOTHER>"]);
    expect(translator.received.slice(2)).toEqual([["EXAMPLE", "ANOTHER"]]);
    // The view that was open stays open.
    await expect(frames.first()).toBeVisible();
    await expect(cards.first()).toBeHidden();

    // The panel has the corrections too.
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("menuitem", { name: "Show in panel" }).click();
    await expect(page.getByRole("textbox", { name: "Source text" })).toHaveValue(
      "EXAMPLE\nANOTHER",
    );
  } finally {
    await context.close();
    translator.server.closeAllConnections();
    translator.server.close();
  }
});
