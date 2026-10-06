import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LiveFrameResponse,
  LiveTranslationResponse,
} from "@/shared/messages";
import {
  CONTEXT_GAP_MS,
  EMPTY_READS_BEFORE_CLEAR,
  IDLE_INTERVAL_MS,
  LiveSession,
  MAX_CONTEXT_LINES,
  MAX_FAILED_READS,
  MAX_TRANSLATIONS,
  MIN_LINE_RATIO,
  READ_INTERVAL_MS,
  RETRY_INTERVAL_MS,
  RETRY_TRANSLATION_MS,
  UNCHANGED_READS_BEFORE_IDLE,
  type LiveState,
} from "./live-session";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const read = (
  text: string,
  unchanged = false,
  lineThickness?: number,
): LiveFrameResponse => ({
  status: "ok",
  text,
  unchanged,
  lineThickness,
});

const translated = (
  text: string,
  targetLang = "uk",
  sourceLang?: string,
): LiveTranslationResponse => ({
  translation: { text, targetLang, sourceLang },
  translationStatus: { state: "ok" },
});

type Reply = LiveFrameResponse | Error;

function setup(options: { visible?: boolean } = {}) {
  let visible = options.visible ?? true;
  const replies: Reply[] = [];
  const states: LiveState[] = [];
  let nextId = 0;

  const readFrame = vi.fn(
    async (
      _requestId: string,
      _minLineThickness: number | undefined,
    ): Promise<LiveFrameResponse> => {
      // With nothing queued the region keeps showing what it showed last.
      const reply = replies.length > 1 ? replies.shift()! : replies[0];
      if (reply instanceof Error) {
        throw reply;
      }
      return reply ?? read("");
    },
  );
  const translate = vi.fn(
    async (
      _requestId: string,
      text: string,
      _context: string[],
    ): Promise<LiveTranslationResponse> => translated(`[uk] ${text}`),
  );
  const cancel = vi.fn();

  const session = new LiveSession({
    readFrame,
    translate,
    cancel,
    createId: () => `request-${++nextId}`,
    isVisible: () => visible,
    now: () => Date.now(),
    onChange: (state) => states.push(state),
  });

  return {
    session,
    readFrame,
    translate,
    cancel,
    states,
    replies,
    setVisible: (next: boolean) => {
      visible = next;
    },
    last: () => states.at(-1),
  };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("LiveSession", () => {
  it("reads at once and then translates the line it found", async () => {
    const t = setup();
    t.replies.push(read("Good morning."));

    t.session.start();
    await advance(0);

    expect(t.readFrame).toHaveBeenCalledOnce();
    const line = {
      original: "Good morning.",
      translation: "[uk] Good morning.",
      state: "ready",
    };
    expect(t.last()).toEqual({ status: "running", lines: [line], line, targetLang: "uk" });
    expect(t.translate).toHaveBeenCalledWith(expect.any(String), "Good morning.", []);
  });

  it("reports the languages with the first translation, not before", async () => {
    const t = setup();
    t.replies.push(read("Good morning."));
    let resolve: (response: LiveTranslationResponse) => void = () => {};
    t.translate.mockImplementationOnce(() => new Promise((done) => (resolve = done)));

    t.session.start();
    await advance(0);
    expect(t.last()?.sourceLang).toBeUndefined();
    expect(t.last()?.targetLang).toBeUndefined();

    resolve(translated("[uk] Good morning.", "uk", "en"));
    await advance(0);
    // They arrive in the same update as the translation.
    expect(t.last()).toMatchObject({
      sourceLang: "en",
      targetLang: "uk",
      line: { state: "ready" },
    });
    const withLanguages = t.states.filter((state) => state.sourceLang);
    expect(withLanguages).toHaveLength(1);
    t.session.stop();
  });

  it("follows the source language as it is detected line by line", async () => {
    const t = setup();
    t.replies.push(read("Good morning."), read("Guten Morgen."));
    t.translate
      .mockResolvedValueOnce(translated("[uk] Good morning.", "uk", "en"))
      .mockResolvedValueOnce(translated("[uk] Guten Morgen.", "uk", "de"));

    t.session.start();
    await advance(READ_INTERVAL_MS);

    expect(t.last()).toMatchObject({ sourceLang: "de", targetLang: "uk" });
    t.session.stop();
  });

  it("keeps the languages when a later translation does not name them", async () => {
    const t = setup();
    t.replies.push(read("Good morning."), read("A different line"));
    t.translate
      .mockResolvedValueOnce(translated("[uk] Good morning.", "uk", "en"))
      .mockResolvedValueOnce({ translationStatus: { state: "failed", reason: "HTTP 429" } });

    t.session.start();
    await advance(READ_INTERVAL_MS);

    expect(t.last()?.lines[1].state).toBe("failed");
    expect(t.last()).toMatchObject({ sourceLang: "en", targetLang: "uk" });
    t.session.stop();
  });

  it("takes the languages from a result without a translation", async () => {
    const t = setup();
    t.replies.push(read("Good morning."));
    t.translate.mockResolvedValue({
      translationStatus: { state: "same_language", sourceLang: "uk", targetLang: "uk" },
    });

    t.session.start();
    await advance(0);

    expect(t.last()).toMatchObject({ sourceLang: "uk", targetLang: "uk" });
    t.session.stop();
  });

  it("shows the original while the translation is on its way", async () => {
    const t = setup();
    t.replies.push(read("Good morning."));
    t.translate.mockImplementation(() => new Promise(() => {}));

    t.session.start();
    await advance(0);

    expect(t.last()?.line).toEqual({ original: "Good morning.", state: "pending" });
    t.session.stop();
  });

  it("stays in starting until the first read comes back", async () => {
    const t = setup();
    t.readFrame.mockImplementation(() => new Promise(() => {}));

    t.session.start();
    await advance(5000);

    expect(t.session.current.status).toBe("starting");
    t.session.stop();
  });

  it("starts the next read one interval after the previous one began", async () => {
    const t = setup();
    t.replies.push(read("Good morning."));

    t.session.start();
    await advance(0);
    await advance(READ_INTERVAL_MS - 1);
    expect(t.readFrame).toHaveBeenCalledTimes(1);

    await advance(1);
    expect(t.readFrame).toHaveBeenCalledTimes(2);
    t.session.stop();
  });

  it("does not translate the same line twice", async () => {
    const t = setup();
    t.replies.push(read("Good morning."));

    t.session.start();
    await advance(READ_INTERVAL_MS * 4);

    expect(t.readFrame.mock.calls.length).toBeGreaterThan(3);
    expect(t.translate).toHaveBeenCalledOnce();
    t.session.stop();
  });

  it("keeps the line when a later read differs only by recognition noise", async () => {
    const t = setup();
    t.replies.push(
      read("I will meet you at the station tomorrow"),
      read("I will meet you at the stat1on tomorrow"),
    );

    t.session.start();
    await advance(READ_INTERVAL_MS * 2);

    expect(t.translate).toHaveBeenCalledOnce();
    expect(t.last()?.line?.original).toBe("I will meet you at the station tomorrow");
    t.session.stop();
  });

  it("fills in a line's translation after the next line shows", async () => {
    const t = setup();
    t.replies.push(read("First line here"), read("A different line"));
    let resolveFirst: (response: LiveTranslationResponse) => void = () => {};
    t.translate.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve)),
    );

    t.session.start();
    await advance(READ_INTERVAL_MS);
    expect(t.last()?.lines.map((line) => line.state)).toEqual(["pending", "ready"]);

    resolveFirst(translated("[uk] First line here"));
    await advance(0);
    const second = {
      original: "A different line",
      translation: "[uk] A different line",
      state: "ready",
    };
    expect(t.last()?.lines).toEqual([
      { original: "First line here", translation: "[uk] First line here", state: "ready" },
      second,
    ]);
    expect(t.last()?.line).toEqual(second);
    expect(t.cancel).not.toHaveBeenCalled();
    t.session.stop();
  });

  it("keeps every line after it leaves the screen", async () => {
    const t = setup();
    t.replies.push(read("First line here"), read("A different line"), read(""));

    t.session.start();
    await advance(READ_INTERVAL_MS * (1 + EMPTY_READS_BEFORE_CLEAR));

    expect(t.last()?.line).toBeUndefined();
    expect(t.last()?.lines).toEqual([
      { original: "First line here", translation: "[uk] First line here", state: "ready" },
      { original: "A different line", translation: "[uk] A different line", state: "ready" },
    ]);
    t.session.stop();
  });

  it("keeps translating a line after the screen clears", async () => {
    const t = setup();
    t.replies.push(read("Good morning."), read(""));
    let resolve: (response: LiveTranslationResponse) => void = () => {};
    t.translate.mockImplementationOnce(() => new Promise((done) => (resolve = done)));

    t.session.start();
    await advance(READ_INTERVAL_MS * EMPTY_READS_BEFORE_CLEAR);
    expect(t.last()?.line).toBeUndefined();

    resolve(translated("[uk] Good morning."));
    await advance(0);
    expect(t.cancel).not.toHaveBeenCalled();
    expect(t.last()?.line).toBeUndefined();
    expect(t.last()?.lines).toEqual([
      { original: "Good morning.", translation: "[uk] Good morning.", state: "ready" },
    ]);
    t.session.stop();
  });

  it("does not ask again for a line that comes back while it is translated", async () => {
    const t = setup();
    t.replies.push(read("Good morning."), read(""), read(""), read("Good morning."));
    t.translate.mockImplementation(() => new Promise(() => {}));

    t.session.start();
    await advance(READ_INTERVAL_MS * 3);

    expect(t.translate).toHaveBeenCalledOnce();
    expect(t.last()?.lines).toHaveLength(1);
    expect(t.last()?.line).toEqual({ original: "Good morning.", state: "pending" });
    t.session.stop();
  });

  it("drops the oldest translation when too many are out", async () => {
    const t = setup();
    const lines = ["Line one here", "Line two here", "Line three here", "Line four here"];
    t.replies.push(...lines.map((line) => read(line)));
    t.translate.mockImplementation(() => new Promise(() => {}));

    t.session.start();
    await advance(READ_INTERVAL_MS * (lines.length - 1));

    expect(MAX_TRANSLATIONS).toBe(3);
    expect(t.cancel).toHaveBeenCalledOnce();
    expect(t.cancel).toHaveBeenCalledWith(t.translate.mock.calls[0][0]);
    expect(t.last()?.lines.map((line) => line.state)).toEqual([
      "skipped",
      "pending",
      "pending",
      "pending",
    ]);
    expect(t.last()?.lines[0].original).toBe("Line one here");
    t.session.stop();
  });

  it("shows a line that comes straight back without asking again", async () => {
    const t = setup();
    t.replies.push(
      read("First line here"),
      read(""),
      read(""),
      read("First line here"),
    );

    t.session.start();
    await advance(READ_INTERVAL_MS * 3);

    expect(t.translate).toHaveBeenCalledOnce();
    expect(t.last()?.line).toEqual({
      original: "First line here",
      translation: "[uk] First line here",
      state: "ready",
    });
    expect(t.last()?.lines).toHaveLength(1);
    t.session.stop();
  });

  it("translates a repeated line again when other lines came before it", async () => {
    const t = setup();
    t.replies.push(
      read("Yes, of course."),
      read("Are you sure about that?"),
      read("Yes, of course."),
    );

    t.session.start();
    await advance(READ_INTERVAL_MS * 2);

    expect(t.translate.mock.calls.map(([, text, context]) => [text, context])).toEqual([
      ["Yes, of course.", []],
      ["Are you sure about that?", ["Yes, of course."]],
      ["Yes, of course.", ["Yes, of course.", "Are you sure about that?"]],
    ]);
    t.session.stop();
  });

  it("ignores cached lines once the target language changes", async () => {
    const t = setup();
    // Two lines alternating until the same line follows the same lines again.
    t.replies.push(
      read("First line here"),
      read("Second line here"),
      read("First line here"),
      read("Second line here"),
      read("First line here"),
      read("Second line here"),
    );
    t.translate.mockImplementation(async (_id, text) =>
      translated(`[x] ${text}`, t.translate.mock.calls.length >= 5 ? "fr" : "de"),
    );

    t.session.start();
    await advance(READ_INTERVAL_MS * 5);

    // The sixth line would come from the cache, were it not in another language.
    expect(t.translate).toHaveBeenCalledTimes(6);
    t.session.stop();
  });

  it("serves a cached line when the same lines came before it", async () => {
    const t = setup();
    t.replies.push(
      read("First line here"),
      read("Second line here"),
      read("First line here"),
      read("Second line here"),
      read("First line here"),
      read("Second line here"),
    );

    t.session.start();
    await advance(READ_INTERVAL_MS * 5);

    expect(t.translate).toHaveBeenCalledTimes(5);
    expect(t.last()?.line?.state).toBe("ready");
    t.session.stop();
  });

  it("gives each line the lines shown just before it as context", async () => {
    const t = setup();
    t.replies.push(
      read("I was going to tell you"),
      read("that I am leaving"),
      read("and not coming back."),
    );

    t.session.start();
    await advance(READ_INTERVAL_MS * 2);

    expect(t.translate.mock.calls.map(([, , context]) => context)).toEqual([
      [],
      ["I was going to tell you"],
      ["I was going to tell you", "that I am leaving"],
    ]);
    t.session.stop();
  });

  it("limits the context to the last few lines", async () => {
    const t = setup();
    const lines = ["Line one here", "Line two here", "Line three here", "Line four here", "Line five here"];
    t.replies.push(...lines.map((line) => read(line)));

    t.session.start();
    await advance(READ_INTERVAL_MS * lines.length);

    expect(MAX_CONTEXT_LINES).toBe(3);
    expect(t.translate.mock.calls.at(-1)?.[2]).toEqual(lines.slice(1, 4));
    t.session.stop();
  });

  it("does not add a line to the context for every read of it", async () => {
    const t = setup();
    t.replies.push(
      read("The first line"),
      read("The first line"),
      read("The first line"),
      read("The second line"),
    );

    t.session.start();
    await advance(READ_INTERVAL_MS * 3);

    expect(t.translate.mock.calls.map(([, text, context]) => [text, context])).toEqual([
      ["The first line", []],
      ["The second line", ["The first line"]],
    ]);
    t.session.stop();
  });

  it("leaves out lines from before a long pause", async () => {
    const t = setup();
    const pause = Math.ceil(CONTEXT_GAP_MS / READ_INTERVAL_MS) + 2;
    t.replies.push(
      read("The first line"),
      ...Array.from({ length: pause }, () => read("")),
      read("The second line"),
    );

    t.session.start();
    await advance(READ_INTERVAL_MS * (pause + 1));

    expect(t.translate.mock.calls.map(([, text, context]) => [text, context])).toEqual([
      ["The first line", []],
      ["The second line", []],
    ]);
    t.session.stop();
  });

  it("keeps a line's context when it comes back after the screen cleared", async () => {
    const t = setup();
    t.replies.push(
      read("The first line"),
      read("The second line"),
      read(""),
      read(""),
      read("The second line"),
    );

    t.session.start();
    await advance(READ_INTERVAL_MS * 4);

    expect(t.translate).toHaveBeenCalledTimes(2);
    expect(t.last()?.line?.translation).toBe("[uk] The second line");
    t.session.stop();
  });

  it("keeps the line through one empty read and clears it after the next", async () => {
    const t = setup();
    t.replies.push(read("Good morning."), read(""));

    t.session.start();
    await advance(READ_INTERVAL_MS * (EMPTY_READS_BEFORE_CLEAR - 1));
    expect(t.last()?.line?.original).toBe("Good morning.");

    await advance(READ_INTERVAL_MS);
    expect(t.last()?.line).toBeUndefined();
    t.session.stop();
  });

  it("does not let an isolated empty read clear a line that comes back", async () => {
    const t = setup();
    t.replies.push(read("Good morning."), read(""), read("Good morning."));

    t.session.start();
    await advance(READ_INTERVAL_MS * 4);

    const firstLine = t.states.findIndex((state) => state.line);
    expect(t.states.slice(firstLine).every((state) => state.line)).toBe(true);
    expect(t.last()?.line?.original).toBe("Good morning.");
    expect(t.translate).toHaveBeenCalledOnce();
    t.session.stop();
  });

  it("treats a stray glyph as an empty read", async () => {
    const t = setup();
    t.replies.push(read("Good morning."), read("l"));

    t.session.start();
    await advance(READ_INTERVAL_MS * EMPTY_READS_BEFORE_CLEAR);

    expect(t.last()?.line).toBeUndefined();
    t.session.stop();
  });

  it("slows down while the region does not change", async () => {
    const t = setup();
    t.replies.push(read("Good morning."), read("Good morning.", true));

    t.session.start();
    // The first read finds the line; the next ones all report no change.
    await advance(READ_INTERVAL_MS * UNCHANGED_READS_BEFORE_IDLE);
    const readsWhenIdle = t.readFrame.mock.calls.length;
    await advance(IDLE_INTERVAL_MS - 1);

    expect(t.readFrame.mock.calls.length).toBe(readsWhenIdle);
    await advance(1);
    expect(t.readFrame.mock.calls.length).toBe(readsWhenIdle + 1);
    t.session.stop();
  });

  it("speeds up again once the region changes", async () => {
    const t = setup();
    t.replies.push(read("Good morning.", true));

    t.session.start();
    await advance(READ_INTERVAL_MS * UNCHANGED_READS_BEFORE_IDLE);
    t.replies.length = 0;
    t.replies.push(read("A different line"));
    // The idle wait ends, and the read that follows finds a new line.
    await advance(IDLE_INTERVAL_MS);
    const readsAfterChange = t.readFrame.mock.calls.length;
    await advance(READ_INTERVAL_MS);

    expect(t.readFrame.mock.calls.length).toBe(readsAfterChange + 1);
    t.session.stop();
  });

  it("does not read while the tab is hidden", async () => {
    const t = setup({ visible: false });
    t.replies.push(read("Good morning."));

    t.session.start();
    await advance(IDLE_INTERVAL_MS * 3);

    expect(t.readFrame).not.toHaveBeenCalled();
    t.session.stop();
  });

  it("reads straight away when woken after the tab becomes visible", async () => {
    const t = setup({ visible: false });
    t.replies.push(read("Good morning."));

    t.session.start();
    await advance(100);
    t.setVisible(true);
    t.session.wake();
    await advance(0);

    expect(t.readFrame).toHaveBeenCalledOnce();
    t.session.stop();
  });

  it("does not count a hidden-tab reply as a read", async () => {
    const t = setup();
    t.replies.push({ status: "hidden" });

    t.session.start();
    await advance(READ_INTERVAL_MS);

    expect(t.session.current).toEqual({ status: "starting", lines: [] });
    t.session.stop();
  });

  it("stops reading while paused and picks up again on resume", async () => {
    const t = setup();
    t.replies.push(read("Good morning."));

    t.session.start();
    await advance(0);
    t.session.pause();
    expect(t.session.current.status).toBe("paused");
    const readsBefore = t.readFrame.mock.calls.length;
    await advance(IDLE_INTERVAL_MS * 3);
    expect(t.readFrame.mock.calls.length).toBe(readsBefore);
    expect(t.session.current.line?.original).toBe("Good morning.");

    t.session.resume();
    await advance(0);
    expect(t.session.current.status).toBe("running");
    expect(t.readFrame.mock.calls.length).toBe(readsBefore + 1);
    t.session.stop();
  });

  it("keeps the panel still when a read that was already out finishes after pausing", async () => {
    const t = setup();
    let finish: (response: LiveFrameResponse) => void = () => {};
    t.readFrame.mockImplementation(() => new Promise((resolve) => (finish = resolve)));

    t.session.start();
    await advance(0);
    t.session.pause();
    finish(read("Good morning."));
    await advance(0);

    expect(t.session.current).toEqual({ status: "paused", lines: [] });
    expect(t.translate).not.toHaveBeenCalled();
    t.session.stop();
  });

  it("goes back to starting when resumed before anything was read", async () => {
    const t = setup();
    t.readFrame.mockImplementation(() => new Promise(() => {}));

    t.session.start();
    t.session.pause();
    t.session.resume();

    expect(t.session.current.status).toBe("starting");
    t.session.stop();
  });

  it("retries a failed read before giving up", async () => {
    const t = setup();
    t.replies.push(new Error("capture failed"), read("Good morning."));

    t.session.start();
    await advance(0);
    expect(t.session.current.status).toBe("starting");

    await advance(RETRY_INTERVAL_MS);
    expect(t.session.current.status).toBe("running");
    expect(t.last()?.line?.original).toBe("Good morning.");
    t.session.stop();
  });

  it("gives up after repeated failures and offers a retry", async () => {
    const t = setup();
    t.replies.push(new Error("worker crashed"));

    t.session.start();
    await advance(RETRY_INTERVAL_MS * MAX_FAILED_READS);

    expect(t.session.current).toEqual({
      status: "error",
      lines: [],
      error: "worker crashed",
    });
    const reads = t.readFrame.mock.calls.length;
    expect(reads).toBe(MAX_FAILED_READS);
    await advance(IDLE_INTERVAL_MS * 3);
    expect(t.readFrame.mock.calls.length).toBe(reads);

    t.replies.length = 0;
    t.replies.push(read("Good morning."));
    t.session.retry();
    await advance(0);

    expect(t.session.current.status).toBe("running");
    expect(t.session.current.error).toBeUndefined();
    t.session.stop();
  });

  it("does not let consecutive-failure counting span successful reads", async () => {
    const t = setup();
    t.replies.push(
      new Error("one"),
      new Error("two"),
      read("Good morning."),
      new Error("three"),
      new Error("four"),
      read("Good morning."),
    );

    t.session.start();
    await advance(RETRY_INTERVAL_MS * 6);

    expect(t.session.current.status).toBe("running");
    t.session.stop();
  });

  it("shows the original and the reason when translation fails", async () => {
    const t = setup();
    t.replies.push(read("Good morning."));
    t.translate.mockResolvedValue({
      translationStatus: { state: "failed", reason: "HTTP 429", targetLang: "uk" },
    });

    t.session.start();
    await advance(0);

    expect(t.last()?.line).toEqual({
      original: "Good morning.",
      state: "failed",
      error: "HTTP 429",
    });
    t.session.stop();
  });

  it("shows the original when translation rejects", async () => {
    const t = setup();
    t.replies.push(read("Good morning."));
    t.translate.mockRejectedValue(new Error("offline"));

    t.session.start();
    await advance(0);

    expect(t.last()?.line).toEqual({
      original: "Good morning.",
      state: "failed",
      error: "offline",
    });
    t.session.stop();
  });

  it("translates a failed line again only after a pause", async () => {
    const t = setup();
    t.replies.push(read("Good morning."));
    t.translate.mockResolvedValueOnce({
      translationStatus: { state: "failed", reason: "HTTP 429", targetLang: "uk" },
    });

    t.session.start();
    await advance(RETRY_TRANSLATION_MS - READ_INTERVAL_MS);
    expect(t.translate).toHaveBeenCalledOnce();

    await advance(READ_INTERVAL_MS * 2);
    expect(t.translate).toHaveBeenCalledTimes(2);
    expect(t.last()?.line?.state).toBe("ready");
    t.session.stop();
  });

  it("translates a failed line again with the context it had", async () => {
    const t = setup();
    t.replies.push(read("The first line"), read("The second line"));
    t.translate
      .mockResolvedValueOnce(translated("[uk] The first line"))
      .mockResolvedValueOnce({
        translationStatus: { state: "failed", reason: "HTTP 429", targetLang: "uk" },
      });

    t.session.start();
    await advance(RETRY_TRANSLATION_MS + READ_INTERVAL_MS * 2);

    expect(t.translate.mock.calls.map(([, text, context]) => [text, context])).toEqual([
      ["The first line", []],
      ["The second line", ["The first line"]],
      ["The second line", ["The first line"]],
    ]);
    t.session.stop();
  });

  it("shows text that is already in the target language as it is", async () => {
    const t = setup();
    t.replies.push(read("Good morning."));
    t.translate.mockResolvedValue({
      translationStatus: { state: "same_language", sourceLang: "uk", targetLang: "uk" },
    });

    t.session.start();
    await advance(0);

    expect(t.last()?.line).toEqual({ original: "Good morning.", state: "same-language" });
    t.session.stop();
  });

  it("cancels its requests and goes quiet when stopped", async () => {
    const t = setup();
    t.replies.push(read("Good morning."));
    t.translate.mockImplementation(() => new Promise(() => {}));

    t.session.start();
    await advance(0);
    const changes = t.states.length;
    t.session.stop();
    await advance(IDLE_INTERVAL_MS * 3);

    expect(t.cancel).toHaveBeenCalledWith(t.translate.mock.calls[0][0]);
    expect(t.readFrame).toHaveBeenCalledOnce();
    expect(t.states).toHaveLength(changes);
  });

  it("ignores a read that finishes after it was stopped", async () => {
    const t = setup();
    let finish: (response: LiveFrameResponse) => void = () => {};
    t.readFrame.mockImplementation(() => new Promise((resolve) => (finish = resolve)));

    t.session.start();
    await advance(0);
    t.session.stop();
    finish(read("Good morning."));
    await advance(0);

    expect(t.translate).not.toHaveBeenCalled();
    expect(t.states).toHaveLength(0);
  });

  it("holds back the read that sets the thickness of the text", async () => {
    const t = setup();
    t.replies.push(read("Good morning.", false, 40));

    t.session.start();
    await advance(0);

    expect(t.readFrame).toHaveBeenCalledTimes(1);
    expect(t.translate).not.toHaveBeenCalled();
    expect(t.last()).toEqual({ status: "running", lines: [] });

    await advance(READ_INTERVAL_MS);
    expect(t.last()?.line).toMatchObject({
      original: "Good morning.",
      state: "ready",
    });
    t.session.stop();
  });

  it("learns from reads that find text, not from empty or unreadable ones", async () => {
    const t = setup();
    t.replies.push(
      read(""),
      read("%", false, 90),
      read("Good morning.", false, 40),
    );

    t.session.start();
    await advance(READ_INTERVAL_MS * 3);

    const asked = t.readFrame.mock.calls.map(([, minLineThickness]) => minLineThickness);
    expect(asked).toEqual([undefined, undefined, undefined, 40 * MIN_LINE_RATIO]);
    t.session.stop();
  });

  it("keeps the thickness it learned for the rest of the session", async () => {
    const t = setup();
    t.replies.push(read("Good morning.", false, 40));

    t.session.start();
    await advance(READ_INTERVAL_MS);
    t.replies.push(read("Good evening.", false, 100));
    await advance(READ_INTERVAL_MS * 3);

    const asked = t.readFrame.mock.calls
      .slice(1)
      .map(([, minLineThickness]) => minLineThickness);
    expect(new Set(asked)).toEqual(new Set([40 * MIN_LINE_RATIO]));
    t.session.stop();
  });
});
