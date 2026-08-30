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
        autoSelection?: {
          method?: string;
          decisive?: boolean;
          scriptDetection?: {
            script?: string;
            probeCount?: number;
          };
        };
      };
      text?: string;
    };
  };
  error?: { message?: string };
}

interface OcrCase {
  lines: [string, string];
  targetLang: string;
  requestId: string;
  width: number;
  fontSize: number;
  script: string;
  modelId: string;
  rtl?: boolean;
}

test("initializes the offscreen OCR host and runs local recognition", async () => {
  const context = await launchExtensionContext();

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

    const ocrCases: OcrCase[] = [
      {
        lines: ["SAMPLE LINE", "SECOND LINE"],
        targetLang: "en",
        requestId: "browser-smoke-test",
        width: 400,
        fontSize: 52,
        script: "general",
        modelId: "v6-multi",
      },
      {
        lines: ["ПРОСТИЙ ТЕКСТ", "ДРУГИЙ РЯДОК"],
        targetLang: "uk",
        requestId: "script-smoke-test-0",
        width: 500,
        fontSize: 56,
        script: "cyrillic",
        modelId: "cyrillic-v5",
      },
      {
        lines: ["نص بسيط", "سطر آخر"],
        targetLang: "ar",
        requestId: "script-smoke-test-1",
        width: 500,
        fontSize: 56,
        script: "arabic",
        modelId: "arabic-v5",
        rtl: true,
      },
      {
        lines: ["सरल पाठ", "दूसरी पंक्ति"],
        targetLang: "hi",
        requestId: "script-smoke-test-2",
        width: 500,
        fontSize: 56,
        script: "devanagari",
        modelId: "devanagari-v5",
      },
      {
        lines: ["간단한 글", "둘째 줄"],
        targetLang: "ko",
        requestId: "script-smoke-test-3",
        width: 500,
        fontSize: 56,
        script: "hangul",
        modelId: "korean-v5",
      },
    ];
    const [response, ...scriptResponses] = (await page.evaluate(async (cases) => {
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

      const runOcrCase = async (testCase: OcrCase): Promise<unknown> => {
        const canvas = document.createElement("canvas");
        canvas.width = testCase.width;
        canvas.height = 192;
        const drawing = canvas.getContext("2d");
        if (!drawing) {
          throw new Error("Canvas 2D is unavailable.");
        }
        drawing.fillStyle = "white";
        drawing.fillRect(0, 0, canvas.width, canvas.height);
        drawing.fillStyle = "black";
        drawing.font = `bold ${testCase.fontSize}px sans-serif`;
        drawing.textBaseline = "middle";
        drawing.textAlign = testCase.rtl ? "right" : "left";
        drawing.direction = testCase.rtl ? "rtl" : "ltr";
        const x = testCase.rtl ? canvas.width - 16 : 16;
        drawing.fillText(testCase.lines[0], x, 48);
        drawing.fillText(testCase.lines[1], x, 144);

        await extensionApi.storage.local.set({
          settings: {
            ocr: { providerId: "paddle", sourceLang: "auto" },
            translation: {
              providerId: "google",
              targetLang: testCase.targetLang,
              llm: { baseUrl: "http://localhost:8080/v1" },
            },
          },
        });
        return extensionApi.runtime.sendMessage({
          type: "OCR_TRANSLATE_REQUEST",
          requestId: testCase.requestId,
          imageUrl: canvas.toDataURL("image/png"),
        });
      };

      const responses = [];
      for (const testCase of cases) {
        responses.push(await runOcrCase(testCase));
      }
      return responses;
    }, ocrCases)) as OcrResponse[];

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
        autoSelection: {
          method: "script-classifier",
          decisive: true,
          scriptDetection: {
            script: "general",
            probeCount: 2,
          },
        },
      },
    });
    expect(response.value?.ocr?.blocks?.length).toBeGreaterThanOrEqual(2);
    expect(response.value?.ocr?.text).toMatch(/sample/i);
    expect(
      response.value?.ocr?.providerMeta?.grouping?.groupCount,
    ).toBeGreaterThan(0);

    for (const [index, scriptCase] of ocrCases.slice(1).entries()) {
      const scriptResponse = scriptResponses[index];
      expect(scriptResponse.ok).toBe(true);
      expect(scriptResponse.value?.ocr?.providerMeta).toMatchObject({
        modelId: scriptCase.modelId,
        autoSelection: {
          method: "script-classifier",
          decisive: true,
          scriptDetection: { script: scriptCase.script, probeCount: 2 },
        },
      });
    }
  } finally {
    await context.close();
  }
});

test("reports a fallback WebGPU adapter as software-only", async () => {
  const context = await launchExtensionContext();
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

function launchExtensionContext(): Promise<BrowserContext> {
  const extensionPath = resolve(".output/chrome-mv3");
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  return chromium.launchPersistentContext("", {
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
}

async function findServiceWorker(context: BrowserContext) {
  return (
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"))
  );
}
