// Every event goes through here (spec §6 P1): at most one run per routine every
// 5 minutes, at most 24 a day, a repeated event id is dropped, and an event
// that arrives too soon is held (the newest wins) and runs once the gap allows.
//
// The core is keyed by an owner key, not a Bot: a Bot's routines use its Bot
// id, and other owners (chat tasks, docs/plans/proactive-aiden-plan.md E1)
// reuse the same gap, dedupe, hold and replay rules with their own store.

import { BOT_ROUTINE_EVENT_LIMITS, type BotRoutineTriggerKind } from "../../../renderer/shared/bot-routine-trigger.js";
import { BOT_EVENT_RUNNING_MAX, type BotEventPublicationGuard, type BotEventRoutine, type BotEventRoutineStore, type BotEventExecutionSnapshot, type BotEventReceipt } from "./store.js";

export type BotRoutineEventOutcome = "queued" | "held" | "duplicate" | "daily_limit" | "disabled" | "unknown";
export interface BotRoutineEvent {
  eventId: string;
  payload: string;
  /** A watch hand-off must still be owed by this exact configuration. */
  watchRevision?: number;
  /** Live host authority only; never stored or accepted from a caller over IPC. */
  isCurrent?: () => boolean;
}

/** What the event core reads and writes on a routine; who owns it comes from `ownerKey`. */
export type EventRoutine = Omit<BotEventRoutine, "botId">;

/** One owner's routines, read and changed one at a time per owner key. */
export interface EventRoutineStore<R extends EventRoutine> {
  list(ownerKey: string): Promise<R[]>;
  mutate<T>(
    ownerKey: string,
    id: string,
    change: (routine: R, routines: readonly R[]) => { next?: R; result: T } | Promise<{ next?: R; result: T }>,
    guard?: BotEventPublicationGuard,
  ): Promise<T | undefined>;
}

export interface EventRoutineDispatcherDependencies<R extends EventRoutine> {
  /** The owner a routine belongs to: the key its store and pause state use. */
  ownerKey(routine: R): string;
  store: EventRoutineStore<R>;
  /**
   * Runs the routine once with this event; resolves when the run is recorded.
   * The same event may be run again after a restart: the run must read the
   * recorded run or the admitted turn by the event's id before sending.
   * `settled: false` (or a throw): the outcome is unknown, so the receipt
   * stays for the next start to replay.
   */
  run(routine: R, event: { eventId: string; source: BotRoutineTriggerKind; payload: string }, signal?: AbortSignal): Promise<{ settled: boolean } | void>;
  /** Original-choice comparison, without creating this event's execution claim. */
  prepareRoutineExecution?(routine: R): Promise<string>;
  /** Idempotent protected choice, after this event's payload is durable. */
  claimRoutineExecution?(routine: R, event: { eventId: string; source: BotRoutineTriggerKind; payload: string }, expectedChoiceHash?: string): Promise<unknown>;
  claimFailed?(routine: R, error: unknown): Promise<void>;
  claimRecovered?(routine: R): Promise<void>;
  /** Re-admit watch source access at actual startup, including held/replayed work. */
  authorizeRun?(routine: R): Promise<{ signal: AbortSignal; release(): void } | { error: string }>;
  /** A paused owner (a paused Bot) runs nothing and accepts no events. */
  isPaused(ownerKey: string): Promise<boolean>;
  /** The routine's gap and daily cap; a Bot's routines use the Bot limits (5 minutes, 24 a day). */
  limits?(routine: R): { minGapMs: number; perDay: number };
  /** The bound on one event's payload, in characters. Defaults to the Bot bound (4,000). */
  payloadChars?: number;
  /**
   * The payload to hold when an event arrives inside the gap and another is
   * already held. Without it the newest wins; a link trigger batches them.
   */
  mergeHeld?(held: BotEventReceipt, incoming: { eventId: string; payload: string }, routine: R): string;
  now(): number;
  timeZone(): string;
  setTimer(fn: () => void, ms: number): { cancel(): void };
  onError?(error: unknown): void;
}

/** A Bot's dispatcher: the owner key is the Bot id. */
export interface BotRoutineEventDispatcherDependencies
  extends Omit<EventRoutineDispatcherDependencies<BotEventRoutine>, "ownerKey" | "store"> {
  store: Pick<BotEventRoutineStore, "mutate" | "list">;
}

function dayKey(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

export function createBotRoutineEventDispatcher(dependencies: BotRoutineEventDispatcherDependencies) {
  return createEventRoutineDispatcher<BotEventRoutine>({ ...dependencies, ownerKey: (routine) => routine.botId });
}

export function createEventRoutineDispatcher<R extends EventRoutine>(dependencies: EventRoutineDispatcherDependencies<R>) {
  const ownerOf = (routine: R) => dependencies.ownerKey(routine);
  const limitsOf = (routine: R) => dependencies.limits?.(routine) ?? BOT_ROUTINE_EVENT_LIMITS;
  const payloadChars = dependencies.payloadChars ?? BOT_ROUTINE_EVENT_LIMITS.payloadChars;
  const heldTimers = new Map<string, { cancel(): void }>();
  /** Runs started and admissions still deciding, not yet settled in the store, for `idle()`. */
  const pending = new Set<Promise<void>>();
  const active = new Set<string>();
  let disposed = false;
  /**
   * Bumped by dispose(): work that began before a stop (an admission still
   * awaiting, a startup replay still loading) never starts a run afterwards,
   * even once a later start resumes the dispatcher. Its receipt stays for the
   * next start to replay.
   */
  let generation = 0;
  const live = (armedFor: number) => !disposed && armedFor === generation;

  function track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => dependencies.onError?.(error)).finally(() => pending.delete(tracked));
    pending.add(tracked);
  }

  /** Counts `work` in `idle()` without changing what the caller sees. */
  function admitting<T>(work: Promise<T>): Promise<T> {
    const tracked = work.then(() => undefined, () => undefined).finally(() => pending.delete(tracked));
    pending.add(tracked);
    return work;
  }

  /** The receipt list with this event added. Callers admit only below the bound, so none is dropped. */
  function withRunning(routine: R, event: BotRoutineEvent, at: number, execution: BotEventExecutionSnapshot) {
    const others = (routine.running ?? []).filter((entry) => entry.eventId !== event.eventId);
    return [...others, { eventId: event.eventId, payload: event.payload, at, execution,
      ...(dependencies.claimRoutineExecution ? { claimPending: true as const } : {}),
      ...(event.watchRevision !== undefined ? { watchRevision: event.watchRevision } : {}) }];
  }

  async function prepare(routine: R): Promise<BotEventExecutionSnapshot> {
    if (dependencies.claimRoutineExecution && !dependencies.prepareRoutineExecution) throw new Error("Protected event ownership requires an original-choice preparation.");
    const choiceHash = await dependencies.prepareRoutineExecution?.(routine);
    if (choiceHash !== undefined && !/^[a-f0-9]{64}$/u.test(choiceHash)) throw new Error("The protected event preparation is invalid.");
    return { name: routine.name, prompt: routine.prompt, trigger: structuredClone(routine.trigger), createdAt: routine.createdAt, updatedAt: routine.updatedAt,
      ...(routine.connector ? { condition: structuredClone(routine.connector.condition) } : {}),
      ...(choiceHash ? { choiceHash } : {}) };
  }

  function originalTask(routine: R, execution: BotEventExecutionSnapshot): R {
    const { condition, ...task } = structuredClone(execution);
    return { ...routine, ...task, ...(condition && routine.connector ? { connector: { ...routine.connector, condition } } : {}) } as R;
  }

  function sameSource(routine: R, event: BotEventReceipt): boolean {
    return !event.execution || event.execution.createdAt === routine.createdAt &&
      JSON.stringify(event.execution.trigger.kind === "watch" ? event.execution.trigger.source : event.execution.trigger) ===
      JSON.stringify(routine.trigger.kind === "watch" ? routine.trigger.source : routine.trigger);
  }

  /** Complete ownership before any effects; a crash in either store leaves the same payload/request. */
  async function claimAndStart(routine: R, event: BotRoutineEvent, armedFor: number): Promise<void> {
    if (!live(armedFor) || event.isCurrent?.() === false || await dependencies.isPaused(ownerOf(routine))) return;
    let claimed: { routine: R; event: BotEventReceipt } | undefined;
    try { claimed = await dependencies.store.mutate<{ routine: R; event: BotEventReceipt } | undefined>(ownerOf(routine), routine.id, async current => {
      const receipt = current.running?.find(row => row.eventId === event.eventId);
      if (!receipt || !current.enabled || !sameSource(current, receipt) || !live(armedFor) || event.isCurrent?.() === false) return { result: undefined };
      if (receipt.watchRevision !== undefined && receipt.watchRevision !== current.updatedAt) return { result: undefined };
      const original = receipt.execution ? originalTask(current, receipt.execution) : current;
      if (receipt.claimPending) {
        if (!dependencies.claimRoutineExecution) throw new Error("The prepared event's protected execution choice is unavailable.");
        await dependencies.claimRoutineExecution(original, { ...receipt, source: original.trigger.kind }, receipt.execution?.choiceHash);
        if (!live(armedFor) || event.isCurrent?.() === false) return { result: undefined };
        const { claimPending: _pending, ...ready } = receipt;
        const next = { ...current, running: current.running!.map(row => row.eventId === event.eventId ? ready : row) };
        return { next, result: { routine: next, event: ready } };
      }
      return { result: { routine: current, event: receipt } };
    }); } catch (error) {
      await dependencies.claimFailed?.(routine, error).catch((reportError: unknown) => dependencies.onError?.(reportError));
      throw error;
    }
    if (claimed) await dependencies.claimRecovered?.(claimed.routine).catch((error: unknown) => dependencies.onError?.(error));
    if (claimed && !await dependencies.isPaused(ownerOf(routine))) track(start(claimed.routine, { ...claimed.event, ...(event.isCurrent ? { isCurrent: event.isCurrent } : {}) }, armedFor));
  }

  /** Every receipt slot holds an unfinished run: a new event waits as the held one. */
  function full(routine: R): boolean {
    return (routine.running?.length ?? 0) >= BOT_EVENT_RUNNING_MAX;
  }

  /** Runs an accepted event, then drops its receipt once the run is recorded. A stopped dispatcher keeps the receipt instead. */
  async function start(routine: R, event: BotRoutineEvent, armedFor: number): Promise<void> {
    const key = `${ownerOf(routine)}:${routine.id}:${event.eventId}`;
    if (!live(armedFor) || event.isCurrent?.() === false || active.has(key)) return;
    active.add(key);
    let settled = false;
    let grant: { signal: AbortSignal; release(): void } | undefined;
    try {
      const fresh = (await dependencies.store.list(ownerOf(routine))).find(item => item.id === routine.id);
      const accepted = fresh?.running?.find(item => item.eventId === event.eventId);
      if (!fresh?.enabled || !accepted || accepted.claimPending) return;
      if (!sameSource(fresh, accepted)) { settled = true; return; }
      routine = fresh;
      if (routine.trigger.kind === "watch") {
        const receipt = fresh.running?.find((item) => item.eventId === event.eventId);
        if (!receipt) return;
        if (receipt.watchRevision !== undefined && fresh.updatedAt !== receipt.watchRevision) { settled = true; return; }
        const admitted = await dependencies.authorizeRun?.(fresh);
        if (admitted && "error" in admitted) return;
        grant = admitted;
        const ready = (await dependencies.store.list(ownerOf(routine))).find((item) => item.id === routine.id);
        if (!ready?.enabled) return;
        const currentReceipt = ready.running?.find((item) => item.eventId === event.eventId);
        if (!currentReceipt) return;
        if (currentReceipt.watchRevision !== undefined && ready.updatedAt !== currentReceipt.watchRevision) { settled = true; return; }
        routine = ready;
      }
      if (!live(armedFor) || event.isCurrent?.() === false || grant?.signal.aborted) return;
      const receipt = routine.running?.find(row => row.eventId === event.eventId);
      if (receipt?.claimPending || receipt && !sameSource(routine, receipt)) return;
      if (receipt?.execution) routine = originalTask(routine, receipt.execution);
      settled = (await dependencies.run(routine, { ...event, source: routine.trigger.kind }, grant?.signal))?.settled !== false;
    } finally {
      grant?.release();
      try {
        if (settled) await dependencies.store.mutate(ownerOf(routine), routine.id, (current) => {
          const running = (current.running ?? []).filter((entry) => entry.eventId !== event.eventId);
          if (running.length === (current.running ?? []).length) return { result: undefined };
          const { running: _previous, ...rest } = current;
          return { next: (running.length ? { ...rest, running } : rest) as R, result: undefined };
        }).catch((error: unknown) => dependencies.onError?.(error));
      } finally {
        active.delete(key);
      }
    }
  }

  /** The held event stays in the store, so a stopped dispatcher leaves it for the next start to re-arm. */
  function armHeld(ownerKey: string, routineId: string, at: number, armedFor: number): void {
    if (!live(armedFor)) return;
    const key = `${ownerKey}\0${routineId}`;
    heldTimers.get(key)?.cancel();
    heldTimers.set(key, dependencies.setTimer(() => {
      heldTimers.delete(key);
      if (live(armedFor)) track(releaseHeld(ownerKey, routineId, armedFor));
    }, Math.max(0, at - dependencies.now())));
  }

  async function releaseHeld(ownerKey: string, routineId: string, armedFor: number): Promise<void> {
    if (!live(armedFor) || await dependencies.isPaused(ownerKey)) return;
    const now = dependencies.now();
    const today = dayKey(now, dependencies.timeZone());
    let retryAt: number | undefined;
    const claimed = await dependencies.store.mutate(ownerKey, routineId, async (routine) => {
      if (!routine.held || !routine.enabled) return { result: undefined };
      // Still inside the 5-minute gap (a newer event ran since this was held),
      // or every receipt slot is busy: wait for whichever ends later.
      const gapEnds = (routine.lastRunAt ?? -Infinity) + limitsOf(routine).minGapMs;
      if (full(routine) || now < gapEnds) {
        retryAt = Math.max(gapEnds, full(routine) ? now + limitsOf(routine).minGapMs : now);
        return { result: undefined };
      }
      const count = routine.day?.key === today ? routine.day.count : 0;
      if (count >= limitsOf(routine).perDay) return { next: { ...routine, held: undefined }, result: undefined };
      const event = routine.held;
      const execution = await prepare(routine);
      return {
        next: { ...routine, held: undefined, running: withRunning(routine, event, now, execution), lastRunAt: now, day: { key: today, count: count + 1 } },
        result: { routine, event },
      };
    });
    if (claimed) await claimAndStart(claimed.routine, claimed.event, armedFor);
    else if (retryAt !== undefined) armHeld(ownerKey, routineId, retryAt, armedFor);
  }

  async function emit(ownerKey: string, routineId: string, event: BotRoutineEvent, armedFor: number): Promise<BotRoutineEventOutcome> {
    if (await dependencies.isPaused(ownerKey) || event.isCurrent?.() === false || (event.watchRevision !== undefined && !live(armedFor))) return "disabled";
    const now = dependencies.now();
    const today = dayKey(now, dependencies.timeZone());
    // Cut by length first, so a huge payload is never spread into an array.
    const payload = [...event.payload.slice(0, payloadChars * 2)]
      .slice(0, payloadChars).join("");
    type Decision =
      | { kind: "disabled" | "duplicate" | "daily_limit" }
      | { kind: "held"; at: number }
      | { kind: "queued"; routine: R };
    const decision = await dependencies.store.mutate<Decision>(ownerKey, routineId, async (routine) => {
      if (!routine.enabled || event.isCurrent?.() === false || (event.watchRevision !== undefined && !live(armedFor))) return { result: { kind: "disabled" as const } };
      if (event.watchRevision !== undefined && (routine.trigger.kind !== "watch" ||
        routine.updatedAt !== event.watchRevision || routine.watch?.pending?.eventId !== event.eventId)) {
        return { result: { kind: "disabled" as const } };
      }
      if (routine.running?.some(row => row.eventId === event.eventId && row.claimPending)) return { result: { kind: "queued" as const, routine } };
      if (routine.seenEventIds.includes(event.eventId) || routine.held?.eventId === event.eventId || routine.running?.some(row => row.eventId === event.eventId)) {
        return { result: { kind: "duplicate" as const } };
      }
      const seenEventIds = [...routine.seenEventIds, event.eventId].slice(-BOT_ROUTINE_EVENT_LIMITS.seenIds);
      const count = routine.day?.key === today ? routine.day.count : 0;
      if (count >= limitsOf(routine).perDay) {
        return { next: { ...routine, seenEventIds }, result: { kind: "daily_limit" as const } };
      }
      const gapEnds = (routine.lastRunAt ?? -Infinity) + limitsOf(routine).minGapMs;
      // Too soon, or every receipt slot is busy: hold it (the newest wins,
      // unless the owner merges what is already held).
      const nextAllowed = full(routine) ? Math.max(gapEnds, now + limitsOf(routine).minGapMs) : gapEnds;
      if (now < nextAllowed) {
        const heldPayload = routine.held && dependencies.mergeHeld
          ? [...dependencies.mergeHeld(routine.held, { eventId: event.eventId, payload }, routine)].slice(0, payloadChars).join("")
          : payload;
        return {
          next: { ...routine, seenEventIds, held: { eventId: event.eventId, payload: heldPayload, at: now,
            ...(event.watchRevision !== undefined ? { watchRevision: event.watchRevision } : {}) } },
          result: { kind: "held" as const, at: nextAllowed },
        };
      }
      // Reserve limits and save the original payload/task before crossing the model store.
      const execution = await prepare(routine);
      if (event.isCurrent?.() === false || (event.watchRevision !== undefined && !live(armedFor))) return { result: { kind: "disabled" as const } };
      return {
        next: { ...routine, seenEventIds, running: withRunning(routine, { ...event, payload }, now, execution), lastRunAt: now, day: { key: today, count: count + 1 } },
        result: { kind: "queued" as const, routine },
      };
    });
    if (!decision) return "unknown";
    if (decision.kind === "held") {
      armHeld(ownerKey, routineId, decision.at, armedFor);
      return "held";
    }
    if (decision.kind === "queued") {
      await claimAndStart(decision.routine, { ...event, payload }, armedFor);
      return "queued";
    }
    return decision.kind;
  }

  return {
    /** `ownerKey` is the routine's owner: a Bot id for a Bot's routines. */
    emit(ownerKey: string, routineId: string, event: BotRoutineEvent): Promise<BotRoutineEventOutcome> {
      return admitting(emit(ownerKey, routineId, event, generation));
    },

    /** After a restart: replay accepted events whose run wasn't recorded, and re-arm held ones. */
    rearm(routines: readonly R[] | Promise<readonly R[]>): Promise<void> {
      const armedFor = generation;
      return admitting((async () => {
        for (const routine of await routines) {
          if (live(armedFor) && !routine.running?.some(event => event.claimPending)) {
            await dependencies.claimRecovered?.(routine).catch((error: unknown) => dependencies.onError?.(error));
          }
          for (const event of routine.running ?? []) {
            track(claimAndStart(routine, event, armedFor));
          }
          if (!routine.held) continue;
          armHeld(ownerOf(routine), routine.id, (routine.lastRunAt ?? 0) + limitsOf(routine).minGapMs, armedFor);
        }
      })());
    },

    dispose(): void {
      disposed = true;
      generation += 1;
      for (const timer of heldTimers.values()) timer.cancel();
      heldTimers.clear();
    },

    /** Accepts events again after `dispose()`; work begun before the stop stays stopped. */
    resume(): void {
      disposed = false;
    },

    /** Resolves once every admission and run started so far is decided, recorded and its receipt settled (or kept). */
    async idle(): Promise<void> {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

export type EventRoutineDispatcher<R extends EventRoutine> = ReturnType<typeof createEventRoutineDispatcher<R>>;
export type BotRoutineEventDispatcher = EventRoutineDispatcher<BotEventRoutine>;
