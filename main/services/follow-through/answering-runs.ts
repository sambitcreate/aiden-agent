// When each chat was answering, so a pull request comment the viewer posted
// while the chat's own answer ran is read as the agent's echo rather than new
// work from the person.
//
// A running answer counts from its start, with no end yet. Its end closes a
// window kept for two days. The host run registry is bounded and evicts its
// oldest run, even a live one, when it is full; an evicted run never reports
// its end. Its answer may still be running and posting comments, so it keeps
// counting until the chat is no longer busy (checked every minute), and only
// then closes at that moment.

const SLACK_MS = 60_000;
const KEEP_MS = 2 * 24 * 60 * 60_000;
const MAX_WINDOWS_PER_CHAT = 50;
const MAX_ENDED_RUNS = 500;
/** How often a chat whose running answer was evicted checks whether it is still busy. */
export const EVICTED_ANSWER_CHECK_MS = 60_000;

/** The parts of a host run registry change this reads. */
export interface AnsweringRunChange {
  chatId: string;
  runId: string;
  state: string;
  startedAt: string;
  updatedAt: string;
}

export interface AnsweringRunsOptions {
  /** Whether the chat is still in use, with or without a run the registry knows. */
  isChatBusy: (chatId: string) => boolean;
  now?: () => number;
  evictedCheckMs?: number;
}

export class AnsweringRuns {
  /** Answers still running (or evicted and not yet idle), by run id. */
  private readonly running = new Map<string, { chatId: string; start: number }>();
  private readonly windows = new Map<string, Array<{ start: number; end: number }>>();
  private readonly ended = new Set<string>();
  private readonly evictedChecks = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;
  private readonly evictedCheckMs: number;

  constructor(private readonly options: AnsweringRunsOptions) {
    this.now = options.now ?? Date.now;
    this.evictedCheckMs = options.evictedCheckMs ?? EVICTED_ANSWER_CHECK_MS;
  }

  /** A change from the host run registry. */
  hostRunChanged(run: AnsweringRunChange, removed: boolean): void {
    const terminal = run.state === "done" || run.state === "failed" || run.state === "cancelled";
    if (removed) {
      if (!terminal) this.evicted(run.chatId, run.runId);
      return;
    }
    if (!terminal) {
      if (!this.running.has(run.runId)) {
        this.running.set(run.runId, { chatId: run.chatId, start: Date.parse(run.startedAt) || this.now() });
      }
      return;
    }
    if (this.ended.has(run.runId)) return;
    const start = this.running.get(run.runId)?.start ?? (Date.parse(run.startedAt) || this.now());
    this.close(run.chatId, run.runId, start, Date.parse(run.updatedAt) || this.now());
  }

  /** Whether the chat was answering at `at`, within a minute's slack. */
  wasAnswering(chatId: string, at: number): boolean {
    for (const run of this.running.values()) {
      if (run.chatId === chatId && at >= run.start - SLACK_MS) return true;
    }
    return (this.windows.get(chatId) ?? []).some(
      (window) => at >= window.start - SLACK_MS && at <= window.end + SLACK_MS,
    );
  }

  /** The chat was deleted: forget it. */
  deleteChat(chatId: string): void {
    this.windows.delete(chatId);
    for (const [runId, run] of this.running) {
      if (run.chatId === chatId) this.forget(runId);
    }
  }

  shutdown(): void {
    for (const runId of [...this.evictedChecks.keys()]) this.forget(runId);
  }

  private evicted(chatId: string, runId: string): void {
    if (this.ended.has(runId) || this.evictedChecks.has(runId)) return;
    if (!this.running.has(runId)) this.running.set(runId, { chatId, start: this.now() });
    this.scheduleEvictedCheck(chatId, runId);
  }

  private scheduleEvictedCheck(chatId: string, runId: string): void {
    const timer = setTimeout(() => {
      this.evictedChecks.delete(runId);
      const run = this.running.get(runId);
      if (!run) return;
      if (this.options.isChatBusy(chatId)) this.scheduleEvictedCheck(chatId, runId);
      else this.close(chatId, runId, run.start, this.now());
    }, this.evictedCheckMs);
    timer.unref?.();
    this.evictedChecks.set(runId, timer);
  }

  private close(chatId: string, runId: string, start: number, end: number): void {
    this.forget(runId);
    this.ended.add(runId);
    if (this.ended.size > MAX_ENDED_RUNS) this.ended.delete(this.ended.values().next().value!);
    const now = this.now();
    const windows = (this.windows.get(chatId) ?? []).filter((window) => window.end > now - KEEP_MS);
    windows.push({ start, end });
    this.windows.set(chatId, windows.slice(-MAX_WINDOWS_PER_CHAT));
  }

  private forget(runId: string): void {
    this.running.delete(runId);
    const timer = this.evictedChecks.get(runId);
    if (timer) clearTimeout(timer);
    this.evictedChecks.delete(runId);
  }
}
