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
      blocks?: Array<{
        text?: string;
        paragraph?: number;
        bbox: { x: number; y: number; width: number; height: number };
      }>;
      imageHeight?: number;
      imageWidth?: number;
      providerMeta?: {
        modelId?: string;
        grouping?: {
          modelId?: string;
          backend?: string;
          confidenceThreshold?: number;
          nmsIouThreshold?: number;
          regionCount?: number;
          matchedLineCount?: number;
          groupCount?: number;
        };
      };
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
      imageHeight: 192,
      imageWidth: 400,
      providerMeta: {
        modelId: "v6-multi",
        grouping: {
          modelId: "comic-text-bubble-rtdetr-v4-s-int8",
          backend: "wasm",
          confidenceThreshold: 0.4,
          nmsIouThreshold: 0.25,
        },
      },
    });
    expect(response.value?.ocr?.blocks?.length).toBeGreaterThanOrEqual(2);
    expect(response.value?.ocr?.text).toMatch(/sample/i);
    expect(
      response.value?.ocr?.providerMeta?.grouping?.groupCount,
    ).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test("reports a fallback WebGPU adapter as software-only", async () => {
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
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: {
        requestAdapter: async () => ({ info: { isFallbackAdapter: true } }),
      },
    });
  });

  try {
    const serviceWorker = await findServiceWorker(context);
    const extensionId = new URL(serviceWorker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    const status = page.locator(".ocr-webgpu-status");
    await expect(status).toHaveText("Software only");
    await expect(status).toHaveClass(/is-software/);
    await expect(page.locator("input[name='ocrWebGpu']")).toBeDisabled();
    const guide = page.locator(".ocr-webgpu-note");
    await expect(guide).toBeVisible();
    await expect(guide.locator("a")).toHaveAttribute(
      "href",
      "https://github.com/OPerepadia/ocr-translator-extension#webgpu-setup",
    );
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
