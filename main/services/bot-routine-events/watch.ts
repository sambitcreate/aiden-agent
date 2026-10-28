// Watch routines (Bot wake sources step 3): a cheap check before the model.
//
// Every N minutes (5–1440) the watch runs its source (watch-sources.ts) and
// hashes the output's exact bytes. The first check stores a baseline and
// wakes no one. An unchanged hash records `no_change` and runs no model. A
// changed hash is saved BEFORE the event goes to the dispatcher, so a run that
// fails or a quit never alerts twice; the event carries a bounded diff and the
// new output. A failed check is an error, never a change, and leaves the hash
// alone; three in a row turn the watch off with one Bot issue.
//
// Nothing is checked at startup beyond arming timers: a watch is checked once
// its persisted next-check time is due. A paused Bot is never checked.

import { createHash } from "node:crypto";
import { BOT_ROUTINE_EVENT_LIMITS, BOT_WATCH_LIMITS } from "../../../renderer/shared/bot-routine-trigger.js";
import type { BotRoutineEventDispatcher } from "./dispatcher.js";
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

export interface BotWatchDependencies {
  routines(): Promise<BotEventRoutine[]>;
  store: Pick<BotEventRoutineStore, "list" | "mutate">;
  /** Runs the routine's source once (watch-sources.ts in production). */
  check(routine: BotEventRoutine): Promise<BotWatchCheck>;
  dispatcher: Pick<BotRoutineEventDispatcher, "emit">;
  isPaused(botId: string): Promise<boolean>;
  /** Three failed checks in a row turned the watch off: one card for the person. */
  paused(routine: BotEventRoutine, error: string): Promise<void>;
  /** A check worked again after a failure: a card for it is fixed. */
  recovered(routine: BotEventRoutine): Promise<void>;
  now(): number;
  setTimer(fn: () => void, ms: number): { cancel(): void };
  onError?(error: unknown): void;
}

export type BotWatchOutcome = "baseline" | "no_change" | "changed" | "error" | "paused" | "skipped";

const intervalMs = (routine: BotEventRoutine) =>
  routine.trigger.kind === "watch" ? routine.trigger.everyMinutes * 60_000 : 0;

export function createBotWatches(dependencies: BotWatchDependencies) {
  const timers = new Map<string, { key: string; timer: { cancel(): void } }>();
  const inFlight = new Set<string>();

  const keyOf = (routine: BotEventRoutine, at: number) => `${JSON.stringify(routine.trigger)}@${at}`;

  function arm(routine: BotEventRoutine, at: number): void {
    const key = keyOf(routine, at);
    if (timers.get(routine.id)?.key === key) return;
    timers.get(routine.id)?.timer.cancel();
    timers.set(routine.id, {
      key,
      timer: dependencies.setTimer(() => {
        timers.delete(routine.id);
        void checkNow(routine.botId, routine.id).catch((error: unknown) => dependencies.onError?.(error));
      }, Math.max(0, at - dependencies.now())),
    });
  }

  /** Arms the watch at its persisted next-check time; one without one keeps its timer or waits an interval. */
  function armDue(routine: BotEventRoutine): void {
    const at = routine.watch?.nextCheckAt;
    if (at !== undefined) return arm(routine, at);
    if (timers.get(routine.id)?.key.startsWith(`${JSON.stringify(routine.trigger)}@`)) return;
    arm(routine, dependencies.now() + intervalMs(routine));
  }

  async function current(botId: string, id: string): Promise<BotEventRoutine | undefined> {
    return (await dependencies.store.list(botId)).find((routine) => routine.id === id);
  }

  /** One check of one watch; exported for tests and for the timer. */
  async function checkNow(botId: string, id: string): Promise<BotWatchOutcome> {
    if (inFlight.has(id)) return "skipped";
    inFlight.add(id);
    try {
      const routine = await current(botId, id);
      if (!routine || !routine.enabled || routine.trigger.kind !== "watch") return "skipped";
      const triggerKey = JSON.stringify(routine.trigger);
      const every = intervalMs(routine);
      if (await dependencies.isPaused(botId)) {
        // No check while the Bot is paused; look again one interval later.
        const at = dependencies.now() + every;
        const next = await dependencies.store.mutate(botId, id, (fresh) =>
          JSON.stringify(fresh.trigger) !== triggerKey
            ? { result: undefined }
            : { next: { ...fresh, watch: { ...(fresh.watch ?? { failures: 0 }), nextCheckAt: at } }, result: fresh });
        if (next) arm(next, at);
        return "skipped";
      }
      const checkedAt = dependencies.now();
      let check: BotWatchCheck;
      try {
        check = await dependencies.check(routine);
      } catch {
        check = { ok: false, error: "The check couldn't run." };
      }
      const nextCheckAt = checkedAt + every;
      type Decision = { outcome: BotWatchOutcome; routine: BotEventRoutine; before?: string; after?: string; hash?: string; hadFailure: boolean };
      const decision = await dependencies.store.mutate<Decision | undefined>(botId, id, (fresh) => {
        // Edited, removed or turned off while the check ran: its result is stale.
        if (!fresh.enabled || JSON.stringify(fresh.trigger) !== triggerKey) return { result: undefined };
        const state: BotWatchState = fresh.watch ?? { failures: 0 };
        const hadFailure = state.failures > 0 || state.lastResult === "error";
        if (!check.ok) {
          const failures = state.failures + 1;
          const pause = failures >= BOT_WATCH_LIMITS.failuresBeforePause;
          const watch: BotWatchState = { ...state, failures, lastError: check.error.slice(0, 200), lastResult: "error", lastCheckAt: checkedAt, nextCheckAt };
          const next: BotEventRoutine = { ...fresh, watch, ...(pause ? { enabled: false } : {}) };
          return { next, result: { outcome: pause ? "paused" : "error", routine: next, hadFailure } };
        }
        const hash = botWatchHash(check.bytes);
        const text = new TextDecoder("utf-8", { fatal: false }).decode(check.bytes);
        const snapshot = text.slice(0, BOT_WATCH_SNAPSHOT_CHARS);
        const { lastError: _lastError, ...rest } = state;
        const base: BotWatchState = { ...rest, failures: 0, lastCheckAt: checkedAt, nextCheckAt };
        if (!state.hash) {
          const next = { ...fresh, watch: { ...base, hash, snapshot, sameSince: checkedAt, lastResult: "baseline" as const } };
          return { next, result: { outcome: "baseline", routine: next, hadFailure } };
        }
        if (state.hash === hash) {
          const next = { ...fresh, watch: { ...base, lastResult: "no_change" as const } };
          return { next, result: { outcome: "no_change", routine: next, hadFailure } };
        }
        // The new hash is written here, before the event is dispatched.
        const next = { ...fresh, watch: { ...base, hash, snapshot, sameSince: checkedAt, lastResult: "changed" as const } };
        return { next, result: { outcome: "changed", routine: next, before: state.snapshot ?? "", after: text, hash, hadFailure } };
      });
      if (!decision) return "skipped";
      if (decision.outcome === "changed") {
        // The hash and the check time: a status that flips back
        // (passing → failing → passing) is a new event, not a duplicate.
        const eventId = `${decision.hash!.slice(0, 24)}-${checkedAt.toString(36)}`;
        await dependencies.dispatcher
          .emit(botId, id, { eventId, payload: botWatchEventPayload(decision.before ?? "", decision.after ?? "") })
          .catch((error: unknown) => dependencies.onError?.(error));
      }
      if (decision.outcome === "paused") {
        await dependencies.paused(decision.routine, decision.routine.watch?.lastError ?? "").catch((error: unknown) => dependencies.onError?.(error));
      } else if (decision.outcome !== "error" && decision.hadFailure) {
        await dependencies.recovered(decision.routine).catch((error: unknown) => dependencies.onError?.(error));
      }
      if (decision.routine.enabled) arm(decision.routine, nextCheckAt);
      return decision.outcome;
    } finally {
      inFlight.delete(id);
      // A rearm skipped this watch while it was checking (an edit, say): arm it now.
      if (!timers.has(id)) {
        const fresh = await current(botId, id).catch(() => undefined);
        if (fresh?.enabled && fresh.trigger.kind === "watch") armDue(fresh);
      }
    }
  }

  let rearming: Promise<void> = Promise.resolve();

  async function rearmOnce(): Promise<void> {
    const wanted = new Map<string, BotEventRoutine>();
    for (const routine of await dependencies.routines()) {
      if (routine.enabled && routine.trigger.kind === "watch") wanted.set(routine.id, routine);
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
    /** Serialized: arms one timer per enabled watch at its persisted next-check time; never checks by itself. */
    rearm(): Promise<void> {
      const next = rearming.catch(() => undefined).then(rearmOnce);
      rearming = next;
      return next;
    },
    dispose(): void {
      for (const entry of timers.values()) entry.timer.cancel();
      timers.clear();
    },
  };
}

export type BotWatches = ReturnType<typeof createBotWatches>;
