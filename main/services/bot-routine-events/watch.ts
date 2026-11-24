// Watch routines (Bot wake sources step 3): a cheap check before the model.
//
// Every N minutes (5–1440) the watch runs its source (watch-sources.ts) and
// hashes the output's exact bytes. The first check stores a baseline and
// wakes no one. An unchanged hash records `no_change` and runs no model. A
// changed hash and a pending transition are saved together BEFORE dispatch.
// Recovery retries that same transition until the dispatcher durably owns it;
// its stable identity prevents a duplicate after a lost acknowledgement.
// A failed check is an error, never a change, and leaves the hash
// alone; three in a row turn the watch off with one Bot issue.
//
// Nothing is checked at startup beyond arming timers: a watch is checked once
// its persisted next-check time is due. A paused Bot is never checked.
//
// Like the dispatcher, watches are keyed by an owner key (a Bot's id for its
// routines), so other owners can reuse them with their own store.

import { createHash } from "node:crypto";
import { BOT_ROUTINE_EVENT_LIMITS, BOT_WATCH_LIMITS } from "../../../renderer/shared/bot-routine-trigger.js";
import type { EventRoutine, EventRoutineDispatcher, EventRoutineStore } from "./dispatcher.js";
import { BOT_WATCH_SNAPSHOT_CHARS, type BotEventRoutine, type BotEventRoutineStore, type BotWatchState } from "./store.js";
import type { BotWatchCheck } from "./watch-sources.js";

const DIFF_CHARS = 2_400;
const CONTEXT_LINES = 2;
/** Above this many old×new lines in the changed middle, the diff lists removed then added lines. */
const DIFF_CELLS = 250_000;

type Op = { kind: " " | "-" | "+"; line: string; oldNo: number; newNo: number };

function lineOps(before: string[], after: string[]): Op[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const ops: Op[] = [];
  for (let index = 0; index < start; index += 1) ops.push({ kind: " ", line: before[index]!, oldNo: index, newNo: index });
  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);
  if (a.length * b.length <= DIFF_CELLS) {
    // Longest common subsequence over the changed middle only.
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        table[i * width + j] = a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        ops.push({ kind: " ", line: a[i]!, oldNo: start + i, newNo: start + j });
        i += 1;
        j += 1;
      } else if (j < b.length && (i >= a.length || table[i * width + j + 1]! >= table[(i + 1) * width + j]!)) {
        ops.push({ kind: "+", line: b[j]!, oldNo: start + i, newNo: start + j });
        j += 1;
      } else {
        ops.push({ kind: "-", line: a[i]!, oldNo: start + i, newNo: start + j });
        i += 1;
      }
    }
  } else {
    a.forEach((line, index) => ops.push({ kind: "-", line, oldNo: start + index, newNo: start }));
    b.forEach((line, index) => ops.push({ kind: "+", line, oldNo: endBefore, newNo: start + index }));
  }
  for (let index = 0; index < before.length - endBefore; index += 1) {
    ops.push({ kind: " ", line: before[endBefore + index]!, oldNo: endBefore + index, newNo: endAfter + index });
  }
  return ops;
}

/**
 * A unified diff of two outputs, with two lines of context per hunk, cut at
 * whole lines to `maxChars` with a count of what was left out.
 */
export function botWatchDiff(before: string, after: string, maxChars = DIFF_CHARS): string {
  const ops = lineOps(before.split("\n"), after.split("\n"));
  const changed = ops.map((op, index) => (op.kind === " " ? -1 : index)).filter((index) => index >= 0);
  if (!changed.length) return "";
  // Group changes whose context overlaps into hunks.
  const hunks: Array<[number, number]> = [];
  for (const index of changed) {
    const from = Math.max(0, index - CONTEXT_LINES);
    const to = Math.min(ops.length - 1, index + CONTEXT_LINES);
    const last = hunks[hunks.length - 1];
    if (last && from <= last[1] + 1) last[1] = to;
    else hunks.push([from, to]);
  }
  const lines = ["--- before", "+++ now"];
  for (const [from, to] of hunks) {
    const slice = ops.slice(from, to + 1);
    const oldCount = slice.filter((op) => op.kind !== "+").length;
    const newCount = slice.filter((op) => op.kind !== "-").length;
    lines.push(`@@ -${slice[0]!.oldNo + 1},${oldCount} +${slice[0]!.newNo + 1},${newCount} @@`);
    for (const op of slice) lines.push(`${op.kind}${op.line}`);
  }
  let used = 0;
  const kept: string[] = [];
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  const left = lines.length - kept.length;
  if (left > 0) kept.push(`… ${left} more diff line${left === 1 ? "" : "s"}`);
  return kept.join("\n");
}

/** The event the Bot sees: what changed, then the new output (trimmed), within the event payload bound. */
export function botWatchEventPayload(before: string, after: string): string {
  const diff = botWatchDiff(before, after);
  const header = "Now:\n";
  const room = BOT_ROUTINE_EVENT_LIMITS.payloadChars - diff.length - header.length - 4;
  const trimmed = after.trim();
  const shown = [...trimmed].length > room ? `${[...trimmed].slice(0, Math.max(0, room - 1)).join("")}…` : trimmed;
  return [diff, `${header}${shown || "(empty)"}`].filter(Boolean).join("\n\n");
}

export function botWatchHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface EventWatchDependencies<R extends EventRoutine> {
  /** The owner a routine belongs to: the key its store, dispatcher and pause state use. */
  ownerKey(routine: R): string;
  routines(): Promise<R[]>;
  store: EventRoutineStore<R>;
  /** Runs the routine's source once (watch-sources.ts in production). */
  check(routine: R, signal: AbortSignal): Promise<BotWatchCheck>;
  dispatcher: Pick<EventRoutineDispatcher<R>, "emit">;
  /** Re-admit the source's current authority before delivering saved output, without running the source. */
  authorizeDispatch?(routine: R): Promise<{ signal: AbortSignal; release(): void } | { error: string }>;
  isPaused(ownerKey: string): Promise<boolean>;
  /** Three failed checks in a row turned the watch off: one card for the person. */
  paused(routine: R, error: string): Promise<void>;
  /** A check worked again after a failure: a card for it is fixed. */
  recovered(routine: R): Promise<void>;
  now(): number;
  setTimer(fn: () => void, ms: number): { cancel(): void };
  onError?(error: unknown): void;
  /** A check's result was saved: what the owner's view shows has changed. */
  checked?(routine: R): void;
  /**
   * True when what the check prints is itself the news (a chat task's script
   * watch): empty output means nothing to report, and any other output is
   * handed on as it is, with no baseline and no diff.
   */
  reportsOutput?(routine: R): boolean;
}

/** A Bot's watches: the owner key is the Bot id. */
export interface BotWatchDependencies
  extends Omit<EventWatchDependencies<BotEventRoutine>, "ownerKey" | "store" | "dispatcher"> {
  store: Pick<BotEventRoutineStore, "list" | "mutate">;
  dispatcher: Pick<EventRoutineDispatcher<BotEventRoutine>, "emit">;
}

export type BotWatchOutcome = "baseline" | "no_change" | "changed" | "error" | "paused" | "skipped";

const intervalMs = (routine: EventRoutine) =>
  routine.trigger.kind === "watch" ? routine.trigger.everyMinutes * 60_000 : 0;

export function createBotWatches(dependencies: BotWatchDependencies) {
  return createEventWatches<BotEventRoutine>({ ...dependencies, ownerKey: (routine) => routine.botId });
}

export function createEventWatches<R extends EventRoutine>(dependencies: EventWatchDependencies<R>) {
  const ownerOf = (routine: R) => dependencies.ownerKey(routine);
  const timers = new Map<string, { key: string; timer: { cancel(): void } }>();
  const checkWork = new Set<Promise<BotWatchOutcome>>();
  const inFlight = new Map<string, { revision: number; abort: AbortController }>();
  let generation = 0;
  let disposed = false;
  const live = (epoch: number) => !disposed && generation === epoch;

  const keyOf = (routine: R, at: number) => `${JSON.stringify(routine.trigger)}@${at}`;

  function arm(routine: R, at: number): void {
    if (disposed) return;
    const key = keyOf(routine, at);
    if (timers.get(routine.id)?.key === key) return;
    timers.get(routine.id)?.timer.cancel();
    timers.set(routine.id, {
      key,
      timer: dependencies.setTimer(() => {
        timers.delete(routine.id);
        void checkNow(ownerOf(routine), routine.id).catch((error: unknown) => dependencies.onError?.(error));
      }, Math.max(0, at - dependencies.now())),
    });
  }

  /** Arms the watch at its persisted next-check time; one without one keeps its timer or waits an interval. */
  function armDue(routine: R): void {
    if (disposed) return;
    if (routine.watch?.pending) return arm(routine, routine.watch.pending.nextAttemptAt);
    const at = routine.watch?.nextCheckAt;
    if (at !== undefined) return arm(routine, at);
    if (timers.get(routine.id)?.key.startsWith(`${JSON.stringify(routine.trigger)}@`)) return;
    arm(routine, dependencies.now() + intervalMs(routine));
  }

  async function current(ownerKey: string, id: string): Promise<R | undefined> {
    return (await dependencies.store.list(ownerKey)).find((routine) => routine.id === id);
  }

  /** Only discard a transition after durable dispatcher ownership/suppression. */
  async function deliverPending(routine: R, epoch: number): Promise<boolean> {
    const pending = routine.watch?.pending;
    if (!pending || !live(epoch)) return false;
    let accepted = false;
    let grant: { signal: AbortSignal; release(): void } | undefined;
    try {
      const admitted = await dependencies.authorizeDispatch?.(routine);
      if (admitted && "error" in admitted) {
        const paused = await dependencies.store.mutate(ownerOf(routine), routine.id, (fresh) => {
          if (!live(epoch) || !fresh.enabled || fresh.watch?.pending?.eventId !== pending.eventId ||
            fresh.updatedAt !== pending.revision) return { result: undefined };
          const next = { ...fresh, enabled: false, watch: { ...fresh.watch, lastResult: "error" as const,
            failures: fresh.watch.failures + 1, unsettledFailure: true as const, lastError: admitted.error.slice(0, 200) } };
          return { next, result: next };
        });
        if (paused && live(epoch)) await dependencies.paused(paused, admitted.error);
        return false;
      }
      grant = admitted;
      if (!live(epoch) || grant?.signal.aborted) return false;
      const result = await dependencies.dispatcher.emit(ownerOf(routine), routine.id, {
        eventId: pending.eventId, payload: pending.payload, watchRevision: pending.revision,
        isCurrent: () => live(epoch) && !grant?.signal.aborted,
      });
      accepted = result === "queued" || result === "held" || result === "duplicate" || result === "daily_limit";
    } catch (error) {
      dependencies.onError?.(error);
    } finally {
      grant?.release();
    }
    if (!live(epoch)) return false;
    return await dependencies.store.mutate(ownerOf(routine), routine.id, (fresh) => {
      if (!live(epoch) || !fresh.watch?.pending || fresh.watch.pending.eventId !== pending.eventId ||
            fresh.watch.pending.revision !== pending.revision) return { result: false };
      const { pending: _pending, ...watch } = fresh.watch;
      const { lastError: _lastError, unsettledFailure: _unsettled, ...healthy } = watch;
      const healthUnchanged = fresh.enabled && watch.failures === routine.watch?.failures &&
        watch.lastError === routine.watch?.lastError && watch.unsettledFailure === routine.watch?.unsettledFailure;
      return {
        next: { ...fresh, watch: accepted ? (healthUnchanged ? { ...healthy, failures: 0, lastResult: "changed" } : watch) :
          { ...watch, pending: { ...pending, nextAttemptAt: dependencies.now() + 60_000 } } },
        result: accepted && healthUnchanged,
      };
    }) === true;
  }

  /** One check of one watch; exported for tests and for the timer. */
  async function performCheckNow(ownerKey: string, id: string): Promise<BotWatchOutcome> {
    if (disposed || inFlight.has(id)) return "skipped";
    const epoch = generation;
    const abort = new AbortController();
    inFlight.set(id, { revision: -1, abort });
    let sourcePublication:import("./watch-sources.js").BotWatchPublication|undefined;
    try {
      const routine = await current(ownerKey, id);
      if (!live(epoch) || !routine || !routine.enabled || routine.trigger.kind !== "watch") return "skipped";
      inFlight.set(id, { revision: routine.updatedAt, abort });
      const triggerKey = JSON.stringify(routine.trigger);
      const every = intervalMs(routine);
      if (await dependencies.isPaused(ownerKey)) {
        // No check while the Bot is paused; look again one interval later.
        const at = dependencies.now() + every;
        const next = await dependencies.store.mutate(ownerKey, id, (fresh) =>
          !live(epoch) || fresh.updatedAt !== routine.updatedAt || JSON.stringify(fresh.trigger) !== triggerKey
            ? { result: undefined }
            : { next: { ...fresh, watch: { ...(fresh.watch ?? { failures: 0 }), nextCheckAt: at,
              ...(fresh.watch?.pending ? { pending: { ...fresh.watch.pending, nextAttemptAt: at } } : {}) } }, result: fresh });
        if (next && live(epoch)) arm(next, at);
        return "skipped";
      }
      if (!live(epoch)) return "skipped";
      if (routine.watch?.pending) {
        const delivered = await deliverPending(routine, epoch);
        if (delivered && (routine.watch.unsettledFailure || routine.watch.failures > 0)) await dependencies.recovered(routine);
        return "changed";
      }
      const checkedAt = dependencies.now();
      let check: BotWatchCheck;
      try {
        check = await dependencies.check(routine, abort.signal);
        if(check.ok)sourcePublication=check.publication;
      } catch {
        check = { ok: false, error: "The check couldn't run." };
      }
      if (!live(epoch) || abort.signal.aborted || await dependencies.isPaused(ownerKey)) return "skipped";
      if (!check.ok && check.skipped) return "skipped";
      const nextCheckAt = checkedAt + every;
      type Decision = { outcome: BotWatchOutcome; routine: R; hadFailure: boolean };
      const decision = await dependencies.store.mutate<Decision | undefined>(ownerKey, id, (fresh) => {
        // Edited, removed or turned off while the check ran: its result is stale.
        if (!live(epoch) || abort.signal.aborted || !fresh.enabled || fresh.updatedAt !== routine.updatedAt ||
          JSON.stringify(fresh.trigger) !== triggerKey) return { result: undefined };
        const state: BotWatchState = fresh.watch ?? { failures: 0 };
        const hadFailure = state.failures > 0 || state.lastResult === "error" || state.unsettledFailure === true;
        if (!check.ok) {
          const failures = state.failures + 1;
          const pause = check.pause === true || failures >= BOT_WATCH_LIMITS.failuresBeforePause;
          const watch: BotWatchState = { ...state, failures, lastError: check.error.slice(0, 200), lastResult: "error", lastCheckAt: checkedAt, nextCheckAt };
          const next: R = { ...fresh, watch, ...(pause ? { enabled: false } : {}) };
          return { next, result: { outcome: pause ? "paused" : "error", routine: next, hadFailure } };
        }
        if (check.connector) {
          const semantic = check.connector;
          const hash = botWatchHash(check.bytes);
          const { lastError: _error, unsettledFailure: _failure, pending: _oldPending, ...rest } = state;
          const watch: BotWatchState = { ...rest, failures: 0, hash, connectorBaseline: semantic.baseline,
            connectorItemCount: semantic.itemCount, lastCheckAt: checkedAt, nextCheckAt };
          // A Bot's Composio calendar reports what's already ahead on its first
          // check. Chat tasks keep their source in `connectorSource`, not
          // `connector`, so they never take this exception: a task's first
          // check always only records a baseline (deliberate; see
          // docs/scheduled-task-triggers.md).
          if (semantic.changeCount === 0 || !state.connectorBaseline && fresh.connector?.binding.adapter !== "composio-calendar-v1") {
            const outcome = state.connectorBaseline ? "no_change" as const : "baseline" as const;
            return { next: { ...fresh, watch: { ...watch, lastResult: outcome } }, result: { outcome, routine: { ...fresh, watch }, hadFailure } };
          }
          const pending = { eventId: `${hash.slice(0, 24)}-${checkedAt.toString(36)}`, payload: semantic.payload,
            revision: fresh.updatedAt, nextAttemptAt: checkedAt };
          const next = { ...fresh, watch: { ...watch, pending, sameSince: checkedAt, lastResult: "changed" as const } };
          return { next, result: { outcome: "changed", routine: next, hadFailure } };
        }
        const hash = botWatchHash(check.bytes);
        const text = new TextDecoder("utf-8", { fatal: false }).decode(check.bytes);
        const snapshot = text.slice(0, BOT_WATCH_SNAPSHOT_CHARS);
        const { lastError: _lastError, unsettledFailure: _unsettled, ...rest } = state;
        const base: BotWatchState = { ...rest, failures: 0, lastCheckAt: checkedAt, nextCheckAt };
        if (dependencies.reportsOutput?.(fresh)) {
          const said = text.trim();
          if (!said) {
            const next = { ...fresh, watch: { ...base, lastResult: "no_change" as const } };
            return { next, result: { outcome: "no_change", routine: next, hadFailure } };
          }
          const room = BOT_ROUTINE_EVENT_LIMITS.payloadChars;
          const payload = [...said].length > room ? `${[...said].slice(0, room - 1).join("")}…` : said;
          const pending = { eventId: `${hash.slice(0, 24)}-${checkedAt.toString(36)}`, payload, revision: fresh.updatedAt, nextAttemptAt: checkedAt };
          const next = { ...fresh, watch: { ...base, hash, pending, sameSince: checkedAt, lastResult: "changed" as const } };
          return { next, result: { outcome: "changed", routine: next, hadFailure } };
        }
        if (!state.hash) {
          const next = { ...fresh, watch: { ...base, hash, snapshot, sameSince: checkedAt, lastResult: "baseline" as const } };
          return { next, result: { outcome: "baseline", routine: next, hadFailure } };
        }
        if (state.hash === hash) {
          const next = { ...fresh, watch: { ...base, lastResult: "no_change" as const } };
          return { next, result: { outcome: "no_change", routine: next, hadFailure } };
        }
        const pending = {
          eventId: `${hash.slice(0, 24)}-${checkedAt.toString(36)}`,
          payload: botWatchEventPayload(state.snapshot ?? "", text),
          revision: fresh.updatedAt,
          nextAttemptAt: checkedAt,
        };
        const next = { ...fresh, watch: { ...base, hash, snapshot, pending, sameSince: checkedAt, lastResult: "changed" as const } };
        return { next, result: { outcome: "changed", routine: next, hadFailure } };
      },sourcePublication?.guard);
      if (!decision || !live(epoch)) return "skipped";
      const delivered = decision.outcome !== "changed" || await deliverPending(decision.routine, epoch);
      if (decision.outcome === "paused") {
        await dependencies.paused(decision.routine, decision.routine.watch?.lastError ?? "").catch((error: unknown) => dependencies.onError?.(error));
      } else if (delivered && decision.outcome !== "error" && decision.hadFailure) {
        const fresh = await current(ownerKey, id);
        if (fresh?.enabled && fresh.watch?.failures === 0 && !fresh.watch.unsettledFailure) {
          await dependencies.recovered(fresh).catch((error: unknown) => dependencies.onError?.(error));
        }
      }
      dependencies.checked?.(await current(ownerKey, id) ?? decision.routine);
      return decision.outcome;
    } finally {
      sourcePublication?.release();
      inFlight.delete(id);
      // A rearm skipped this watch while it was checking (an edit, say): arm it now.
      if (live(epoch)) {
        const fresh = await current(ownerKey, id).catch(() => undefined);
        if (live(epoch) && fresh?.enabled && fresh.trigger.kind === "watch") armDue(fresh);
      }
    }
  }

  function checkNow(ownerKey: string, id: string): Promise<BotWatchOutcome> {
    const work = performCheckNow(ownerKey, id);
    checkWork.add(work);
    void work.then(() => checkWork.delete(work), () => checkWork.delete(work));
    return work;
  }

  let rearming: Promise<void> = Promise.resolve();

  async function rearmOnce(epoch: number): Promise<void> {
    const wanted = new Map<string, R>();
    for (const routine of await dependencies.routines()) {
      if (routine.enabled && routine.trigger.kind === "watch") wanted.set(routine.id, routine);
    }
    if (!live(epoch)) return;
    for (const [id, flight] of inFlight) {
      const routine = wanted.get(id);
      if (!routine || (flight.revision !== -1 && routine.updatedAt !== flight.revision)) flight.abort.abort();
    }
    for (const [id, entry] of timers) {
      if (!wanted.has(id)) {
        entry.timer.cancel();
        timers.delete(id);
      }
    }
    for (const routine of wanted.values()) {
      if (inFlight.has(routine.id)) continue;
      armDue(routine);
    }
  }

  return {
    checkNow,
    /** Checks already started, including their durable hand-offs, have settled. */
    async idle(): Promise<void> { while (checkWork.size) await Promise.allSettled([...checkWork]); },
    /** Serialized: arms one timer per enabled watch at its persisted next-check time; never checks by itself. */
    rearm(): Promise<void> {
      const epoch = generation;
      const next = rearming.catch(() => undefined).then(() => rearmOnce(epoch));
      rearming = next;
      return next;
    },
    dispose(): void {
      disposed = true;
      generation += 1;
      for (const flight of inFlight.values()) flight.abort.abort();
      for (const entry of timers.values()) entry.timer.cancel();
      timers.clear();
    },
    resume(): void { disposed = false; },
  };
}

export type EventWatches<R extends EventRoutine> = ReturnType<typeof createEventWatches<R>>;
export type BotWatches = EventWatches<BotEventRoutine>;
