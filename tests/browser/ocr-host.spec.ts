import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { resolve } from "node:path";

interface OcrResponse {
  ok: boolean;
  value?: {
    ocr?: {
      blocks?: unknown[];
      imageHeight?: number;
      imageWidth?: number;
      providerMeta?: { modelId?: string };
      text?: string;
    };
  };
  error?: { message?: string };
}

test("initializes the offscreen OCR host and runs local recognition", async () => {
  const extensionPath = resolve(".output/chrome-mv3");
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const context = await chromium.launchPersistentContext("", {
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  const pageErrors: string[] = [];
  const watchPage = (page: Page): void => {
    page.on("pageerror", (error) => pageErrors.push(error.message));
  };
  context.pages().forEach(watchPage);
  context.on("page", watchPage);

  try {
    const serviceWorker = await findServiceWorker(context);
    const extensionId = new URL(serviceWorker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    const response = (await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 96;
      const drawing = canvas.getContext("2d");
      if (!drawing) {
        throw new Error("Canvas 2D is unavailable.");
      }
      drawing.fillStyle = "white";
      drawing.fillRect(0, 0, canvas.width, canvas.height);
      drawing.fillStyle = "black";
      drawing.font = "bold 64px sans-serif";
      drawing.textBaseline = "middle";
      drawing.fillText("HELLO", 16, canvas.height / 2);

      const extensionApi = (
        globalThis as typeof globalThis & {
          chrome: {
            runtime: {
              sendMessage(message: unknown): Promise<unknown>;
            };
            storage: {
              local: {
                set(values: Record<string, unknown>): Promise<void>;
              };
            };
          };
        }
      ).chrome;
      await extensionApi.storage.local.set({
        settings: {
          ocr: { providerId: "paddle", sourceLang: "en" },
          translation: {
            providerId: "google",
            targetLang: "en",
            llm: { baseUrl: "http://localhost:8080/v1" },
          },
        },
      });
      return extensionApi.runtime.sendMessage({
        type: "OCR_TRANSLATE_REQUEST",
        requestId: "browser-smoke-test",
        imageUrl: canvas.toDataURL("image/png"),
      });
    })) as OcrResponse;

    if (!response.ok) {
      throw new Error(response.error?.message ?? "The OCR request failed.");
    }
    expect(pageErrors).toEqual([]);
    expect(response.value?.ocr).toMatchObject({
      imageHeight: 96,
      imageWidth: 320,
      providerMeta: { modelId: "v6-multi" },
    });
    expect(response.value?.ocr?.blocks).not.toHaveLength(0);
    expect(response.value?.ocr?.text).toMatch(/hello/i);
  } finally {
    await context.close();
  }
});

async function findServiceWorker(context: BrowserContext) {
  return (
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"))
  );
}
