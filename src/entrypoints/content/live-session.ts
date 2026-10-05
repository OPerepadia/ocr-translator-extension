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
  | "failed";

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
  /** What the region shows now. Absent while it holds no text. */
  line?: LiveLine;
  /** Set when status is "error". */
  error?: string;
}

export interface LiveSessionDeps {
  /** Capture the region and read its text. */
  readFrame(requestId: string): Promise<LiveFrameResponse>;
  translate(requestId: string, text: string): Promise<LiveTranslationResponse>;
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

interface CachedTranslation {
  translation: string;
  targetLang?: string;
}

/**
 * Reads a screen region over and over and keeps the translation of whatever
 * text it shows.
 *
 * Reading and translating run side by side. A translation that is still out
 * when the subtitle changes is dropped, and a line that was translated before
 * comes straight from the cache.
 */
export class LiveSession {
  private state: LiveState = { status: "starting" };
  // Replies from a loop that has since stopped are ignored by comparing this.
  private generation = 0;
  private stopped = false;
  private paused = false;
  private hasRead = false;
  private failedReads = 0;
  private unchangedReads = 0;
  private emptyReads = 0;
  private translationFailedAt = 0;
  private targetLang: string | undefined;
  private frameRequestId: string | undefined;
  private translationRequestId: string | undefined;
  private wakeUp: (() => void) | undefined;
  private readonly cache = new Map<string, CachedTranslation>();

  constructor(private readonly deps: LiveSessionDeps) {}

  get current(): LiveState {
    return this.state;
  }

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
      const response = await this.deps.readFrame(requestId);
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
      this.handleText(response.text);
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
    this.cancelTranslation();
    this.update({
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private handleText(raw: string): void {
    const text = raw.trim();
    if (!isReadable(text)) {
      this.emptyReads += 1;
      if (this.emptyReads >= EMPTY_READS_BEFORE_CLEAR && this.state.line) {
        this.cancelTranslation();
        this.update({ line: undefined });
      }
      return;
    }
    this.emptyReads = 0;

    const line = this.state.line;
    if (!line || !isSameLine(line.original, text)) {
      this.showLine(text);
      return;
    }
    if (
      line.state === "failed" &&
      this.deps.now() - this.translationFailedAt >= RETRY_TRANSLATION_MS
    ) {
      this.update({ line: { original: line.original, state: "pending" } });
      this.translateLine(line.original);
    }
  }

  private showLine(text: string): void {
    const cached = this.cache.get(comparisonKey(text));
    if (cached && cached.targetLang === this.targetLang) {
      this.cancelTranslation();
      this.update({
        line: { original: text, translation: cached.translation, state: "ready" },
      });
      return;
    }
    this.update({ line: { original: text, state: "pending" } });
    this.translateLine(text);
  }

  private translateLine(text: string): void {
    this.cancelTranslation();
    const requestId = this.deps.createId();
    this.translationRequestId = requestId;
    const isCurrentRequest = (): boolean =>
      this.translationRequestId === requestId;

    this.deps.translate(requestId, text).then(
      (response) => {
        if (isCurrentRequest()) {
          this.translationRequestId = undefined;
          this.applyTranslation(text, response);
        }
      },
      (error: unknown) => {
        if (isCurrentRequest()) {
          this.translationRequestId = undefined;
          this.markTranslationFailed(
            text,
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    );
  }

  private applyTranslation(
    text: string,
    { translation, translationStatus }: LiveTranslationResponse,
  ): void {
    const targetLang = translation?.targetLang ?? translationStatus.targetLang;
    if (targetLang) {
      this.targetLang = targetLang;
    }

    if (translation) {
      this.remember(text, { translation: translation.text, targetLang });
      this.update({
        line: { original: text, translation: translation.text, state: "ready" },
      });
    } else if (translationStatus.state === "same_language") {
      this.update({ line: { original: text, state: "same-language" } });
    } else {
      this.markTranslationFailed(text, translationStatus.reason);
    }
  }

  private markTranslationFailed(text: string, error?: string): void {
    this.translationFailedAt = this.deps.now();
    this.update({ line: { original: text, state: "failed", error } });
  }

  private remember(text: string, entry: CachedTranslation): void {
    const key = comparisonKey(text);
    this.cache.delete(key);
    this.cache.set(key, entry);
    if (this.cache.size > TRANSLATION_CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }

  private cancelTranslation(): void {
    if (this.translationRequestId) {
      this.deps.cancel(this.translationRequestId);
      this.translationRequestId = undefined;
    }
  }

  private cancelRequests(): void {
    this.cancelTranslation();
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
