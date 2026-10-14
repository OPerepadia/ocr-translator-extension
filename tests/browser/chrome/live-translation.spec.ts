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
import en from "../../../src/public/_locales/en/messages.json" with { type: "json" };

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
    setZoom(tabId: number, zoomFactor: number): Promise<void>;
  };
  runtime: {
    onMessage: { addListener(listener: (message: unknown) => void): void };
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
  #hud { position: absolute; left: 640px; top: 440px; color: #ccc; font-size: 11px; }
  #mark { position: absolute; left: 60px; top: 440px; color: #ddd; font-size: 16px; display: none; }
  #subtitle { position: absolute; left: 0; right: 0; bottom: 36px; padding: 0 40px; text-align: center;
    color: #fff; font-size: 34px; font-weight: 700; line-height: 1.25;
    text-shadow: -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000; }
</style></head><body>
<button id="fullscreen" style="position:absolute;left:1180px;top:10px"
  onclick="document.getElementById('stage').requestFullscreen()">Fullscreen</button>
<div id="stage"><div id="video">
  <div id="hud">Quality 1080p &nbsp; Speed 1.0x &nbsp; Subtitles on</div>
  <div id="mark">Example Channel</div>
  <div id="subtitle"></div>
</div></div>
<script>
  window.setSubtitle = (lines) => {
    document.getElementById("subtitle").innerHTML =
      lines.map((line) => "<div>" + line + "</div>").join("");
  };
</script></body></html>`;

// The same stage with a real video. It plays a canvas that draws the subtitles
// into its pixels, as burned-in subtitles are, over a moving background. The
// video is `width` by `height`, and its picture fills the stage either way.
function videoPage(width = 1000, height = 560): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #111; }
  #stage { position: absolute; left: 140px; top: 40px; width: 1000px; height: 560px; background: #000; }
  #video { position: absolute; inset: 0; width: 100%; height: 100%; }
</style></head><body>
<button id="fullscreen" style="position:absolute;left:1180px;top:10px"
  onclick="document.getElementById('stage').requestFullscreen()">Fullscreen</button>
<div id="stage"><video id="video" muted playsinline></video></div>
<script>
  const canvas = document.createElement("canvas");
  canvas.width = ${width};
  canvas.height = ${height};
  const scale = canvas.width / 1000;
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
    context.font = "bold " + 34 * scale + "px sans-serif";
    context.lineJoin = "round";
    context.lineWidth = 6 * scale;
    lines.forEach((line, index) => {
      const y = canvas.height - (36 + (lines.length - 1 - index) * 42) * scale;
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
}

interface ContextLine {
  text: string;
  translation?: string;
}

interface TranslationServer {
  port: number;
  /** Every text the extension asked to translate. */
  requests: string[];
  /** The context that went with each of them. */
  contexts: ContextLine[][];
  close(): void;
}

async function startTranslationServer(): Promise<TranslationServer> {
  const requests: string[] = [];
  const contexts: ContextLine[][] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const payload = JSON.parse(body) as { messages: Array<{ content: string }> };
      const { segments, context = [] } = JSON.parse(
        payload.messages.at(-1)!.content,
      ) as {
        segments: Array<{ id: number; text: string }>;
        context?: ContextLine[];
      };
      for (const segment of segments) {
        requests.push(segment.text);
        contexts.push(context);
      }
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
  return { port: address.port, requests, contexts, close: () => server.close() };
}

interface Session {
  context: BrowserContext;
  worker: Worker;
  server: TranslationServer;
  page: Page;
}

interface SessionOptions {
  /** Screenshot pixels per CSS pixel. Forced with a browser flag: headless
   * Chromium otherwise captures at 1x whatever the emulated density. */
  pixelRatio?: number;
  html?: string;
}

async function openSession(options: SessionOptions = {}): Promise<Session> {
  const extensionPath = resolve(".output/chrome-mv3");
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const context = await chromium.launchPersistentContext("", {
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    headless: true,
    viewport: { width: 1280, height: 720 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      `--force-device-scale-factor=${options.pixelRatio ?? 1}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const server = await startTranslationServer();

  const worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/popup.html`);
  await settings.evaluate(
    ({ port }) =>
      chrome.storage.local.set({
        uiLocale: "en",
        settings: {
          ocr: { providerId: "paddle", sourceLang: "en" },
          translation: {
            providerId: "openai",
            targetLang: "uk",
            llm: { baseUrl: `http://127.0.0.1:${port}/v1`, model: "test" },
          },
        },
      }),
    { port: server.port },
  );
  await settings.close();

  const page = await context.newPage();
  await page.route(`${PAGE_URL}**`, (route) =>
    route.fulfill({ contentType: "text/html", body: options.html ?? SUBTITLE_PAGE }),
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

interface SentImage {
  mediaType: string;
  width: number;
  height: number;
}

type ImageSizes = { __imageSizes?: SentImage[] };

/** Records each video frame sent to be read from now on. */
function recordImageSizes(worker: Worker): Promise<void> {
  return worker.evaluate(() => {
    const record = globalThis as ImageSizes;
    record.__imageSizes = [];
    chrome.runtime.onMessage.addListener((message) => {
      const { type, image } = message as {
        type?: string;
        image?: { data: string; mediaType: string };
      };
      if (type !== "LIVE_IMAGE_REQUEST" || !image) {
        return;
      }
      const { mediaType } = image;
      void fetch(`data:${mediaType};base64,${image.data}`)
        .then((response) => response.blob())
        .then((blob) => createImageBitmap(blob))
        .then(({ width, height }) =>
          record.__imageSizes?.push({ mediaType, width, height }),
        );
    });
  });
}

const imageSizes = (worker: Worker) =>
  worker.evaluate(() => (globalThis as ImageSizes).__imageSizes ?? []);

const translation = (page: Page) =>
  page.locator(".ocr-translate-live-translation");

// The line the region shows now. Earlier lines stay in the panel.
const currentLine = (page: Page) =>
  page.locator(".ocr-translate-live-line.is-current");

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
    // The languages that were used are shown.
    await expect(page.locator(".ocr-translate-live-languages")).toHaveText("EN → UK");

    await showSubtitle(page);
    await expect(currentLine(page)).toHaveCount(0, { timeout: 10_000 });

    // The same line coming straight back is not translated or listed again.
    await showSubtitle(page, "The weather is nice today.");
    await expect(currentLine(page)).toHaveCount(1, { timeout: 10_000 });
    await expect(translation(page)).toHaveText(["[uk] The weather is nice today."]);
    await showSubtitle(page);
    await expect(currentLine(page)).toHaveCount(0, { timeout: 10_000 });

    await showSubtitle(
      page,
      "We should walk to the market",
      "before it starts to rain.",
    );
    // The newest line is at the bottom.
    await expect(translation(page)).toHaveText(
      [
        "[uk] The weather is nice today.",
        "[uk] We should walk to the market before it starts to rain.",
      ],
      { timeout: 10_000 },
    );

    expect(server.requests).toEqual([
      "The weather is nice today.",
      "We should walk to the market before it starts to rain.",
    ]);
    // The second line was translated knowing what came before it and how that
    // was translated.
    expect(server.contexts).toEqual([
      [],
      [{ text: "The weather is nice today.", translation: "[uk] The weather is nice today." }],
    ]);
  } finally {
    await session.context.close();
    server.close();
  }
});

test("learns how thick the subtitles are and ignores thinner text beside them", async () => {
  const session = await openSession();
  const { page, server } = session;
  try {
    // The watermark is above the floor, so only the subtitles being much larger
    // keeps it out. It is well under half their size, so the test does not
    // depend on the exact ratio.
    await page.evaluate(() => {
      const mark = document.getElementById("mark")!;
      mark.style.display = "block";
      mark.style.fontSize = "18px";
      document.getElementById("subtitle")!.style.fontSize = "48px";
    });
    await showSubtitle(page, "See you tomorrow.");
    await startLiveTranslation(session);

    await expect(translation(page)).toHaveText("[uk] See you tomorrow.", {
      timeout: 20_000,
    });

    // Between subtitles the thinner text is all there is, so nothing shows.
    await showSubtitle(page);
    await expect(currentLine(page)).toHaveCount(0, { timeout: 10_000 });
    await page.waitForTimeout(3_000);
    await expect(currentLine(page)).toHaveCount(0);

    await showSubtitle(page, "Where are the keys?");
    await expect(translation(page)).toHaveText(
      ["[uk] See you tomorrow.", "[uk] Where are the keys?"],
      { timeout: 10_000 },
    );

    expect(server.requests).toEqual(["See you tomorrow.", "Where are the keys?"]);
  } finally {
    await session.context.close();
    server.close();
  }
});

test("applies the floor the same way on a high-density screen", async () => {
  const session = await openSession({ pixelRatio: 2 });
  const { page, server } = session;
  try {
    await startLiveTranslation(session);
    await page.waitForTimeout(3_000);
    // At twice the density the small text has twice the pixels, and is still
    // the same size on screen, so it is still left out.
    await expect(translation(page)).toHaveCount(0);

    await showSubtitle(page, "See you tomorrow.");
    await expect(translation(page)).toHaveText("[uk] See you tomorrow.", {
      timeout: 20_000,
    });
    expect(server.requests).toEqual(["See you tomorrow."]);
  } finally {
    await session.context.close();
    server.close();
  }
});

test("does not read its own panel when the panel covers the region", async () => {
  const session = await openSession();
  const { page, server } = session;
  try {
    // A region this wide is scaled down for detection, which makes the small
    // text's size too rough to filter out reliably.
    await page.locator("#hud").evaluate((hud) => hud.remove());
    // A region this large leaves the panel nowhere else to go. It stops short
    // of the page's own button, which would be read as well.
    await startLiveTranslation(session, { x1: 10, y1: 50, x2: 1170, y2: 710 });
    expect(await overlaps(page, ".ocr-translate-live", ".ocr-translate-live-region")).toBe(true);
    // The page is read from screenshots, so the panel says what it hides.
    await expect(page.locator(".ocr-translate-live-warning")).toBeVisible();

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

test("reads a 1080p video at 720p from its frames while the panel covers the subtitles", async () => {
  const session = await openSession({ html: videoPage(1920, 1080) });
  const { page, worker, server } = session;
  try {
    await recordImageSizes(worker);
    await startLiveTranslation(session);
    // Cover the selected region with the panel.
    const title = await page.locator(".ocr-translate-live-title").boundingBox();
    const panel = await page.locator(".ocr-translate-live").boundingBox();
    const region = page.locator(".ocr-translate-live-region");
    const regionBox = await region.boundingBox();
    if (!title || !panel || !regionBox) {
      throw new Error("The panel and region must be on screen.");
    }
    const dx = regionBox.x + regionBox.width / 2 - (panel.x + panel.width / 2);
    const dy = regionBox.y + regionBox.height / 2 - (panel.y + panel.height / 2);
    const grip = { x: title.x + title.width / 2, y: title.y + title.height / 2 };
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(grip.x + dx, grip.y + dy, { steps: 5 });
    await page.mouse.up();
    const coveringRegion = () => region.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.localName;
    });
    expect(await coveringRegion()).toBe("ocr-translate-ui");

    await countCaptures(worker);
    await showSubtitle(page, "See you tomorrow.");
    await expect(translation(page)).toHaveText("[uk] See you tomorrow.", {
      timeout: 20_000,
    });

    expect(await capturesSoFar(worker)).toBe(0);
    // Nothing is hidden, so there is nothing to warn about.
    await expect(page.locator(".ocr-translate-live-warning")).toBeHidden();

    const expectedSize = await page.locator("#video").evaluate((element, selection) => {
      const video = element as HTMLVideoElement;
      const rect = video.getBoundingClientRect();
      const displayScale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
      return {
        width: (selection.x2 - selection.x1) / (video.videoWidth * displayScale) * 1280,
        height: (selection.y2 - selection.y1) / (video.videoHeight * displayScale) * 720,
      };
    }, SUBTITLE_REGION);
    const sizes = await imageSizes(worker);
    expect(sizes.length).toBeGreaterThan(0);
    for (const { mediaType, width, height } of sizes) {
      expect(mediaType).toMatch(/^image\//);
      // Cropping and resampling each round to whole pixels.
      expect(Math.abs(width - expectedSize.width)).toBeLessThanOrEqual(2);
      expect(Math.abs(height - expectedSize.height)).toBeLessThanOrEqual(2);
    }

    // In full screen the subtitles are larger and lower, and the panel stays
    // over them.
    await page.click("#fullscreen");
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe("stage");
    await expect.poll(coveringRegion).toBe("ocr-translate-ui");
    await showSubtitle(page, "Where are the keys?");
    await expect(translation(page)).toHaveText(
      ["[uk] See you tomorrow.", "[uk] Where are the keys?"],
      { timeout: 10_000 },
    );
    expect(server.requests).toEqual(["See you tomorrow.", "Where are the keys?"]);
  } finally {
    await session.context.close();
    server.close();
  }
});

test("reads a video it may not read from screenshots", async () => {
  const session = await openSession();
  const { page, worker, server } = session;
  try {
    // A video from another site that does not allow reading its pixels. The
    // page can show it, and its subtitle is part of the picture.
    const webm = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1000;
      canvas.height = 560;
      const context = canvas.getContext("2d")!;
      const draw = () => {
        context.fillStyle = `hsl(${(Date.now() / 20) % 360}, 40%, 30%)`;
        context.fillRect(0, 0, 1000, 560);
        context.textAlign = "center";
        context.font = "bold 34px sans-serif";
        context.lineJoin = "round";
        context.lineWidth = 6;
        context.strokeStyle = "#000";
        context.strokeText("See you tomorrow.", 500, 524);
        context.fillStyle = "#fff";
        context.fillText("See you tomorrow.", 500, 524);
      };
      draw();
      const timer = setInterval(draw, 40);
      const recorder = new MediaRecorder(canvas.captureStream(25), {
        mimeType: "video/webm",
      });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const stopped = new Promise((done) => (recorder.onstop = done));
      recorder.start();
      await new Promise((done) => setTimeout(done, 2000));
      recorder.stop();
      await stopped;
      clearInterval(timer);
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      let binary = "";
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      return btoa(binary);
    });
    await page.route("http://media.test/**", (route) =>
      route.fulfill({ contentType: "video/webm", body: Buffer.from(webm, "base64") }),
    );
    await page.route(`${PAGE_URL}player`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><body style="margin:0;background:#111">
          <video id="video" src="http://media.test/subtitle.webm" muted autoplay loop playsinline
            style="position:absolute;left:140px;top:40px;width:1000px;height:560px"></video>
        </body>`,
      }),
    );
    await page.goto(`${PAGE_URL}player`);
    await page.waitForFunction(
      () => (document.getElementById("video") as HTMLVideoElement).readyState >= 2,
    );
    // Let the content script finish starting.
    await page.waitForTimeout(500);

    await countCaptures(worker);
    await startLiveTranslation(session);
    await expect(translation(page)).toHaveText("[uk] See you tomorrow.", {
      timeout: 20_000,
    });
    expect(await capturesSoFar(worker)).toBeGreaterThan(0);
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
    await expect(page.locator(".ocr-translate-live-original")).toBeHidden();
    await page.getByRole("button", { name: en.liveShowOriginal.message, exact: true }).click();
    await expect(page.locator(".ocr-translate-live-original")).toBeVisible();
    await expect(page.locator(".ocr-translate-live-original")).toHaveText(
      "The weather is nice today.",
    );

    await page.getByRole("button", { name: en.livePause.message, exact: true }).click();
    // A read already out when the panel pauses still captures, so start
    // counting once it has.
    await page.waitForTimeout(1_000);
    await countCaptures(worker);
    await page.waitForTimeout(3_000);
    expect(await capturesSoFar(worker)).toBe(0);

    await page.getByRole("button", { name: en.liveResume.message, exact: true }).click();
    await expect.poll(() => capturesSoFar(worker), { timeout: 10_000 }).toBeGreaterThan(0);

    await page.getByRole("button", { name: en.commonClose.message, exact: true }).click();
    await expect(page.locator(".ocr-translate-live")).toHaveCount(0);
    await expect(page.locator(".ocr-translate-live-region")).toHaveCount(0);
    await page.waitForTimeout(1_000);
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

test("follows the video when the page zooms and goes full screen", async () => {
  const session = await openSession();
  const { page, worker, server } = session;
  const setZoom = (factor: number) =>
    worker.evaluate(
      async ({ url, factor }) => {
        const [tab] = await chrome.tabs.query({ url });
        await chrome.tabs.setZoom(tab.id, factor);
      },
      { url: `${PAGE_URL}*`, factor },
    );
  // Whether the frame drawn around the region takes in every line of the
  // subtitle.
  const frameHoldsSubtitle = async () => {
    const frame = await page.locator(".ocr-translate-live-region").boundingBox();
    const subtitle = await page.locator("#subtitle").boundingBox();
    return Boolean(
      frame &&
        subtitle &&
        frame.y <= subtitle.y &&
        frame.y + frame.height >= subtitle.y + subtitle.height,
    );
  };
  try {
    // A player that takes a share of the window, like on most video sites,
    // with a real video element and subtitles drawn to its scale. Zooming in
    // makes it smaller in CSS pixels.
    await page.addStyleTag({
      content: `
        #stage { left: 10vw; top: 5vh; width: 80vw; height: 45vw; }
        #video { container-type: size; }
        #subtitle { bottom: 5cqh; padding: 0 3cqw; font-size: 5.8cqh; }
      `,
    });
    await page.evaluate(() => {
      document.getElementById("hud")!.remove();
      const video = document.createElement("video");
      video.style.cssText = "position: absolute; inset: 0; width: 100%; height: 100%";
      document.getElementById("video")!.prepend(video);
    });
    await startLiveTranslation(session, { x1: 200, y1: 470, x2: 1080, y2: 600 });

    await showSubtitle(page, "The weather is nice today.");
    await expect(translation(page)).toHaveText("[uk] The weather is nice today.", {
      timeout: 20_000,
    });

    await setZoom(1.5);
    await showSubtitle(page, "We should walk to the market.");
    await expect(translation(page)).toHaveText(
      ["[uk] The weather is nice today.", "[uk] We should walk to the market."],
      { timeout: 10_000 },
    );
    expect(await frameHoldsSubtitle()).toBe(true);

    await setZoom(1);
    await page.click("#fullscreen");
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe("stage");
    await showSubtitle(page, "See you tomorrow.");
    await expect(translation(page)).toHaveText(
      [
        "[uk] The weather is nice today.",
        "[uk] We should walk to the market.",
        "[uk] See you tomorrow.",
      ],
      { timeout: 10_000 },
    );
    expect(await frameHoldsSubtitle()).toBe(true);

    expect(server.requests).toEqual([
      "The weather is nice today.",
      "We should walk to the market.",
      "See you tomorrow.",
    ]);
  } finally {
    await session.context.close();
    server.close();
  }
});
