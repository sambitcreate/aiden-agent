// Every event goes through here (spec §6 P1): at most one run per routine every
// 5 minutes, at most 24 a day, a repeated event id is dropped, and an event
// that arrives too soon is held (the newest wins) and runs once the gap allows.

import { BOT_ROUTINE_EVENT_LIMITS, type BotRoutineTriggerKind } from "../../../renderer/shared/bot-routine-trigger.js";
import { BOT_EVENT_RUNNING_MAX, type BotEventRoutine, type BotEventRoutineStore, type BotEventExecutionSnapshot, type BotEventReceipt } from "./store.js";

export type BotRoutineEventOutcome = "queued" | "held" | "duplicate" | "daily_limit" | "disabled" | "unknown";
export interface BotRoutineEvent {
  eventId: string;
  payload: string;
  /** A watch hand-off must still be owed by this exact configuration. */
  watchRevision?: number;
  /** Live host authority only; never stored or accepted from a caller over IPC. */
  isCurrent?: () => boolean;
}

export interface BotRoutineEventDispatcherDependencies {
  store: Pick<BotEventRoutineStore, "mutate" | "list">;
  /**
   * Runs the routine once with this event; resolves when the run is recorded.
   * The same event may be run again after a restart: the run must read the
   * recorded run or the admitted turn by the event's id before sending.
   * `settled: false` (or a throw): the outcome is unknown, so the receipt
   * stays for the next start to replay.
   */
  run(routine: BotEventRoutine, event: { eventId: string; source: BotRoutineTriggerKind; payload: string }, signal?: AbortSignal): Promise<{ settled: boolean } | void>;
  /** Original-choice comparison, without creating this event's execution claim. */
  prepareRoutineExecution?(routine: BotEventRoutine): Promise<string>;
  /** Idempotent protected choice, after this event's payload is durable. */
  claimRoutineExecution?(routine: BotEventRoutine, event: { eventId: string; source: BotRoutineTriggerKind; payload: string }, expectedChoiceHash?: string): Promise<unknown>;
  claimFailed?(routine: BotEventRoutine, error: unknown): Promise<void>;
  claimRecovered?(routine: BotEventRoutine): Promise<void>;
  /** Re-admit watch source access at actual startup, including held/replayed work. */
  authorizeRun?(routine: BotEventRoutine): Promise<{ signal: AbortSignal; release(): void } | { error: string }>;
  isPaused(botId: string): Promise<boolean>;
  now(): number;
  timeZone(): string;
  setTimer(fn: () => void, ms: number): { cancel(): void };
  onError?(error: unknown): void;
}

function dayKey(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

export function createBotRoutineEventDispatcher(dependencies: BotRoutineEventDispatcherDependencies) {
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
  function withRunning(routine: BotEventRoutine, event: BotRoutineEvent, at: number, execution: BotEventExecutionSnapshot) {
    const others = (routine.running ?? []).filter((entry) => entry.eventId !== event.eventId);
    return [...others, { eventId: event.eventId, payload: event.payload, at, execution,
      ...(dependencies.claimRoutineExecution ? { claimPending: true as const } : {}),
      ...(event.watchRevision !== undefined ? { watchRevision: event.watchRevision } : {}) }];
  }

  async function prepare(routine: BotEventRoutine): Promise<BotEventExecutionSnapshot> {
    if (dependencies.claimRoutineExecution && !dependencies.prepareRoutineExecution) throw new Error("Protected event ownership requires an original-choice preparation.");
    const choiceHash = await dependencies.prepareRoutineExecution?.(routine);
    if (choiceHash !== undefined && !/^[a-f0-9]{64}$/u.test(choiceHash)) throw new Error("The protected event preparation is invalid.");
    return { name: routine.name, prompt: routine.prompt, trigger: structuredClone(routine.trigger), createdAt: routine.createdAt, updatedAt: routine.updatedAt,
      ...(routine.connector ? { condition: structuredClone(routine.connector.condition) } : {}),
      ...(choiceHash ? { choiceHash } : {}) };
  }

  function originalTask(routine: BotEventRoutine, execution: BotEventExecutionSnapshot): BotEventRoutine {
    const { condition, ...task } = structuredClone(execution);
    return { ...routine, ...task, ...(condition && routine.connector ? { connector: { ...routine.connector, condition } } : {}) };
  }

  function sameSource(routine: BotEventRoutine, event: BotEventReceipt): boolean {
    return !event.execution || event.execution.createdAt === routine.createdAt &&
      JSON.stringify(event.execution.trigger.kind === "watch" ? event.execution.trigger.source : event.execution.trigger) ===
      JSON.stringify(routine.trigger.kind === "watch" ? routine.trigger.source : routine.trigger);
  }

  /** Complete ownership before any effects; a crash in either store leaves the same payload/request. */
  async function claimAndStart(routine: BotEventRoutine, event: BotRoutineEvent, armedFor: number): Promise<void> {
    if (!live(armedFor) || event.isCurrent?.() === false || await dependencies.isPaused(routine.botId)) return;
    let claimed: { routine: BotEventRoutine; event: BotEventReceipt } | undefined;
    try { claimed = await dependencies.store.mutate<{ routine: BotEventRoutine; event: BotEventReceipt } | undefined>(routine.botId, routine.id, async current => {
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
    if (claimed && !await dependencies.isPaused(routine.botId)) track(start(claimed.routine, { ...claimed.event, ...(event.isCurrent ? { isCurrent: event.isCurrent } : {}) }, armedFor));
  }

  /** Every receipt slot holds an unfinished run: a new event waits as the held one. */
  function full(routine: BotEventRoutine): boolean {
    return (routine.running?.length ?? 0) >= BOT_EVENT_RUNNING_MAX;
  }

  /** Runs an accepted event, then drops its receipt once the run is recorded. A stopped dispatcher keeps the receipt instead. */
  async function start(routine: BotEventRoutine, event: BotRoutineEvent, armedFor: number): Promise<void> {
    const key = `${routine.botId}:${routine.id}:${event.eventId}`;
    if (!live(armedFor) || event.isCurrent?.() === false || active.has(key)) return;
    active.add(key);
    let settled = false;
    let grant: { signal: AbortSignal; release(): void } | undefined;
    try {
      const fresh = (await dependencies.store.list(routine.botId)).find(item => item.id === routine.id);
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
        const ready = (await dependencies.store.list(routine.botId)).find((item) => item.id === routine.id);
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
        if (settled) await dependencies.store.mutate(routine.botId, routine.id, (current) => {
          const running = (current.running ?? []).filter((entry) => entry.eventId !== event.eventId);
          if (running.length === (current.running ?? []).length) return { result: undefined };
          const { running: _previous, ...rest } = current;
          return { next: running.length ? { ...rest, running } : rest, result: undefined };
        }).catch((error: unknown) => dependencies.onError?.(error));
      } finally {
        active.delete(key);
      }
    }
  }

  /** The held event stays in the store, so a stopped dispatcher leaves it for the next start to re-arm. */
  function armHeld(botId: string, routineId: string, at: number, armedFor: number): void {
    if (!live(armedFor)) return;
    const key = `${botId}\0${routineId}`;
    heldTimers.get(key)?.cancel();
    heldTimers.set(key, dependencies.setTimer(() => {
      heldTimers.delete(key);
      if (live(armedFor)) track(releaseHeld(botId, routineId, armedFor));
    }, Math.max(0, at - dependencies.now())));
  }

  async function releaseHeld(botId: string, routineId: string, armedFor: number): Promise<void> {
    if (!live(armedFor) || await dependencies.isPaused(botId)) return;
    const now = dependencies.now();
    const today = dayKey(now, dependencies.timeZone());
    let retryAt: number | undefined;
    const claimed = await dependencies.store.mutate(botId, routineId, async (routine) => {
      if (!routine.held || !routine.enabled) return { result: undefined };
      // Still inside the 5-minute gap (a newer event ran since this was held),
      // or every receipt slot is busy: wait for whichever ends later.
      const gapEnds = (routine.lastRunAt ?? -Infinity) + BOT_ROUTINE_EVENT_LIMITS.minGapMs;
      if (full(routine) || now < gapEnds) {
        retryAt = Math.max(gapEnds, full(routine) ? now + BOT_ROUTINE_EVENT_LIMITS.minGapMs : now);
        return { result: undefined };
      }
      const count = routine.day?.key === today ? routine.day.count : 0;
      if (count >= BOT_ROUTINE_EVENT_LIMITS.perDay) return { next: { ...routine, held: undefined }, result: undefined };
      const event = routine.held;
      const execution = await prepare(routine);
      return {
        next: { ...routine, held: undefined, running: withRunning(routine, event, now, execution), lastRunAt: now, day: { key: today, count: count + 1 } },
        result: { routine, event },
      };
    });
    if (claimed) await claimAndStart(claimed.routine, claimed.event, armedFor);
    else if (retryAt !== undefined) armHeld(botId, routineId, retryAt, armedFor);
  }

  async function emit(botId: string, routineId: string, event: BotRoutineEvent, armedFor: number): Promise<BotRoutineEventOutcome> {
    if (await dependencies.isPaused(botId) || event.isCurrent?.() === false || (event.watchRevision !== undefined && !live(armedFor))) return "disabled";
    const now = dependencies.now();
    const today = dayKey(now, dependencies.timeZone());
    // Cut by length first, so a huge payload is never spread into an array.
    const payload = [...event.payload.slice(0, BOT_ROUTINE_EVENT_LIMITS.payloadChars * 2)]
      .slice(0, BOT_ROUTINE_EVENT_LIMITS.payloadChars).join("");
    type Decision =
      | { kind: "disabled" | "duplicate" | "daily_limit" }
      | { kind: "held"; at: number }
      | { kind: "queued"; routine: BotEventRoutine };
    const decision = await dependencies.store.mutate<Decision>(botId, routineId, async (routine) => {
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
      if (count >= BOT_ROUTINE_EVENT_LIMITS.perDay) {
        return { next: { ...routine, seenEventIds }, result: { kind: "daily_limit" as const } };
      }
      const gapEnds = (routine.lastRunAt ?? -Infinity) + BOT_ROUTINE_EVENT_LIMITS.minGapMs;
      // Too soon, or every receipt slot is busy: hold it (the newest wins).
      const nextAllowed = full(routine) ? Math.max(gapEnds, now + BOT_ROUTINE_EVENT_LIMITS.minGapMs) : gapEnds;
      if (now < nextAllowed) {
        return {
          next: { ...routine, seenEventIds, held: { eventId: event.eventId, payload, at: now,
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
      armHeld(botId, routineId, decision.at, armedFor);
      return "held";
    }
    if (decision.kind === "queued") {
      await claimAndStart(decision.routine, { ...event, payload }, armedFor);
      return "queued";
    }
    return decision.kind;
  }

  return {
    emit(botId: string, routineId: string, event: BotRoutineEvent): Promise<BotRoutineEventOutcome> {
      return admitting(emit(botId, routineId, event, generation));
    },

    /** After a restart: replay accepted events whose run wasn't recorded, and re-arm held ones. */
    rearm(routines: readonly BotEventRoutine[] | Promise<readonly BotEventRoutine[]>): Promise<void> {
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
          armHeld(routine.botId, routine.id, (routine.lastRunAt ?? 0) + BOT_ROUTINE_EVENT_LIMITS.minGapMs, armedFor);
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

export type BotRoutineEventDispatcher = ReturnType<typeof createBotRoutineEventDispatcher>;
