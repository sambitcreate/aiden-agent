/**
 * Who holds each daemon chat, and whether the daemon still takes new turns.
 * `ChatTurnAdmission` stays the owner of a lease's own lifecycle. This layer adds
 * what only the daemon knows: its intake, its chat capacity, and the generation a
 * lease hands off to. See docs/state-machines/serve-daemon.md.
 */
import type { ChatTurnAdmission, ChatTurnLease } from "../../../main/services/chat-turn-admission.js";
import type { GenerationCancellationOrigin } from "../../../renderer/shared/generation-timeline.js";

/**
 * - `lease`: a live reservation. It counts against capacity.
 * - `settling`: authority was revoked but admitted work still runs. It holds the
 *   chat and blocks shutdown, but takes no capacity because it can start nothing.
 * - `generation`: a registered run, until it has physically released its resources.
 * A chat with no custody is idle.
 */
export type DaemonChatCustody =
  | { readonly holder: "lease"; readonly preparation: "pending" | "settled" }
  | { readonly holder: "settling" }
  | { readonly holder: "generation" };

export type DaemonChatEvent =
  | { readonly type: "reserved" }
  | { readonly type: "preparation_settled" }
  | { readonly type: "lease_revoked" }
  | { readonly type: "generation_registered" }
  | { readonly type: "generation_released" };

/** `undefined` is idle. An event that does not apply leaves custody unchanged. */
export function transitionDaemonChat(custody: DaemonChatCustody | undefined, event: DaemonChatEvent): DaemonChatCustody | undefined {
  switch (event.type) {
    case "reserved":
      return custody ?? { holder: "lease", preparation: "pending" };
    case "preparation_settled":
      if (custody?.holder === "lease") return { holder: "lease", preparation: "settled" };
      return custody?.holder === "settling" ? undefined : custody;
    case "lease_revoked":
      if (custody?.holder !== "lease") return custody;
      return custody.preparation === "settled" ? undefined : { holder: "settling" };
    case "generation_registered":
      return custody?.holder === "lease" && custody.preparation === "settled" ? { holder: "generation" } : custody;
    case "generation_released":
      return custody?.holder === "generation" ? undefined : custody;
  }
}

/** Live reservations and generations share one limit. Settling work starts nothing. */
export const takesDaemonCapacity = (custody: DaemonChatCustody): boolean => custody.holder !== "settling";

/** How a turn's answer ended up on disk. A terminal event alone never proves this. */
export type DaemonGenerationPersistence = "none" | "final_saved" | "partial_saved" | "partial_lost";

/**
 * One registered generation. Stop request, persistence and physical release are
 * independent: a stopped run still owns its session until `settled` resolves.
 */
export class DaemonGenerationRun<Session extends { abort(): Promise<void> } = { abort(): Promise<void> }> {
  readonly abort = new AbortController();
  session?: Session;
  /** Set by the first stop that names one. A timeout or a lost owner names none. */
  cancellationOrigin?: GenerationCancellationOrigin;
  persistence: DaemonGenerationPersistence = "none";
  readonly settled: Promise<void>;
  private markSettled!: () => void;
  readonly streamId: string;
  readonly ownerId: string;
  readonly workspaceId?: string;

  constructor(identity: { streamId: string; ownerId: string; workspaceId?: string }) {
    this.streamId = identity.streamId;
    this.ownerId = identity.ownerId;
    this.workspaceId = identity.workspaceId;
    this.settled = new Promise((resolve) => { this.markSettled = resolve; });
  }

  get stopRequested(): boolean { return this.abort.signal.aborted; }

  /** Withdraws authority first, so any awaited check that resumes afterwards sees the stop. */
  async requestStop(origin?: GenerationCancellationOrigin): Promise<void> {
    if (origin && !this.stopRequested) this.cancellationOrigin ??= origin;
    this.abort.abort();
    await this.session?.abort();
  }

  /** For a caller with nowhere to report a failed session abort. */
  requestStopQuietly(origin?: GenerationCancellationOrigin): void { void this.requestStop(origin).catch(() => {}); }

  /** Physical release is complete. Only the turn owner calls this. */
  markReleased(): void { this.markSettled(); }
}

interface ChatEntry<Run> {
  custody: DaemonChatCustody;
  run?: Run;
}

export interface DaemonTurnOwnerOptions {
  admission: ChatTurnAdmission;
  /** Refuses a chat with an unfinished deletion. */
  isDeleting(chatId: string): boolean;
  maxChats?: number;
}

/** The single writer of daemon chat custody. Every busy, capacity and idle answer reads it. */
export class DaemonTurnOwner<Run extends { readonly streamId: string; readonly ownerId: string; readonly settled: Promise<void> }> {
  private readonly chats = new Map<string, ChatEntry<Run>>();
  private readonly idleWaiters = new Map<string, Set<() => void>>();
  private readonly options: DaemonTurnOwnerOptions;
  private intake: "open" | "closed" = "open";

  constructor(options: DaemonTurnOwnerOptions) { this.options = options; }

  get accepting(): boolean { return this.intake === "open"; }

  isBusy(chatId: string): boolean { return this.chats.has(chatId); }

  run(chatId: string): Run | undefined { return this.chats.get(chatId)?.run; }

  findRun(matches: (run: Run) => boolean): { chatId: string; run: Run } | undefined {
    for (const [chatId, { run }] of this.chats) if (run && matches(run)) return { chatId, run };
    return undefined;
  }

  private commit(chatId: string, entry: ChatEntry<Run>, event: DaemonChatEvent): void {
    // A lease that lost the chat to a newer entry keeps calling back; only the current entry moves.
    if (this.chats.get(chatId) !== entry) return;
    const next = transitionDaemonChat(entry.custody, event);
    if (next) { entry.custody = next; return; }
    this.chats.delete(chatId);
    this.wake(chatId);
  }

  private wake(chatId: string): void {
    const waiters = this.idleWaiters.get(chatId);
    this.idleWaiters.delete(chatId);
    for (const wake of waiters ?? []) wake();
  }

  private held(): number {
    let count = 0;
    for (const { custody } of this.chats.values()) if (takesDaemonCapacity(custody)) count += 1;
    return count;
  }

  begin(chatId: string, turnId: string, ownerId: string): ChatTurnLease | null {
    if (!this.accepting || this.options.isDeleting(chatId) || this.held() >= (this.options.maxChats ?? 3)) return null;
    const lease = this.options.admission.tryBegin(chatId, turnId, ownerId, this.run(chatId) !== undefined);
    if (!lease) return null;
    const entry: ChatEntry<Run> = { custody: transitionDaemonChat(undefined, { type: "reserved" })! };
    this.chats.set(chatId, entry);
    lease.onReleased(() => { this.commit(chatId, entry, { type: "lease_revoked" }); });
    const settle = lease.settleAsyncWork;
    lease.settleAsyncWork = (options) => {
      settle(options);
      this.commit(chatId, entry, { type: "preparation_settled" });
      // A settled lease may still hand off, but a waiter reads the new state itself.
      this.wake(chatId);
    };
    return lease;
  }

  /**
   * Registers `run` and releases the matching lease as one synchronous step, so
   * nothing can observe the chat as free between them. `register` runs inside it.
   */
  handoff(chatId: string, turnId: string, ownerId: string, run: Run, register: () => void): boolean {
    return this.options.admission.handoff(chatId, turnId, ownerId, () => {
      const entry = this.chats.get(chatId);
      if (!entry) throw new Error("The chat's reservation is unavailable.");
      this.commit(chatId, entry, { type: "generation_registered" });
      entry.run = run;
      register();
    });
  }

  /** Clears custody once `run` has physically released. A stale run changes nothing. */
  release(chatId: string, run: Run): boolean {
    const entry = this.chats.get(chatId);
    if (entry?.run !== run) return false;
    this.commit(chatId, entry, { type: "generation_released" });
    return true;
  }

  async waitForIdle(chatId: string): Promise<void> {
    while (this.isBusy(chatId)) {
      const running = this.run(chatId);
      if (running) await running.settled;
      else await new Promise<void>((resolve) => {
        const waiters = this.idleWaiters.get(chatId) ?? new Set();
        waiters.add(resolve); this.idleWaiters.set(chatId, waiters);
      });
    }
  }

  /**
   * Refuses every new turn from here on and returns each chat something still
   * holds, including revoked work that has not settled: all of it can write.
   */
  closeIntake(): string[] {
    this.intake = "closed";
    return [...this.chats.keys()];
  }
}
