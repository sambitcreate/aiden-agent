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
//
// The host run registry is bounded and evicts its oldest run, even a live one,
// when it is full. An evicted run never reports its end, so the chat instead
// checks back every minute until it is no longer busy, and only then starts
// its full quiet window.

/** How long a chat must stay quiet before its opted-in jobs stop. */
export const CHAT_SETTLE_STOP_MS = 20 * 60_000;
/** How often a chat whose running answer was evicted from the run registry checks whether it is still busy. */
export const CHAT_SETTLE_EVICTED_CHECK_MS = 60_000;

/** The parts of a host run registry change the settlement reads. */
export interface ChatSettlementRunChange {
  chatId: string;
  runId: string;
  state: string;
}

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
  evictedCheckMs?: number;
  log?: (message: string, error?: unknown) => void;
}

export class ChatSettlement {
  /** Answers running in each chat, by run id. */
  private readonly activeRuns = new Map<string, Set<string>>();
  /** Chats with an answer the run registry dropped while it was running, so its end will never be reported. */
  private readonly evicted = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly quietMs: number;
  private readonly evictedCheckMs: number;
  private closed = false;

  constructor(private readonly options: ChatSettlementOptions) {
    this.quietMs = options.quietMs ?? CHAT_SETTLE_STOP_MS;
    this.evictedCheckMs = options.evictedCheckMs ?? CHAT_SETTLE_EVICTED_CHECK_MS;
  }

  /**
   * A change from the host run registry: a live run started (or is still
   * running), a run ended, or the registry dropped a run. A dropped run that
   * had ended changes nothing; one dropped while running was evicted at
   * capacity and will never report its end.
   */
  hostRunChanged(run: ChatSettlementRunChange, removed: boolean): void {
    const terminal = run.state === "done" || run.state === "failed" || run.state === "cancelled";
    if (!removed) {
      if (terminal) this.runEnded(run.chatId, run.runId);
      else this.runStarted(run.chatId, run.runId);
    } else if (!terminal) {
      this.runEvicted(run.chatId, run.runId);
    }
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

  /**
   * The run registry dropped a running answer to make room. Its end will never
   * be reported, so the chat waits until it is no longer busy before its quiet
   * window starts.
   */
  runEvicted(chatId: string, runId: string): void {
    if (this.closed) return;
    const runs = this.activeRuns.get(chatId);
    runs?.delete(runId);
    if (runs && runs.size === 0) this.activeRuns.delete(chatId);
    this.evicted.add(chatId);
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
    this.evicted.delete(chatId);
  }

  /** Aiden is quitting: nothing more is stopped for being quiet. */
  shutdown(): void {
    this.closed = true;
    for (const chatId of [...this.timers.keys()]) this.cancel(chatId);
    this.activeRuns.clear();
    this.evicted.clear();
  }

  private arm(chatId: string): void {
    this.cancel(chatId);
    if (this.closed || this.activeRuns.has(chatId) || !this.options.hasStoppableJobs(chatId)) return;
    const timer = this.evicted.has(chatId)
      ? setTimeout(() => this.checkEvicted(chatId), this.evictedCheckMs)
      : setTimeout(() => this.fire(chatId), this.quietMs);
    timer.unref?.();
    this.timers.set(chatId, timer);
  }

  private cancel(chatId: string): void {
    const timer = this.timers.get(chatId);
    if (timer) clearTimeout(timer);
    this.timers.delete(chatId);
  }

  /** An evicted answer may still be running: once the chat is no longer busy, its full quiet window starts. */
  private checkEvicted(chatId: string): void {
    this.timers.delete(chatId);
    if (this.closed || this.activeRuns.has(chatId)) return;
    if (!this.options.isChatBusy(chatId)) this.evicted.delete(chatId);
    this.arm(chatId);
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
