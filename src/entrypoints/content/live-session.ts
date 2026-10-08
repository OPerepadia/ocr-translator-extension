import type {
  LiveFrameResponse,
  LiveTranslationResponse,
} from "@/shared/messages";
import { comparisonKey, isReadable, isSameLine } from "./live-text";

export type LiveStatus = "starting" | "running" | "paused" | "error";

export type LiveTranslationState =
  | "pending"
  | "ready"
  | "same-language"
  | "failed"
  /** Dropped because newer lines needed the translator more. */
  | "skipped";

export interface LiveLine {
  /** The text as read from the screen. */
  original: string;
  translation?: string;
  state: LiveTranslationState;
  /** Why the translation failed. */
  error?: string;
}

export interface LiveState {
  status: LiveStatus;
  /** Every line read so far, oldest first. A line stays here after it leaves
   * the screen. */
  lines: LiveLine[];
  /** What the region shows now, which is always the last of `lines`. Absent
   * while the region holds no text. */
  line?: LiveLine;
  /** The languages of the latest translation. Absent until there is one. The
   * source is the one that was detected, so it can change between lines. */
  sourceLang?: string;
  targetLang?: string;
  /** Set when status is "error". */
  error?: string;
}

export interface LiveSessionDeps {
  /** Capture the region and read its text. Lines thinner than
   * `minLineThickness`, in CSS pixels, are left out. */
  readFrame(
    requestId: string,
    minLineThickness: number | undefined,
  ): Promise<LiveFrameResponse>;
  /** `context` holds the lines shown just before `text`, oldest first. */
  translate(
    requestId: string,
    text: string,
    context: string[],
  ): Promise<LiveTranslationResponse>;
  /** Abandon a request that is still running. */
  cancel(requestId: string): void;
  createId(): string;
  /** False while the tab cannot be captured, so nothing is read. */
  isVisible(): boolean;
  now(): number;
  onChange(state: LiveState): void;
}

// Time from the start of one read to the start of the next. Capturing the
// screen is rate limited, and a read takes about this long anyway.
export const READ_INTERVAL_MS = 600;
// While the region does not change (a paused video) there is little to read.
export const IDLE_INTERVAL_MS = 1500;
export const UNCHANGED_READS_BEFORE_IDLE = 3;
// A failed read is tried again after this long.
export const RETRY_INTERVAL_MS = 1500;
// Reads in a row that may fail before the session gives up.
export const MAX_FAILED_READS = 3;
// Reads in a row without text before the line on screen is cleared. One miss is
// usually recognition noise, not the end of the subtitle.
export const EMPTY_READS_BEFORE_CLEAR = 2;
// A line whose translation failed is translated again no sooner than this.
export const RETRY_TRANSLATION_MS = 5000;
export const TRANSLATION_CACHE_SIZE = 100;
// A line keeps translating after the next one shows, so that it gets filled in
// too. Past this many translations at once the oldest is dropped, so that a
// slow translator does not fall further and further behind.
export const MAX_TRANSLATIONS = 3;
// How many earlier lines go along with a line as context.
export const MAX_CONTEXT_LINES = 3;
// Lines further apart than this belong to different scenes, so an earlier one
// is no help in translating the next.
export const CONTEXT_GAP_MS = 5000;
// The region holds subtitles, so the thickness of the first text read in it is
// how thick the subtitles are. From then on, lines thinner than this share of
// the subtitles are the page's interface or a watermark, and are not read.
export const MIN_LINE_RATIO = 0.6;

interface CachedTranslation {
  translation: string;
  targetLang?: string;
}

/** A line that has been on screen, kept to give the lines after it context. */
interface ShownLine {
  /** Where it is in `LiveState.lines`. */
  index: number;
  text: string;
  firstSeenAt: number;
  lastSeenAt: number;
  /** The lines before it that it was translated with. */
  context: string[];
  /** The translation request that is still out for it. */
  requestId?: string;
  failedAt?: number;
}

/**
 * Reads a screen region over and over and keeps the translation of whatever
 * text it shows.
 *
 * Reading and translating run side by side, and a line keeps translating
 * after the subtitle changes. A line that was translated before comes straight
 * from the cache.
 */
export class LiveSession {
  private state: LiveState = { status: "starting", lines: [] };
  // Replies from a loop that has since stopped are ignored by comparing this.
  private generation = 0;
  private stopped = false;
  private paused = false;
  private hasRead = false;
  private failedReads = 0;
  private unchangedReads = 0;
  private emptyReads = 0;
  // Set once the thickness of the subtitles is known.
  private minLineThickness: number | undefined;
  private targetLang: string | undefined;
  private frameRequestId: string | undefined;
  private wakeUp: (() => void) | undefined;
  private readonly cache = new Map<string, CachedTranslation>();
  // Lines with a translation out, oldest request first.
  private readonly translating = new Set<ShownLine>();
  // The last of these is the line on screen, or the last one that was.
  private readonly history: ShownLine[] = [];

  constructor(private readonly deps: LiveSessionDeps) {}

  start(): void {
    void this.run(++this.generation);
  }

  pause(): void {
    if (this.paused || this.state.status === "error") {
      return;
    }
    this.paused = true;
    this.update({ status: "paused" });
  }

  resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    this.update({ status: this.hasRead ? "running" : "starting" });
    this.wake();
  }

  /** Read again now rather than at the next interval, for instance when the
   * tab becomes visible. */
  wake(): void {
    this.wakeUp?.();
  }

  /** Start over after the session gave up. */
  retry(): void {
    if (this.state.status !== "error" || this.stopped) {
      return;
    }
    this.failedReads = 0;
    this.unchangedReads = 0;
    this.update({
      status: this.paused ? "paused" : this.hasRead ? "running" : "starting",
      error: undefined,
    });
    this.start();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.cancelRequests();
    this.wake();
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  private async run(generation: number): Promise<void> {
    while (this.isCurrent(generation)) {
      if (this.paused || !this.deps.isVisible()) {
        await this.sleep(IDLE_INTERVAL_MS);
        continue;
      }

      const startedAt = this.deps.now();
      const outcome = await this.read(generation);
      if (!this.isCurrent(generation)) {
        return;
      }

      const interval =
        outcome === "failed"
          ? RETRY_INTERVAL_MS
          : this.unchangedReads >= UNCHANGED_READS_BEFORE_IDLE
            ? IDLE_INTERVAL_MS
            : READ_INTERVAL_MS;
      await this.sleep(Math.max(0, interval - (this.deps.now() - startedAt)));
    }
  }

  private async read(generation: number): Promise<"read" | "failed"> {
    const requestId = this.deps.createId();
    this.frameRequestId = requestId;
    try {
      const response = await this.deps.readFrame(
        requestId,
        this.minLineThickness,
      );
      if (!this.isCurrent(generation)) {
        return "read";
      }
      this.failedReads = 0;
      // A read that was already out when the user paused must not move the panel.
      if (response.status === "hidden" || this.paused) {
        this.unchangedReads += 1;
        return "read";
      }

      this.unchangedReads = response.unchanged ? this.unchangedReads + 1 : 0;
      this.hasRead = true;
      if (this.state.status === "starting") {
        this.update({ status: "running" });
      }
      this.handleText(response.text, response.lineThickness);
      return "read";
    } catch (error) {
      if (!this.isCurrent(generation)) {
        return "read";
      }
      this.failedReads += 1;
      if (this.failedReads >= MAX_FAILED_READS) {
        this.giveUp(error);
        return "read";
      }
      return "failed";
    } finally {
      if (this.frameRequestId === requestId) {
        this.frameRequestId = undefined;
      }
    }
  }

  private giveUp(error: unknown): void {
    this.generation += 1;
    this.update({
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private handleText(raw: string, lineThickness: number | undefined): void {
    const text = raw.trim();
    if (!isReadable(text)) {
      this.emptyReads += 1;
      if (this.emptyReads >= EMPTY_READS_BEFORE_CLEAR && this.state.line) {
        this.update({ line: undefined });
      }
      return;
    }
    this.emptyReads = 0;
    if (this.learnThickness(lineThickness)) {
      return;
    }

    const line = this.state.line;
    if (!line || !isSameLine(line.original, text)) {
      this.showLine(text);
      return;
    }
    const shown = this.history[this.history.length - 1];
    shown.lastSeenAt = this.deps.now();
    if (
      line.state === "failed" &&
      this.deps.now() - (shown.failedAt ?? 0) >= RETRY_TRANSLATION_MS
    ) {
      this.setLine(shown, { original: line.original, state: "pending" }, true);
      this.translateLine(shown, line.original);
    }
  }

  /**
   * Until the thickness of the subtitles is known, a read also picks up the
   * page's interface around them. The first read that finds text sets the
   * thickness. It is held back for that reason, and the read after it is the
   * first to show.
   *
   * Returns whether the read is held back. A read with no thickness cannot
   * teach anything, so it is shown and the filter stays at its floor.
   */
  private learnThickness(thickness: number | undefined): boolean {
    if (this.minLineThickness !== undefined || thickness === undefined) {
      return false;
    }
    this.minLineThickness = thickness * MIN_LINE_RATIO;
    return true;
  }

  private showLine(text: string): void {
    const shown = this.recordShown(text);
    if (shown.requestId) {
      // A line back on screen whose translation is still on the way.
      this.update({ line: this.state.lines[shown.index] });
      return;
    }
    const cached = this.cache.get(cacheKey(text, shown.context));
    if (cached && cached.targetLang === this.targetLang) {
      this.setLine(
        shown,
        { original: text, translation: cached.translation, state: "ready" },
        true,
      );
      return;
    }
    this.setLine(shown, { original: text, state: "pending" }, true);
    this.translateLine(shown, text);
  }

  /** Records `text` as the line on screen and returns its entry. A line that
   * comes straight back after the screen cleared is the same entry, so it keeps
   * the context it was first translated with. */
  private recordShown(text: string): ShownLine {
    const now = this.deps.now();
    const last = this.history[this.history.length - 1];
    if (last && isSameLine(last.text, text)) {
      last.lastSeenAt = now;
      return last;
    }

    const shown: ShownLine = {
      index: this.state.lines.length,
      text,
      firstSeenAt: now,
      lastSeenAt: now,
      context: this.contextBefore(now),
    };
    this.history.push(shown);
    if (this.history.length > MAX_CONTEXT_LINES + 1) {
      this.history.shift();
    }
    return shown;
  }

  /** The recent lines that run on into a line first seen at `time`. */
  private contextBefore(time: number): string[] {
    const context: string[] = [];
    let next = time;
    for (
      let index = this.history.length - 1;
      index >= 0 && context.length < MAX_CONTEXT_LINES;
      index -= 1
    ) {
      const earlier = this.history[index];
      if (next - earlier.lastSeenAt > CONTEXT_GAP_MS) {
        break;
      }
      context.unshift(earlier.text);
      next = earlier.firstSeenAt;
    }
    return context;
  }

  private translateLine(shown: ShownLine, text: string): void {
    if (this.translating.size >= MAX_TRANSLATIONS) {
      const [oldest] = this.translating;
      this.cancelTranslation(oldest);
      this.setLine(oldest, {
        original: this.state.lines[oldest.index].original,
        state: "skipped",
      });
    }

    const requestId = this.deps.createId();
    shown.requestId = requestId;
    this.translating.add(shown);
    // False when the request was cancelled, so its answer is dropped.
    const finish = (): boolean => {
      if (shown.requestId !== requestId) {
        return false;
      }
      shown.requestId = undefined;
      this.translating.delete(shown);
      return true;
    };

    this.deps.translate(requestId, text, shown.context).then(
      (response) => {
        if (finish()) {
          this.applyTranslation(shown, text, response);
        }
      },
      (error: unknown) => {
        if (finish()) {
          this.markTranslationFailed(
            shown,
            text,
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    );
  }

  private applyTranslation(
    shown: ShownLine,
    text: string,
    { translation, translationStatus }: LiveTranslationResponse,
  ): void {
    const targetLang = translation?.targetLang ?? translationStatus.targetLang;
    if (targetLang) {
      this.targetLang = targetLang;
    }
    // Shown along with the line below, which sends the update.
    const sourceLang = translation?.sourceLang ?? translationStatus.sourceLang;
    if (sourceLang || targetLang) {
      this.state = {
        ...this.state,
        sourceLang: sourceLang ?? this.state.sourceLang,
        targetLang: targetLang ?? this.state.targetLang,
      };
    }

    if (translation) {
      this.cacheTranslation(text, shown.context, {
        translation: translation.text,
        targetLang,
      });
      this.setLine(shown, {
        original: text,
        translation: translation.text,
        state: "ready",
      });
    } else if (translationStatus.state === "same_language") {
      this.setLine(shown, { original: text, state: "same-language" });
    } else {
      this.markTranslationFailed(shown, text, translationStatus.reason);
    }
  }

  private markTranslationFailed(
    shown: ShownLine,
    text: string,
    error?: string,
  ): void {
    shown.failedAt = this.deps.now();
    this.setLine(shown, { original: text, state: "failed", error });
  }

  /** Puts `line` in the list at the place of `shown`, adding it if `shown` was
   * just recorded. `show` makes it the line on screen. Without it, the line on
   * screen changes only if it is the same line. */
  private setLine(shown: ShownLine, line: LiveLine, show = false): void {
    const lines = [...this.state.lines];
    const onScreen =
      show || (this.state.line !== undefined && shown.index === lines.length - 1);
    lines[shown.index] = line;
    this.update(onScreen ? { lines, line } : { lines });
  }

  private cacheTranslation(
    text: string,
    context: string[],
    entry: CachedTranslation,
  ): void {
    const key = cacheKey(text, context);
    this.cache.delete(key);
    this.cache.set(key, entry);
    if (this.cache.size > TRANSLATION_CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }

  private cancelTranslation(shown: ShownLine): void {
    if (shown.requestId) {
      this.deps.cancel(shown.requestId);
      shown.requestId = undefined;
    }
    this.translating.delete(shown);
  }

  private cancelRequests(): void {
    for (const shown of this.translating) {
      this.cancelTranslation(shown);
    }
    if (this.frameRequestId) {
      this.deps.cancel(this.frameRequestId);
      this.frameRequestId = undefined;
    }
  }

  private update(patch: Partial<LiveState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onChange(this.state);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        if (this.wakeUp === done) {
          this.wakeUp = undefined;
        }
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakeUp = done;
    });
  }
}

// The same words can translate differently after different lines, so a cached
// translation only applies where the lines before it match too.
function cacheKey(text: string, context: string[]): string {
  return [...context, text].map(comparisonKey).join("\n");
}
