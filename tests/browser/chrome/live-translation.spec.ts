import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from "@playwright/test";
import { createServer } from "node:http";
import { resolve } from "node:path";

// Live translation reads the real screen, so these run the built extension
// against a page that stands in for a video with burned-in subtitles. A local
// server stands in for the translation endpoint and answers "[uk] <text>".

declare const chrome: {
  tabs: {
    query(query: { url: string }): Promise<Array<{ id: number }>>;
    sendMessage(
      tabId: number,
      message: unknown,
      options?: { frameId: number },
    ): Promise<unknown>;
    captureVisibleTab(...args: unknown[]): Promise<string>;
  };
  storage: { local: { set(values: Record<string, unknown>): Promise<void> } };
};

type Counter = { __captures?: number };

const PAGE_URL = "http://live.test/";
const SUBTITLE_REGION = { x1: 190, y1: 470, x2: 1090, y2: 590 };

const SUBTITLE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #111; font-family: sans-serif; }
  #stage { position: absolute; left: 140px; top: 40px; width: 1000px; height: 560px; background: #000; }
  #video { position: absolute; inset: 0; overflow: hidden;
    background: linear-gradient(120deg, #1d3557, #457b9d, #e63946, #1d3557);
    background-size: 400% 400%; animation: move 6s linear infinite; }
  @keyframes move { 0% { background-position: 0% 50%; } 100% { background-position: 100% 50%; } }
  #subtitle { position: absolute; left: 0; right: 0; bottom: 36px; padding: 0 40px; text-align: center;
    color: #fff; font-size: 34px; font-weight: 700; line-height: 1.25;
    text-shadow: -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000; }
</style></head><body>
<button id="fullscreen" style="position:absolute;left:1180px;top:10px"
  onclick="document.getElementById('stage').requestFullscreen()">Fullscreen</button>
<div id="stage"><div id="video"><div id="subtitle"></div></div></div>
<script>
  window.setSubtitle = (lines) => {
    document.getElementById("subtitle").innerHTML =
      lines.map((line) => "<div>" + line + "</div>").join("");
  };
</script></body></html>`;

interface TranslationServer {
  port: number;
  /** Every text the extension asked to translate. */
  requests: string[];
  close(): void;
}

async function startTranslationServer(): Promise<TranslationServer> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const payload = JSON.parse(body) as { messages: Array<{ content: string }> };
      const { segments } = JSON.parse(payload.messages.at(-1)!.content) as {
        segments: Array<{ id: number; text: string }>;
      };
      requests.push(...segments.map((segment) => segment.text));
      const translations = segments.map(({ id, text }) => ({
        id,
        text: `[uk] ${text}`,
      }));
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ translations }) } }],
        }),
      );
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The translation server did not start.");
  }
  return { port: address.port, requests, close: () => server.close() };
}

interface Session {
  context: BrowserContext;
  worker: Worker;
  server: TranslationServer;
  page: Page;
}

async function openSession(): Promise<Session> {
  const extensionPath = resolve(".output/chrome-mv3");
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const context = await chromium.launchPersistentContext("", {
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    headless: true,
    viewport: { width: 1280, height: 720 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  const server = await startTranslationServer();

  const worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/popup.html`);
  await settings.evaluate(
    (port) =>
      chrome.storage.local.set({
        settings: {
          ocr: { providerId: "paddle", sourceLang: "en" },
          translation: {
            providerId: "openai",
            targetLang: "uk",
            llm: { baseUrl: `http://127.0.0.1:${port}/v1`, model: "test" },
          },
        },
      }),
    server.port,
  );
  await settings.close();

  const page = await context.newPage();
  await page.route(`${PAGE_URL}**`, (route) =>
    route.fulfill({ contentType: "text/html", body: SUBTITLE_PAGE }),
  );
  await page.goto(PAGE_URL);
  await page.bringToFront();
  // Let the content script finish starting.
  await page.waitForTimeout(500);
  return { context, worker, server, page };
}

async function startLiveTranslation(
  { page, worker }: Pick<Session, "page" | "worker">,
  region = SUBTITLE_REGION,
): Promise<void> {
  await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.tabs.sendMessage(tab.id, { type: "START_LIVE_SELECTION" }, { frameId: 0 });
  }, `${PAGE_URL}*`);
  await page.locator(".ocr-translate-selection-overlay").waitFor();
  await page.mouse.move(region.x1, region.y1);
  await page.mouse.down();
  await page.mouse.move(region.x2, region.y2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".ocr-translate-live")).toBeVisible();
}

function showSubtitle(page: Page, ...lines: string[]): Promise<void> {
  return page.evaluate(
    (text) => (window as unknown as { setSubtitle(lines: string[]): void }).setSubtitle(text),
    lines,
  );
}

/** Counts the screenshots the background takes from now on. */
function countCaptures(worker: Worker): Promise<void> {
  return worker.evaluate(() => {
    const counter = globalThis as Counter;
    counter.__captures = 0;
    const capture = chrome.tabs.captureVisibleTab.bind(chrome.tabs);
    chrome.tabs.captureVisibleTab = (...args) => {
      counter.__captures = (counter.__captures ?? 0) + 1;
      return capture(...args);
    };
  });
}

const capturesSoFar = (worker: Worker): Promise<number> =>
  worker.evaluate(() => (globalThis as Counter).__captures ?? 0);

const translation = (page: Page) =>
  page.locator(".ocr-translate-live-translation");

async function overlaps(page: Page, first: string, second: string): Promise<boolean> {
  const a = await page.locator(first).boundingBox();
  const b = await page.locator(second).boundingBox();
  if (!a || !b) {
    throw new Error("Both elements must be on screen.");
  }
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

test("translates the subtitles in a region and reuses earlier translations", async () => {
  const session = await openSession();
  const { page, server } = session;
  try {
    await startLiveTranslation(session);

    await showSubtitle(page, "The weather is nice today.");
    await expect(translation(page)).toHaveText("[uk] The weather is nice today.", {
      timeout: 20_000,
    });
    // The panel stays out of the pixels it reads.
    expect(await overlaps(page, ".ocr-translate-live", ".ocr-translate-live-region")).toBe(false);

    await showSubtitle(page);
    await expect(translation(page)).toHaveText("", { timeout: 10_000 });

    await showSubtitle(
      page,
      "We should walk to the market",
      "before it starts to rain.",
    );
    await expect(translation(page)).toHaveText(
      "[uk] We should walk to the market before it starts to rain.",
      { timeout: 10_000 },
    );

    await showSubtitle(page);
    await expect(translation(page)).toHaveText("", { timeout: 10_000 });
    await showSubtitle(page, "The weather is nice today.");
    await expect(translation(page)).toHaveText("[uk] The weather is nice today.", {
      timeout: 10_000,
    });

    // The first line came back without another request.
    expect(server.requests).toEqual([
      "The weather is nice today.",
      "We should walk to the market before it starts to rain.",
    ]);
  } finally {
    await session.context.close();
    server.close();
  }
});

test("does not read its own panel when the panel covers the region", async () => {
  const session = await openSession();
  const { page, server } = session;
  try {
    // A region this large leaves the panel nowhere else to go. It stops short
    // of the page's own button, which would be read as well.
    await startLiveTranslation(session, { x1: 10, y1: 50, x2: 1170, y2: 710 });
    expect(await overlaps(page, ".ocr-translate-live", ".ocr-translate-live-region")).toBe(true);

    await showSubtitle(page, "See you tomorrow.");
    await expect(translation(page)).toHaveText("[uk] See you tomorrow.", {
      timeout: 20_000,
    });
    // Long enough for several more reads of the panel's own text.
    await page.waitForTimeout(4_000);

    expect(server.requests).toEqual(["See you tomorrow."]);
  } finally {
    await session.context.close();
    server.close();
  }
});

test("pauses reading while the tab is in the background", async () => {
  const session = await openSession();
  const { context, page, worker, server } = session;
  try {
    await startLiveTranslation(session);
    await showSubtitle(page, "Where did you put the keys?");
    await expect(translation(page)).toHaveText("[uk] Where did you put the keys?", {
      timeout: 20_000,
    });

    const other = await context.newPage();
    await other.route("http://other.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>Another page</h1>" }),
    );
    await other.goto("http://other.test/");
    await other.bringToFront();
    await other.waitForTimeout(1_000);

    await countCaptures(worker);
    await other.waitForTimeout(4_000);
    expect(await capturesSoFar(worker)).toBe(0);

    await page.bringToFront();
    await expect.poll(() => capturesSoFar(worker), { timeout: 10_000 }).toBeGreaterThan(0);
  } finally {
    await context.close();
    server.close();
  }
});

test("pauses, resumes and closes from the panel", async () => {
  const session = await openSession();
  const { page, worker, server } = session;
  try {
    await startLiveTranslation(session);
    await showSubtitle(page, "The weather is nice today.");
    await expect(translation(page)).toHaveText("[uk] The weather is nice today.", {
      timeout: 20_000,
    });
    const [showOriginal, pause, , close] = await page
      .locator(".ocr-translate-live-actions button")
      .all();

    await showOriginal.click();
    await expect(page.locator(".ocr-translate-live-original")).toHaveText(
      "The weather is nice today.",
    );

    await countCaptures(worker);
    await pause.click();
    await expect(page.locator(".ocr-translate-live-note")).toHaveText("Paused");
    await page.waitForTimeout(3_000);
    expect(await capturesSoFar(worker)).toBe(0);

    await pause.click();
    await expect.poll(() => capturesSoFar(worker), { timeout: 10_000 }).toBeGreaterThan(0);

    await close.click();
    await expect(page.locator(".ocr-translate-live")).toHaveCount(0);
    await expect(page.locator(".ocr-translate-live-region")).toHaveCount(0);
    const afterClose = await capturesSoFar(worker);
    await page.waitForTimeout(3_000);
    expect(await capturesSoFar(worker)).toBe(afterClose);
    expect(server.requests).toEqual(["The weather is nice today."]);
  } finally {
    await session.context.close();
    server.close();
  }
});

test("keeps the panel on screen while a container is full screen", async () => {
  const session = await openSession();
  const { page, server } = session;
  const hostParent = () =>
    page.evaluate(() => {
      const host = document.querySelector("ocr-translate-ui");
      return host?.parentElement?.id || host?.parentElement?.tagName;
    });
  const panelIsOnTop = () =>
    page.evaluate(() => {
      const panel = document
        .querySelector("ocr-translate-ui")
        ?.shadowRoot?.querySelector(".ocr-translate-live");
      const box = panel?.getBoundingClientRect();
      return Boolean(
        box &&
          document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
            ?.localName === "ocr-translate-ui",
      );
    });
  try {
    await page.click("#fullscreen");
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe("stage");

    // The subtitles sit at the bottom of the screen now.
    await startLiveTranslation(session, { x1: 190, y1: 600, x2: 1090, y2: 710 });
    expect(await hostParent()).toBe("stage");
    expect(await panelIsOnTop()).toBe(true);

    await showSubtitle(page, "Where did you put the keys?");
    await expect(translation(page)).toHaveText("[uk] Where did you put the keys?", {
      timeout: 20_000,
    });

    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(hostParent).toBe("BODY");
    expect(await panelIsOnTop()).toBe(true);

    await page.click("#fullscreen");
    await expect.poll(hostParent).toBe("stage");
    expect(await panelIsOnTop()).toBe(true);
    expect(server.requests).toEqual(["Where did you put the keys?"]);
  } finally {
    await session.context.close();
    server.close();
  }
});
