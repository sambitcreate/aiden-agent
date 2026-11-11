// Stop opted-in background jobs once their chat has gone quiet. The agent marks
// a job `stop_when_chat_settles` when it starts a dev server or watcher only to
// check its current work; without this, such jobs run until the chat is
// deleted or Aiden quits.
//
// A chat is settled when no answer is running and nothing is waiting to be
// answered. Each settle arms one quiet window per chat. A new answer cancels
// the window (its end arms a fresh one), and the person reading a job's output
// restarts it, since they are looking at it. Output the job writes by itself
// does not count: watchers and servers print all the time. When the window
// runs out, only the chat's running opted-in jobs stop, with `chat-settled`;
// every other job keeps running. Windows live only in memory: jobs never
// outlive a launch, so there is nothing to resume after a restart.

/** How long a chat must stay quiet before its opted-in jobs stop. */
export const CHAT_SETTLE_STOP_MS = 20 * 60_000;

export interface ChatSettlementOptions {
  /** Whether the chat has a running job that asked to stop once the chat settles. */
  hasStoppableJobs: (chatId: string) => boolean;
  /**
   * Whether the chat is still in use even with no answer running: a held
   * turn, subagents, or a follow-up message that may start an answer.
   */
  isChatBusy: (chatId: string) => boolean;
  /** Stop the chat's opted-in jobs with `chat-settled`. */
  stopSettled: (chatId: string) => Promise<unknown>;
  quietMs?: number;
  log?: (message: string, error?: unknown) => void;
}

export class ChatSettlement {
  /** Answers running in each chat, by run id. */
  private readonly activeRuns = new Map<string, Set<string>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly quietMs: number;
  private closed = false;

  constructor(private readonly options: ChatSettlementOptions) {
    this.quietMs = options.quietMs ?? CHAT_SETTLE_STOP_MS;
  }

  /** An answer started (or is still running): the chat is not quiet. */
  runStarted(chatId: string, runId: string): void {
    if (this.closed) return;
    const runs = this.activeRuns.get(chatId) ?? new Set<string>();
    runs.add(runId);
    this.activeRuns.set(chatId, runs);
    this.cancel(chatId);
  }

  /** An answer ended; once the chat's last one has, the quiet window starts. */
  runEnded(chatId: string, runId: string): void {
    const runs = this.activeRuns.get(chatId);
    runs?.delete(runId);
    if (runs && runs.size === 0) this.activeRuns.delete(chatId);
    this.arm(chatId);
  }

  /** The chat's jobs changed: a job started outside an answer arms a window, and none left to stop clears it. */
  jobsChanged(chatId: string): void {
    if (!this.options.hasStoppableJobs(chatId)) {
      this.cancel(chatId);
      return;
    }
    if (!this.timers.has(chatId)) this.arm(chatId);
  }

  /** The person looked at the chat's jobs: a running window starts over. */
  personActive(chatId: string): void {
    if (this.timers.has(chatId)) this.arm(chatId);
  }

  isArmed(chatId: string): boolean {
    return this.timers.has(chatId);
  }

  /** The chat was deleted, or its workspace closed: forget it. */
  clear(chatId: string): void {
    this.cancel(chatId);
    this.activeRuns.delete(chatId);
  }

  /** Aiden is quitting: nothing more is stopped for being quiet. */
  shutdown(): void {
    this.closed = true;
    for (const chatId of [...this.timers.keys()]) this.cancel(chatId);
    this.activeRuns.clear();
  }

  private arm(chatId: string): void {
    this.cancel(chatId);
    if (this.closed || this.activeRuns.has(chatId) || !this.options.hasStoppableJobs(chatId)) return;
    const timer = setTimeout(() => this.fire(chatId), this.quietMs);
    timer.unref?.();
    this.timers.set(chatId, timer);
  }

  private cancel(chatId: string): void {
    const timer = this.timers.get(chatId);
    if (timer) clearTimeout(timer);
    this.timers.delete(chatId);
  }

  private fire(chatId: string): void {
    this.timers.delete(chatId);
    if (this.closed || this.activeRuns.has(chatId)) return;
    if (this.options.isChatBusy(chatId)) {
      // Still in use without an answer showing as running: wait another window.
      this.arm(chatId);
      return;
    }
    void this.options
      .stopSettled(chatId)
      .catch((error: unknown) => this.options.log?.("Background jobs could not be stopped after the chat went quiet.", error))
      // A job whose stop could not be confirmed is still running: try again after another window.
      .then(() => this.jobsChanged(chatId));
  }
}
