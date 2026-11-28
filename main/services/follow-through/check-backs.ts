// Check-backs: a workspace chat's promise to look again later. During a turn
// the person started, the agent calls `check_back` ("in 20 minutes: see
// whether the deploy finished"); at that minute this service posts a
// "Checking back" notice into the same chat through `noticeDelivery`, which
// queues it into a running answer, wakes the idle chat (within the chat's
// hourly wake budget) or records it.
//
// Bounds: 1 minute to 24 hours ahead, 3 pending per chat and 20 in all, a note
// of at most 500 characters. One timer serves the soonest. Records live in the
// follow-through state file so a promise outlives a quit; nothing fires twice:
// a check-back is saved as `claimed` before its notice is posted, and one
// still `claimed` at the next launch becomes a record-only "Check-back
// interrupted (due …)" card. A notice the chat could not take (the save
// failed, the chat stayed held) goes back to pending and is tried again a
// minute later, 3 attempts in all; then it is logged and left as a
// record-only "Check-back not delivered" card. A deleted chat cancels it.
// Found up to 2 hours late (the computer slept, Aiden was closed), it still
// wakes the chat and says it is late; older ones leave a record-only card.

import { randomUUID } from "node:crypto";
import { agentNotice, type AgentNoticeV1 } from "../../../renderer/shared/agent-notices.js";
import {
  CHECK_BACK_LIMITS,
  checkBackClock,
  type CheckBackView,
} from "../../../renderer/shared/check-backs.js";
import { resolveWakeUpTime, WAKE_UP_INVALID_TIME_MESSAGE, type WakeUpWhen } from "../wake-up-time.js";
import type { AgentNoticeOutcome } from "./notice-delivery.js";
import { isRecord } from "../../shared/guards.js";

export type CheckBackState = "pending" | "claimed" | "fired" | "cancelled";

export interface CheckBackRecord {
  id: string;
  chatId: string;
  fireAt: number;
  note: string;
  setAt: number;
  /** The turn whose tool call set it. */
  setByTurnId?: string;
  state: CheckBackState;
  /** When it fired or was cancelled; finished records are kept a day, then pruned. */
  endedAt?: number;
  /** Deliveries the chat did not take (save failed, chat held); retried up to the limit. */
  attempts?: number;
  /** After a delivery the chat did not take: not tried again before this. */
  retryAt?: number;
}

export type CheckBackFailureCode = "invalid_time" | "invalid_note" | "too_many_pending" | "not_found" | "off";

export type CheckBackOutcome<T> =
  | ({ ok: true } & T)
  | { ok: false; code: CheckBackFailureCode; message: string; pending?: CheckBackView[] };

export interface CheckBackPost {
  chatId: string;
  notice: AgentNoticeV1;
  text: string;
  wake: boolean;
}

export interface CheckBacksDeps {
  /** Save every record (the follow-through state file). */
  persist(records: CheckBackRecord[]): void;
  /** Resolves once what `persist` was given is on disk. */
  flush?(): Promise<void>;
  /** Deliver a notice in order with the chat's other follow-ups. */
  post(post: CheckBackPost): Promise<AgentNoticeOutcome>;
  onChange(chatId: string): void;
  /** Settings → Scheduled tasks → "Let chats check back later", read at call time. */
  enabled(): boolean | Promise<boolean>;
  /** The zone `at` is read in and times are shown in: the host's. */
  timezone(): string;
  now(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  newId?(): string;
  log?(message: string, error?: unknown): void;
}

/** Later than this past its minute, a check-back that still fires says it is late. */
const LATE_AFTER_MS = 2 * 60_000;
/** Fired and cancelled records are kept this long for the record, then dropped. */
const FINISHED_RETENTION_MS = 24 * 60 * 60_000;
/**
 * The timer never waits longer than this: a check-back is at most a day out,
 * and an hourly recheck also recovers from a clock that jumped (a delay past
 * 2^31-1 ms would otherwise fire at once, again and again).
 */
const MAX_TIMER_MS = 60 * 60_000;
/** After reading the setting failed, try again this much later rather than at once. */
const RETRY_AFTER_FAILURE_MS = 60_000;
/** A delivery the chat did not take is tried again this much later. */
const RETRY_AFTER_DROP_MS = 60_000;
/** Deliveries a check-back gets before it is left as a not-delivered card. */
const MAX_DELIVERY_ATTEMPTS = 3;
/** Quitting waits at most this long for notices already going out. */
const SHUTDOWN_DRAIN_MS = 2_000;
const OFF_MESSAGE = "Check-backs are off in Settings → Scheduled tasks. Do the work now, or tell the person what to look at later.";

function view(record: CheckBackRecord): CheckBackView {
  return { id: record.id, fireAt: record.fireAt, note: record.note, setAt: record.setAt };
}

/** When a pending check-back is next due: its minute, or later after a dropped delivery. */
function dueAt(record: CheckBackRecord): number {
  return Math.max(record.fireAt, record.retryAt ?? 0);
}

function sentence(note: string): string {
  return /[.!?]$/u.test(note) ? note : `${note}.`;
}

/** One saved record, or undefined when it is not one this release wrote. */
export function parseCheckBackRecord(value: unknown): CheckBackRecord | undefined {
  if (!isRecord(value)) return undefined;
  const { id, chatId, fireAt, note, setAt, setByTurnId, state, endedAt, attempts, retryAt } = value;
  if (typeof id !== "string" || !id || typeof chatId !== "string" || !chatId) return undefined;
  if (typeof fireAt !== "number" || !Number.isFinite(fireAt) || typeof setAt !== "number" || !Number.isFinite(setAt)) return undefined;
  if (typeof note !== "string") return undefined;
  if (state !== "pending" && state !== "claimed" && state !== "fired" && state !== "cancelled") return undefined;
  return {
    id,
    chatId,
    fireAt,
    note: [...note].slice(0, CHECK_BACK_LIMITS.noteChars).join(""),
    setAt,
    ...(typeof setByTurnId === "string" ? { setByTurnId } : {}),
    state,
    ...(typeof endedAt === "number" && Number.isFinite(endedAt) ? { endedAt } : {}),
    ...(typeof attempts === "number" && Number.isSafeInteger(attempts) && attempts > 0 ? { attempts } : {}),
    ...(typeof retryAt === "number" && Number.isFinite(retryAt) ? { retryAt } : {}),
  };
}

export class CheckBacks {
  private records: CheckBackRecord[] = [];
  private timer: unknown;
  private stopped = false;
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Notices being posted right now; quitting waits briefly for them. */
  private readonly inFlight = new Set<Promise<void>>();
  /** Claimed records whose notice has been handed to `post`; too late to cancel. */
  private readonly posting = new Set<CheckBackRecord>();

  constructor(private readonly deps: CheckBacksDeps) {}

  /** Restores saved records at launch, turns interrupted fires into cards, and arms the timer. */
  restore(saved: readonly unknown[]): void {
    this.records = saved.flatMap((entry) => parseCheckBackRecord(entry) ?? []);
    const interrupted = this.records.filter((record) => record.state === "claimed");
    for (const record of interrupted) this.missed(record, "interrupted");
    if (interrupted.length) this.save();
    this.rearm();
  }

  /** Check-backs still waiting in a chat, soonest first. */
  list(chatId: string): CheckBackView[] {
    return this.pendingIn(chatId).map(view);
  }

  /** Every pending check-back (for wake-time planning). */
  pendingAll(): CheckBackView[] {
    return this.records.filter((record) => record.state === "pending").sort((a, b) => a.fireAt - b.fireAt).map(view);
  }

  set(chatId: string, input: { when: WakeUpWhen; note: string; turnId?: string }): Promise<CheckBackOutcome<{ checkBack: CheckBackView }>> {
    const note = input.note.trim();
    if (!note || [...note].length > CHECK_BACK_LIMITS.noteChars) {
      return Promise.resolve({
        ok: false,
        code: "invalid_note",
        message: `Write a note of 1 to ${CHECK_BACK_LIMITS.noteChars} characters saying what to look at when you check back.`,
      });
    }
    return this.serial(chatId, async () => {
      if (!(await this.deps.enabled())) return { ok: false, code: "off", message: OFF_MESSAGE };
      if (this.stopped) return { ok: false, code: "off", message: "Aiden is quitting." };
      // Nothing awaits from here to the push, so the caps hold across chats too.
      const at = this.deps.now();
      const resolved = resolveWakeUpTime(input.when, at, this.deps.timezone());
      if (!resolved) return { ok: false, code: "invalid_time", message: WAKE_UP_INVALID_TIME_MESSAGE };
      const pending = this.pendingIn(chatId);
      if (pending.length >= CHECK_BACK_LIMITS.maxPendingPerChat) {
        return {
          ok: false,
          code: "too_many_pending",
          message: `This chat already has ${pending.length} check-backs pending. Cancel one before setting another.`,
          pending: pending.map(view),
        };
      }
      const total = this.records.filter((record) => record.state === "pending").length;
      if (total >= CHECK_BACK_LIMITS.maxPendingTotal) {
        return {
          ok: false,
          code: "too_many_pending",
          message: `Aiden already has ${total} check-backs pending across your chats, the most it keeps. Cancel one in this chat or do the work now.`,
          pending: pending.map(view),
        };
      }
      const record: CheckBackRecord = {
        id: this.deps.newId?.() ?? `cb_${randomUUID().replace(/-/gu, "").slice(0, 12)}`,
        chatId,
        fireAt: resolved.fireAt,
        note,
        setAt: at,
        ...(input.turnId ? { setByTurnId: input.turnId } : {}),
        state: "pending",
      };
      this.records.push(record);
      this.save();
      this.deps.onChange(chatId);
      this.arm();
      return { ok: true, checkBack: view(record) };
    });
  }

  cancel(chatId: string, id: string): Promise<CheckBackOutcome<{ cancelled: CheckBackView }>> {
    return this.serial(chatId, async () => {
      const record = this.pendingIn(chatId).find((candidate) => candidate.id === id);
      if (!record) {
        return { ok: false, code: "not_found", message: "No pending check-back in this chat has that id.", pending: this.list(chatId) };
      }
      this.finish(record, "cancelled");
      this.save();
      this.deps.onChange(chatId);
      this.arm();
      return { ok: true, cancelled: view(record) };
    });
  }

  /**
   * The person turned check-backs off: every pending one is cancelled, and so
   * is one claimed whose notice has not gone out yet. Returns how many.
   */
  cancelAll(): number {
    const chats = new Set<string>();
    let count = 0;
    for (const record of this.records) {
      if (record.state !== "pending" && !(record.state === "claimed" && !this.posting.has(record))) continue;
      this.finish(record, "cancelled");
      chats.add(record.chatId);
      count += 1;
    }
    if (count) {
      this.save();
      for (const chatId of chats) this.deps.onChange(chatId);
    }
    this.arm();
    return count;
  }

  /** A deleted chat drops its check-backs, fired ones included. */
  deleteChat(chatId: string): void {
    const before = this.records.length;
    this.records = this.records.filter((record) => record.chatId !== chatId);
    if (this.records.length !== before) {
      this.save();
      this.arm();
    }
  }

  /** Startup, wake from sleep or unlock: fire what is due and arm for the next. */
  rearm(): void {
    if (this.stopped) return;
    void this.fireDue().catch((error: unknown) => {
      this.deps.log?.("Check-backs could not fire.", error);
      // Keep the promise: try again shortly instead of waiting for a resume or unlock.
      this.arm(RETRY_AFTER_FAILURE_MS);
    });
  }

  /**
   * Stop firing. Notices already going out get a moment to land, so the
   * final save records them as fired instead of leaving them claimed.
   */
  async shutdown(drainMs = SHUTDOWN_DRAIN_MS): Promise<void> {
    this.stopped = true;
    this.clear();
    if (this.inFlight.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, drainMs);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private pendingIn(chatId: string): CheckBackRecord[] {
    return this.records
      .filter((record) => record.chatId === chatId && record.state === "pending")
      .sort((a, b) => a.fireAt - b.fireAt);
  }

  private serial<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(chatId) ?? Promise.resolve()).then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(chatId, settled);
    void settled.then(() => {
      if (this.queues.get(chatId) === settled) this.queues.delete(chatId);
    });
    return run;
  }

  private finish(record: CheckBackRecord, state: "fired" | "cancelled"): void {
    record.state = state;
    record.endedAt = this.deps.now();
  }

  private save(): void {
    const cutoff = this.deps.now() - FINISHED_RETENTION_MS;
    this.records = this.records.filter(
      (record) => record.state === "pending" || record.state === "claimed" || (record.endedAt ?? 0) >= cutoff,
    );
    this.deps.persist(this.records.map((record) => ({ ...record })));
  }

  private clear(): void {
    if (this.timer === undefined) return;
    (this.deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = undefined;
  }

  private arm(minDelay = 0): void {
    this.clear();
    if (this.stopped) return;
    const next = this.records.filter((record) => record.state === "pending").sort((a, b) => dueAt(a) - dueAt(b))[0];
    if (!next) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(minDelay, dueAt(next) - this.deps.now()));
    const callback = () => {
      this.timer = undefined;
      this.rearm();
    };
    const setTimer = this.deps.setTimer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      (handle as { unref?: () => void }).unref?.();
      return handle;
    });
    this.timer = setTimer(callback, delay);
  }

  private async fireDue(): Promise<void> {
    if (!this.records.some((record) => record.state === "pending" && dueAt(record) <= this.deps.now())) {
      this.arm();
      return;
    }
    const enabled = await this.deps.enabled();
    if (this.stopped) return;
    const now = this.deps.now();
    const due = this.records.filter((record) => record.state === "pending" && dueAt(record) <= now).sort((a, b) => a.fireAt - b.fireAt);
    if (!enabled) {
      // Turned off while Aiden was closed: nothing the agent set fires after the person said no.
      this.cancelAll();
      return;
    }
    const deliveries: Array<{ record: CheckBackRecord; post: CheckBackPost }> = [];
    for (const record of due) {
      const late = now - record.fireAt;
      if (late > CHECK_BACK_LIMITS.lateWindowMs) {
        this.missed(record);
        continue;
      }
      // Claimed and saved before the notice goes out: a quit mid-delivery leaves a card, never a second fire.
      record.state = "claimed";
      deliveries.push({ record, post: this.firePost(record, now, late > LATE_AFTER_MS) });
    }
    this.save();
    for (const chatId of new Set(due.map((record) => record.chatId))) this.deps.onChange(chatId);
    this.arm();
    if (deliveries.length === 0) return;
    await this.deps.flush?.().catch((error: unknown) => this.deps.log?.("Check-backs could not be saved before firing.", error));
    // The switch may have been turned off, or the record cancelled, while the claim was saving.
    let stillOn: boolean;
    try {
      stillOn = await this.deps.enabled();
    } catch (error) {
      // Unsure: hand the claims back to pending and try again shortly.
      for (const { record } of deliveries) if (record.state === "claimed") record.state = "pending";
      this.save();
      throw error;
    }
    if (!stillOn) {
      this.cancelAll();
      return;
    }
    const going = deliveries.filter(({ record }) => record.state === "claimed");
    for (const { record } of going) this.posting.add(record);
    await Promise.all(
      going.map(({ record, post }) => {
        const delivery = (async () => {
          let outcome: AgentNoticeOutcome;
          try {
            outcome = await this.deps.post(post);
          } catch (error) {
            outcome = { kind: "dropped", reason: error instanceof Error ? error.message : String(error) };
          } finally {
            this.posting.delete(record);
          }
          if (record.state !== "claimed") return;
          this.settleDelivery(record, outcome);
        })();
        this.inFlight.add(delivery);
        return delivery.finally(() => this.inFlight.delete(delivery));
      }),
    );
  }

  /**
   * What a posted notice became: delivered or recorded is fired; a chat that
   * is gone cancels it; any other drop goes back to pending for another try a
   * minute later, until the attempts run out.
   */
  private settleDelivery(record: CheckBackRecord, outcome: AgentNoticeOutcome): void {
    if (outcome.kind !== "dropped") {
      this.finish(record, "fired");
    } else if (outcome.gone) {
      this.finish(record, "cancelled");
    } else {
      const attempts = (record.attempts ?? 0) + 1;
      record.attempts = attempts;
      if (attempts >= MAX_DELIVERY_ATTEMPTS) {
        this.deps.log?.(`A check-back notice was not delivered after ${attempts} attempts: ${outcome.reason}`);
        this.missed(record, "undelivered");
      } else {
        this.deps.log?.(`A check-back notice was not delivered and will be tried again: ${outcome.reason}`);
        record.state = "pending";
        record.retryAt = this.deps.now() + RETRY_AFTER_DROP_MS;
      }
    }
    this.save();
    this.deps.onChange(record.chatId);
    this.arm();
  }

  private firePost(record: CheckBackRecord, now: number, late: boolean): CheckBackPost {
    const zone = this.deps.timezone();
    const due = checkBackClock(record.fireAt, zone);
    const set = checkBackClock(record.setAt, zone);
    const current = checkBackClock(now, zone);
    const lateness = Math.round((now - record.fireAt) / 60_000);
    return {
      chatId: record.chatId,
      notice: agentNotice({
        source: "check_back",
        tone: "info",
        title: late ? `Checking back (due ${due})` : "Checking back",
        summary: record.note,
      }),
      text: [
        "[Aiden follow-up: check-back]",
        late
          ? `You said you would check back at ${due} (set at ${set}): ${sentence(record.note)} It is now ${current}, so this check-back is ${lateness} minutes late: the computer was asleep or Aiden was closed. Do what the note says if it still makes sense; if nothing is left to do, say so in one line.`
          : `You said you would check back at ${due} (set at ${set}): ${sentence(record.note)} It is now ${current}. Do what the note says; if nothing is left to do, say so in one line.`,
      ].join("\n\n"),
      wake: true,
    };
  }

  /**
   * A check-back that can no longer run: a record-only card, so the person and
   * the agent both see it. `interrupted` is one Aiden quit while delivering:
   * its notice may already be in the chat, so the agent checks before redoing.
   */
  private missed(record: CheckBackRecord, why: "missed" | "interrupted" | "undelivered" = "missed"): void {
    const zone = this.deps.timezone();
    const due = checkBackClock(record.fireAt, zone);
    this.finish(record, "fired");
    if (why === "undelivered") {
      void Promise.resolve(
        this.deps.post({
          chatId: record.chatId,
          notice: agentNotice({ source: "check_back", tone: "failure", title: `Check-back not delivered (due ${due})`, summary: record.note }),
          text: [
            "[Aiden follow-up: undelivered check-back]",
            `You said you would check back at ${due} (set at ${checkBackClock(record.setAt, zone)}): ${sentence(record.note)} Aiden tried ${MAX_DELIVERY_ATTEMPTS} times but could not deliver this check-back to the chat, so it did not happen. If it still matters, bring it up when the person next writes.`,
          ].join("\n\n"),
          wake: false,
        }),
      ).catch((error: unknown) => this.deps.log?.("An undelivered check-back card was not saved.", error));
      return;
    }
    if (why === "interrupted") {
      void Promise.resolve(
        this.deps.post({
          chatId: record.chatId,
          notice: agentNotice({ source: "check_back", tone: "info", title: `Check-back interrupted (due ${due})`, summary: record.note }),
          text: [
            "[Aiden follow-up: interrupted check-back]",
            `You said you would check back at ${due} (set at ${checkBackClock(record.setAt, zone)}): ${sentence(record.note)} Aiden quit while this check-back was being delivered, so it may not have finished. Look at the chat above before redoing anything; if it still matters, bring it up when the person next writes.`,
          ].join("\n\n"),
          wake: false,
        }),
      ).catch((error: unknown) => this.deps.log?.("An interrupted check-back card was not saved.", error));
      return;
    }
    void Promise.resolve(
      this.deps.post({
        chatId: record.chatId,
        notice: agentNotice({ source: "check_back", tone: "info", title: `Missed check-back (due ${due})`, summary: record.note }),
        text: [
          "[Aiden follow-up: missed check-back]",
          `You said you would check back at ${due} (set at ${checkBackClock(record.setAt, zone)}): ${sentence(record.note)} Aiden was not running or the computer was asleep then, so this check-back did not happen. If it still matters, bring it up when the person next writes.`,
        ].join("\n\n"),
        wake: false,
      }),
    ).catch((error: unknown) => this.deps.log?.("A missed check-back card was not saved.", error));
  }
}
