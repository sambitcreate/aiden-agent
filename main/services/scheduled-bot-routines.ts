import { randomUUID } from "node:crypto";
import { formatBotRoutineLabel } from "../../renderer/shared/bot-routine-label.js";
import {
  parseBotRoutineSchedule,
  type BotRoutineSchedule,
} from "../../renderer/shared/bot-routine-schedule.js";
import { isPathSafeBotCapabilityId } from "../../renderer/shared/bot-capabilities.js";
import { BOT_LIMITS } from "../../renderer/shared/bots.js";
import { BOT_ROUTINE_NOTES_HEADER } from "./bot-routine-notes.js";
import type { BotRoutinePorts } from "./bot-routines-port.js";
import type { ScheduledRunTrigger } from "./schedule-service-core.js";
import type {
  ScheduledRun,
  ScheduledRunResult,
  ScheduledRunSkipReason,
  ScheduledTask,
  ScheduledTaskInput,
} from "./types.js";

export const BOT_ROUTINE_SILENT_TOKEN = "[SILENT]";
export const BOT_ROUTINE_SILENT_INSTRUCTION =
  "If there is nothing new to report, reply exactly [SILENT].";
export const BOT_ROUTINE_NAME_LIMIT = 120;
export const BOT_ROUTINE_PROMPT_LIMIT = 32 * 1024;

/** How far back a fire skipped while the Bot was paused is still caught up. */
export const BOT_ROUTINE_CATCH_UP_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Stable idempotency key for one routine firing (or one explicit manual run).
 * A catch-up reuses the key of the fire it replaces: a skipped automatic fire
 * is recorded under that key (see `run`), so any number of catch-ups of the
 * same miss submit at most once.
 */
export function botRoutineRequestId(taskId: string, trigger: ScheduledRunTrigger): string {
  if (trigger.kind === "automatic") return `routine:${taskId}:${trigger.fireTime}`;
  if (trigger.kind === "manual") return `routine:${taskId}:manual-${trigger.key}`;
  return trigger.missedRunId.startsWith(`routine:${taskId}:`)
    ? trigger.missedRunId
    : `routine:${taskId}:catch-up-${trigger.missedRunId}`;
}

/** The routine task id a routine request id belongs to, if it is one. */
export function botRoutineTaskIdOf(requestId: string | undefined): string | undefined {
  const match = /^routine:([^:]+):/u.exec(requestId ?? "");
  return match?.[1];
}

/**
 * The message a routine submits to its Bot: the notes it kept from earlier
 * runs (when any), the person's words, and the silence rule.
 */
export function botRoutineMessage(prompt: string, notes = ""): string {
  const body = `${prompt.trim()}\n\n${BOT_ROUTINE_SILENT_INSTRUCTION}`;
  return notes.trim() ? `${notes.trim()}\n\n${body}` : body;
}

/**
 * What the person wrote for a routine, from the message it submitted: the
 * notes block and the silence rule are Aiden's, so chats show only the prompt.
 */
export function botRoutinePromptOf(text: string): string {
  let prompt = text;
  if (prompt.startsWith(`${BOT_ROUTINE_NOTES_HEADER}\n`)) {
    const end = prompt.indexOf("\n\n");
    prompt = end < 0 ? "" : prompt.slice(end + 2);
  }
  const suffix = `\n\n${BOT_ROUTINE_SILENT_INSTRUCTION}`;
  if (prompt.endsWith(suffix)) return prompt.slice(0, -suffix.length);
  return prompt.endsWith(BOT_ROUTINE_SILENT_INSTRUCTION)
    ? prompt.slice(0, -BOT_ROUTINE_SILENT_INSTRUCTION.length).trimEnd()
    : prompt;
}

export function isSilentBotRoutineReply(text: string): boolean {
  return text.trim() === BOT_ROUTINE_SILENT_TOKEN;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** A routine result handed to the person's other surfaces (their Telegram chat). */
export interface BotRoutineResultDelivery {
  botId: string;
  /** The run's session request id: one delivery per routine firing. */
  requestId: string;
  routineName: string;
  text: string;
}

/** What a routine failure says outside the Mac (the real error stays in the run record). */
export const BOT_ROUTINE_FAILED_PREVIEW = "I couldn't finish this routine.";

/**
 * The Bot session ports a routine run uses, plus the routine-only extras the
 * production wiring (`scheduled-bot-routines-main.ts`) adds.
 */
export interface BotRoutineExecutorPorts extends BotRoutinePorts {
  /** The notes this routine kept from earlier runs, rendered; "" when none. */
  routineNotes?(botId: string, taskId: string): Promise<string>;
  /** Fan a visible result or failure out to the Bot's other surfaces. Must not throw for delivery problems. */
  deliverResult?(delivery: BotRoutineResultDelivery): Promise<void>;
  /** Why a spending limit stopped the run serving `requestId`, if one did. */
  spendingStop?(botId: string, requestId: string): string | undefined;
}

export interface BotRoutineExecutorDependencies {
  store: {
    recordRun(run: Omit<ScheduledRun, "id"> & { id?: string }): Promise<ScheduledRun>;
    runById(taskId: string, runId: string): Promise<ScheduledRun | undefined>;
    get(taskId: string): Promise<ScheduledTask | undefined>;
    settleRoutineFire(taskId: string, requestId: string): Promise<void>;
  };
  /** Late-bound so the Bot runtime can be swapped in after the scheduler is built. */
  ports(): BotRoutineExecutorPorts | Promise<BotRoutineExecutorPorts>;
  notify(task: ScheduledTask, body: string): void;
  broadcast(payload: Record<string, unknown>): void;
  now?: () => number;
}

interface BotRoutineOutcome {
  result: ScheduledRunResult;
  reason?: ScheduledRunSkipReason;
  output: string;
  error?: string;
  /** Whether the person should hear about this run. */
  surface: boolean;
  /** The Pi admission or reply may have committed; retry by request id later. */
  uncertain?: boolean;
}

class RoutineOutcomeUnknown extends Error {}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Routine was cancelled."));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Routine was cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** The label shown on a routine's turn. */
function routineLabel(task: ScheduledTask, trigger: ScheduledRunTrigger): string | undefined {
  const name = task.name?.trim();
  if (!name) return undefined;
  return trigger.kind === "catch_up" ? `${name} (missed while paused)` : name;
}

export function createBotRoutineExecutor(dependencies: BotRoutineExecutorDependencies) {
  const now = dependencies.now ?? Date.now;

  async function execute(
    task: ScheduledTask & { botId: string },
    trigger: ScheduledRunTrigger,
    requestId: string,
    ports: BotRoutineExecutorPorts,
    signal: AbortSignal,
    recovering: boolean,
    existingSubmissionId?: string,
  ): Promise<BotRoutineOutcome> {
    const prompt = task.prompt?.trim();
    if (!prompt) throw new Error("This routine has no message.");
    if (signal.aborted) throw new Error("Routine was cancelled.");
    const state = await abortable(ports.state(task.botId), signal);
    // A new fire cannot start while the person has paused the whole Bot.
    // An admitted fire remains pending so its reply can be observed after Resume.
    if (state.kind === "paused") {
      if (trigger.kind === "automatic" && existingSubmissionId)
        throw new RoutineOutcomeUnknown("This Bot is paused by the person.");
      return { result: "skipped", reason: "paused_by_person", output: "", surface: false };
    }
    // A routine must not resume or dismiss an interrupted turn. A previously
    // admitted fire can still be observed by its Pi submission ID.
    if (state.kind === "interrupted" && !existingSubmissionId) {
      return { result: "skipped", reason: "bot_paused", output: "", surface: false };
    }
    if (state.kind === "needs_model") {
      throw new Error("This Bot needs an AI model before its routines can run.");
    }
    if (state.kind === "unavailable") {
      throw new Error("Bots are open in another Aiden window.");
    }
    let submission: { submissionId: string; deduped: boolean };
    if (existingSubmissionId !== undefined) {
      submission = { submissionId: existingSubmissionId, deduped: true };
    } else {
      const notes = ports.routineNotes ? await abortable(ports.routineNotes(task.botId, task.id), signal) : "";
      const label = routineLabel(task, trigger);
      try {
        submission = await abortable(
          ports.send(task.botId, {
            text: botRoutineMessage(prompt, notes),
            requestId,
            ifNotInterrupted: true,
            ...(label ? { label } : {}),
          }),
          signal,
        );
      } catch (error) {
        // The Bot was interrupted or paused between the state check and send.
        const reason = (error as { reason?: unknown } | null)?.reason;
        if (reason === "bot_paused" || reason === "paused_by_person") {
          return { result: "skipped", reason, output: "", surface: false };
        }
        if (trigger.kind === "automatic") {
          // A failed send may have committed in Pi before its response was lost.
          // Read by the stable request ID before deciding whether this is a
          // terminal pre-admission failure or an outcome to recover later.
          let admitted: string | undefined;
          try {
            admitted = await ports.submissionForRequest(task.botId, requestId);
          } catch {
            throw new RoutineOutcomeUnknown(message(error));
          }
          if (admitted) throw new RoutineOutcomeUnknown(message(error));
        }
        throw error;
      }
    }
    if (submission.deduped && !recovering) {
      return { result: "skipped", reason: "duplicate", output: "", surface: false };
    }
    let outcome: Awaited<ReturnType<BotRoutineExecutorPorts["awaitReply"]>>;
    try {
      outcome = await abortable(ports.awaitReply(task.botId, submission.submissionId, signal), signal);
    } catch (error) {
      if (trigger.kind === "automatic") throw new RoutineOutcomeUnknown(message(error));
      throw error;
    }
    if (outcome.kind === "failed") throw new Error(outcome.error);
    if (outcome.kind === "interrupted") {
      // A spending limit stopped this run after its step: it failed, and the
      // next run starts fresh.
      const spendingStop = outcome.settled ? ports.spendingStop?.(task.botId, requestId) : undefined;
      if (spendingStop !== undefined) throw new Error(spendingStop);
      // Pi can report a paused submission without settling it. Keep the
      // automatic fire's receipt until the person resumes that same turn.
      if (trigger.kind === "automatic" && !outcome.settled)
        throw new RoutineOutcomeUnknown("The Bot turn is waiting for Resume.");
      // Paused mid-run: the person stopped it on purpose, so nothing surfaces.
      const after = await ports.state(task.botId).catch(() => undefined);
      if (after?.kind === "paused") {
        return { result: "skipped", reason: "paused_by_person", output: "", surface: false };
      }
      if (recovering || trigger.kind === "catch_up")
        return { result: "skipped", reason: "bot_paused", output: "", surface: false };
      throw new Error("The Bot was interrupted while working on this routine.");
    }
    if (isSilentBotRoutineReply(outcome.text)) {
      try {
        await ports.markSilent(task.botId, submission.submissionId);
      } catch (error) {
        if (trigger.kind === "automatic") throw new RoutineOutcomeUnknown(message(error));
        throw error;
      }
      return { result: "silent", output: "", surface: false };
    }
    return { result: "success", output: outcome.text, surface: true };
  }

  return {
    async run(
      task: ScheduledTask,
      options: { runId?: string; trigger?: ScheduledRunTrigger; signal: AbortSignal },
    ): Promise<ScheduledRun> {
      if (!task.botId) throw new Error("This scheduled task is not a Bot routine.");
      const startedAt = now();
      const trigger = options.trigger ?? { kind: "manual", key: options.runId ?? randomUUID() };
      const requestId = botRoutineRequestId(task.id, trigger);
      const recovering = trigger.kind === "automatic" && options.runId === requestId;
      let ports: BotRoutineExecutorPorts | undefined;
      let outcome: BotRoutineOutcome;
      try {
        if (recovering) {
          let prior: ScheduledRun | undefined;
          try {
            prior = await dependencies.store.runById(task.id, requestId);
          } catch (error) {
            throw new RoutineOutcomeUnknown(message(error));
          }
          if (prior) {
            try {
              // The run file and task summary are separate durable writes. A
              // crash between them leaves the answer saved but the routine's
              // visible last result stale.
              const current = await dependencies.store.get(task.id);
              if (current && (current.lastRunAt ?? 0) <= prior.finishedAt && (
                current.lastRunAt !== prior.finishedAt || current.lastResult !== prior.result ||
                current.lastError !== prior.error
              )) await dependencies.store.recordRun(prior);
              if (prior.result === "success" || prior.result === "error") {
                const deliveryPorts = await dependencies.ports();
                await deliveryPorts.deliverResult?.({
                  botId: task.botId,
                  requestId,
                  routineName: task.name?.trim() || "Routine",
                  text: prior.result === "error" ? BOT_ROUTINE_FAILED_PREVIEW : prior.output,
                });
              }
              await dependencies.store.settleRoutineFire(task.id, requestId);
            } catch {
              // The saved answer must never be replaced by an error merely
              // because summary repair or delivery is temporarily unavailable.
              return prior;
            }
            return prior;
          }
        }
        try {
          ports = await dependencies.ports();
        } catch (error) {
          if (recovering) throw new RoutineOutcomeUnknown(message(error));
          throw error;
        }
        const previous = trigger.kind === "catch_up"
          ? await dependencies.store.runById(task.id, requestId)
          : undefined;
        let existingSubmissionId: string | undefined;
        if (recovering) {
          try {
            existingSubmissionId = await ports.submissionForRequest(task.botId, requestId);
          } catch (error) {
            throw new RoutineOutcomeUnknown(message(error));
          }
        }
        outcome = recovering && !task.enabled && task.routineSchedule?.kind !== "once" && !existingSubmissionId
          ? { result: "blocked", output: "", error: "Routine was paused.", surface: false }
          : await execute(
            task as ScheduledTask & { botId: string }, trigger, requestId, ports, options.signal,
            recovering || (previous?.result === "skipped" && previous.reason === "bot_paused"),
            existingSubmissionId,
          );
      } catch (error) {
        const cancelled = options.signal.aborted;
        const uncertain = error instanceof RoutineOutcomeUnknown || (cancelled && trigger.kind === "automatic");
        outcome = {
          result: cancelled || uncertain ? "blocked" : "error",
          output: "",
          error: cancelled ? "Routine was cancelled." : message(error),
          // Failures always surface; a cancellation is the person's own action.
          surface: !cancelled && !uncertain,
          uncertain,
        };
      }
      // A scheduled fire skipped while the Bot was paused is recorded under
      // its own request id, so the catch-up after Resume submits that exact
      // id and any repeat of the catch-up dedupes against it.
      const run = await dependencies.store.recordRun({
        id: outcome.reason === "duplicate" || outcome.uncertain
          ? undefined
          : trigger.kind === "automatic" || trigger.kind === "catch_up" ? requestId : options.runId,
        taskId: task.id,
        startedAt,
        finishedAt: now(),
        result: outcome.result,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        output: outcome.output,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      });
      if (outcome.surface) {
        dependencies.notify(task, outcome.error ?? outcome.output);
        try {
          await ports
            ?.deliverResult?.({
            botId: task.botId,
            requestId,
            routineName: task.name?.trim() || "Routine",
            text: outcome.error !== undefined ? BOT_ROUTINE_FAILED_PREVIEW : outcome.output,
            });
        } catch {
          // The run is durable. Keep its fire receipt so startup can retry the
          // idempotent delivery handoff without re-running the Bot.
          dependencies.broadcast({ taskId: task.id, botId: task.botId, run });
          return run;
        }
      }
      if (trigger.kind === "automatic" && !outcome.uncertain)
        await dependencies.store.settleRoutineFire(task.id, requestId);
      dependencies.broadcast({ taskId: task.id, botId: task.botId, run });
      return run;
    },
  };
}


export type BotRoutineExecutor = ReturnType<typeof createBotRoutineExecutor>;

// ---------------------------------------------------------------------------
// Routine management (Bot profile + IPC)
// ---------------------------------------------------------------------------

export interface BotRoutine {
  id: string;
  botId: string;
  name: string;
  prompt: string;
  /** Null only for a stored routine whose schedule became unreadable. */
  schedule: BotRoutineSchedule | null;
  timezone: string;
  label: string;
  enabled: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
  lastResult?: ScheduledRunResult;
  lastError?: string;
  /** A claimed fire still being reconciled or handed to delivery. */
  pendingFireCount: number;
  /** The next scheduled fire is late enough to indicate a stopped scheduler. */
  overdueSince?: number;
  updatedAt: number;
}

export interface BotRoutineCreateInput {
  botId: string;
  name: string;
  schedule: BotRoutineSchedule;
  prompt: string;
  timezone?: string;
  /**
   * Main-only (never parsed from IPC or Remote): the Bot proposal being
   * accepted. Creating twice with the same id returns the first routine.
   */
  sourceProposalId?: string;
}

export interface BotRoutineUpdateInput {
  botId: string;
  id: string;
  expectedUpdatedAt: number;
  name?: string;
  schedule?: BotRoutineSchedule;
  prompt?: string;
  timezone?: string;
  enabled?: boolean;
}

export interface BotRoutineDeleteInput {
  botId: string;
  id: string;
  expectedUpdatedAt?: number;
}

/** Run now, from the "skipped while paused" notice. */
export interface BotRoutineRunNowInput {
  botId: string;
  routineId: string;
  expectedUpdatedAt?: number;
}

function invalid(label: string): never {
  throw new Error(`Invalid ${label}.`);
}

function record(value: unknown, required: readonly string[], optional: readonly string[], label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(label);
  const fields = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(fields)) if (!allowed.has(key)) invalid(label);
  for (const key of required) if (!(key in fields)) invalid(label);
  return fields;
}

export function parseBotRoutineBotId(value: unknown): string {
  if (!isPathSafeBotCapabilityId(value, BOT_LIMITS.idChars)) invalid("Bot id");
  return value;
}

function routineId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/u.test(value)) invalid("routine id");
  return value;
}

function text(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || [...value].length > limit) invalid(label);
  return value.trim();
}

function timezone(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return text(value, "routine timezone", 120);
}

export function parseBotRoutineCreate(value: unknown): BotRoutineCreateInput {
  const fields = record(value, ["botId", "name", "schedule", "prompt"], ["timezone"], "routine");
  const zone = timezone(fields.timezone);
  return {
    botId: parseBotRoutineBotId(fields.botId),
    name: text(fields.name, "routine name", BOT_ROUTINE_NAME_LIMIT),
    schedule: parseBotRoutineSchedule(fields.schedule),
    prompt: text(fields.prompt, "routine message", BOT_ROUTINE_PROMPT_LIMIT),
    ...(zone ? { timezone: zone } : {}),
  };
}

export function parseBotRoutineUpdate(value: unknown): BotRoutineUpdateInput {
  const fields = record(
    value,
    ["botId", "id", "expectedUpdatedAt"],
    ["name", "schedule", "prompt", "timezone", "enabled"],
    "routine update",
  );
  if (
    typeof fields.expectedUpdatedAt !== "number" ||
    !Number.isSafeInteger(fields.expectedUpdatedAt) ||
    fields.expectedUpdatedAt < 0
  ) {
    invalid("routine revision");
  }
  if (fields.enabled !== undefined && typeof fields.enabled !== "boolean") invalid("routine update");
  const zone = timezone(fields.timezone);
  return {
    botId: parseBotRoutineBotId(fields.botId),
    id: routineId(fields.id),
    expectedUpdatedAt: fields.expectedUpdatedAt,
    ...(fields.name !== undefined ? { name: text(fields.name, "routine name", BOT_ROUTINE_NAME_LIMIT) } : {}),
    ...(fields.schedule !== undefined ? { schedule: parseBotRoutineSchedule(fields.schedule) } : {}),
    ...(fields.prompt !== undefined
      ? { prompt: text(fields.prompt, "routine message", BOT_ROUTINE_PROMPT_LIMIT) }
      : {}),
    ...(zone ? { timezone: zone } : {}),
    ...(fields.enabled !== undefined ? { enabled: fields.enabled } : {}),
  };
}

export function parseBotRoutineRunNow(value: unknown): BotRoutineRunNowInput {
  const fields = record(value, ["botId", "routineId"], ["expectedUpdatedAt"], "routine run");
  if (
    fields.expectedUpdatedAt !== undefined &&
    (typeof fields.expectedUpdatedAt !== "number" ||
      !Number.isSafeInteger(fields.expectedUpdatedAt) ||
      fields.expectedUpdatedAt < 0)
  ) {
    invalid("routine revision");
  }
  return {
    botId: parseBotRoutineBotId(fields.botId),
    routineId: routineId(fields.routineId),
    ...(fields.expectedUpdatedAt !== undefined
      ? { expectedUpdatedAt: fields.expectedUpdatedAt as number }
      : {}),
  };
}

export function parseBotRoutineDelete(value: unknown): BotRoutineDeleteInput {
  const fields = record(value, ["botId", "id"], ["expectedUpdatedAt"], "routine removal");
  if (
    fields.expectedUpdatedAt !== undefined &&
    (typeof fields.expectedUpdatedAt !== "number" ||
      !Number.isSafeInteger(fields.expectedUpdatedAt) ||
      fields.expectedUpdatedAt < 0)
  ) {
    invalid("routine revision");
  }
  return {
    botId: parseBotRoutineBotId(fields.botId),
    id: routineId(fields.id),
    ...(fields.expectedUpdatedAt !== undefined
      ? { expectedUpdatedAt: fields.expectedUpdatedAt as number }
      : {}),
  };
}

export interface BotRoutineServiceDependencies {
  store: {
    list(): Promise<ScheduledTask[]>;
    get(id: string): Promise<ScheduledTask | undefined>;
  };
  service: {
    save(
      input: ScheduledTaskInput,
      options?: { expectedUpdatedAt?: number },
    ): Promise<ScheduledTask>;
    remove(id: string, options?: { expectedUpdatedAt?: number }): Promise<void>;
    runNow(id: string, options?: { runId?: string; expectedUpdatedAt?: number }): Promise<ScheduledRun>;
  };
  botExists(botId: string): Promise<boolean>;
  /** Whether the person paused the Bot; throws when that can't be read, so Run now refuses. */
  isPaused?(botId: string): Promise<boolean>;
  defaultTimezone(): string;
  notifyChanged(payload: { botId: string; routineId: string; removed?: boolean }): void;
  /** A routine was deleted: forget what belonged to it alone (its notes). */
  routineDeleted?(botId: string, routineId: string): Promise<void>;
  now?: () => number;
}

function yearIn(timestamp: number, zone: string): number | undefined {
  try {
    const year = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric" })
      .formatToParts(new Date(timestamp))
      .find((part) => part.type === "year")?.value;
    return year ? Number(year) : undefined;
  } catch {
    return undefined;
  }
}

/** The friendly schedule label ("Every day at 9:00 AM") as the host shows it in `zone`. */
export function botRoutineLabel(schedule: BotRoutineSchedule, zone: string, now: number): string {
  return formatBotRoutineLabel(schedule, { currentYear: yearIn(now, zone) });
}

export function projectBotRoutine(task: ScheduledTask & { botId: string }, now: number): BotRoutine {
  const schedule = task.routineSchedule ?? null;
  return {
    id: task.id,
    botId: task.botId,
    name: task.name,
    prompt: task.prompt ?? "",
    schedule,
    timezone: task.timezone,
    label: schedule
      ? formatBotRoutineLabel(schedule, { currentYear: yearIn(now, task.timezone) })
      : "Needs attention",
    enabled: task.enabled,
    ...(task.nextRunAt !== undefined ? { nextRunAt: task.nextRunAt } : {}),
    ...(task.lastRunAt !== undefined ? { lastRunAt: task.lastRunAt } : {}),
    ...(task.lastResult !== undefined ? { lastResult: task.lastResult } : {}),
    ...(task.lastError !== undefined ? { lastError: task.lastError } : {}),
    pendingFireCount: task.pendingRoutineFires?.length ?? 0,
    ...(task.enabled && task.nextRunAt !== undefined && task.nextRunAt < now - 15 * 60_000
      ? { overdueSince: task.nextRunAt }
      : {}),
    updatedAt: task.updatedAt,
  };
}

function isBotRoutine(task: ScheduledTask | undefined): task is ScheduledTask & { botId: string } {
  return typeof task?.botId === "string";
}

export function createBotRoutineService(dependencies: BotRoutineServiceDependencies) {
  const now = dependencies.now ?? Date.now;

  const owned = async (botId: string, id: string) => {
    const task = await dependencies.store.get(id);
    if (!isBotRoutine(task) || task.botId !== botId) throw new Error("This routine no longer exists.");
    return task;
  };

  const requireBot = async (botId: string) => {
    if (!(await dependencies.botExists(botId))) throw new Error("This Bot no longer exists.");
  };

  const findBySourceProposal = async (botId: string, proposalId: string): Promise<BotRoutine | undefined> => {
    const task = (await dependencies.store.list()).find(
      (candidate): candidate is ScheduledTask & { botId: string } =>
        candidate.botId === botId && candidate.sourceProposalId === proposalId,
    );
    return task ? projectBotRoutine(task, now()) : undefined;
  };

  return {
    async list(botId: string): Promise<BotRoutine[]> {
      const at = now();
      return (await dependencies.store.list())
        .filter((task): task is ScheduledTask & { botId: string } => task.botId === botId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((task) => projectBotRoutine(task, at));
    },

    /** The routine a Bot proposal created when the person accepted it, if it still exists. */
    findBySourceProposal,

    async create(input: BotRoutineCreateInput): Promise<BotRoutine> {
      await requireBot(input.botId);
      if (input.sourceProposalId !== undefined) {
        const accepted = await findBySourceProposal(input.botId, input.sourceProposalId);
        if (accepted) return accepted;
      }
      const task = await dependencies.service.save({
        name: input.name,
        mode: "llm",
        cron: "",
        timezone: input.timezone ?? dependencies.defaultTimezone(),
        prompt: input.prompt,
        permission: "read-only",
        botId: input.botId,
        routineSchedule: input.schedule,
        ...(input.sourceProposalId !== undefined ? { sourceProposalId: input.sourceProposalId } : {}),
        notify: true,
      });
      dependencies.notifyChanged({ botId: input.botId, routineId: task.id });
      return projectBotRoutine(task as ScheduledTask & { botId: string }, now());
    },

    async update(input: BotRoutineUpdateInput): Promise<BotRoutine> {
      await requireBot(input.botId);
      const existing = await owned(input.botId, input.id);
      if (existing.updatedAt !== input.expectedUpdatedAt) {
        throw new Error("This routine changed. Refresh it before trying again.");
      }
      const task = await dependencies.service.save(
        {
          id: existing.id,
          name: input.name ?? existing.name,
          mode: "llm",
          cron: existing.cron,
          timezone: input.timezone ?? existing.timezone,
          prompt: input.prompt ?? existing.prompt,
          permission: "read-only",
          botId: existing.botId,
          routineSchedule: input.schedule ?? existing.routineSchedule,
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        },
        { expectedUpdatedAt: existing.updatedAt },
      );
      dependencies.notifyChanged({ botId: input.botId, routineId: task.id });
      return projectBotRoutine(task as ScheduledTask & { botId: string }, now());
    },

    /** Turn a routine off (the Bot's `routines` tool may only reduce activity). */
    async pause(botId: string, id: string): Promise<BotRoutine> {
      await requireBot(botId);
      const existing = await owned(botId, id);
      if (!existing.enabled) return projectBotRoutine(existing, now());
      const task = await dependencies.service.save(
        {
          id: existing.id,
          name: existing.name,
          mode: "llm",
          cron: existing.cron,
          timezone: existing.timezone,
          prompt: existing.prompt,
          permission: "read-only",
          botId: existing.botId,
          routineSchedule: existing.routineSchedule,
          enabled: false,
        },
        { expectedUpdatedAt: existing.updatedAt },
      );
      dependencies.notifyChanged({ botId, routineId: task.id });
      return projectBotRoutine(task as ScheduledTask & { botId: string }, now());
    },

    /**
     * Start one manual run of the Bot's own routine and return its run id at
     * once. The run itself reports like any routine run (its turn, notifications
     * and run record). A paused Bot refuses it: the person's own Run now is
     * never recorded as a fire the pause skipped.
     */
    async runNow(input: BotRoutineRunNowInput): Promise<{ runId: string }> {
      await requireBot(input.botId);
      const existing = await owned(input.botId, input.routineId);
      if (await dependencies.isPaused?.(input.botId)) throw new Error("This Bot is paused. Resume it to continue.");
      // Checked here: the scheduler checks it only once the run is under way,
      // after this call has already answered with a run id.
      if (input.expectedUpdatedAt !== undefined && existing.updatedAt !== input.expectedUpdatedAt) {
        throw new Error("This routine changed. Refresh it before trying again.");
      }
      const runId = randomUUID();
      // Throws at once when the routine is already running.
      const completion = dependencies.service.runNow(existing.id, {
        runId,
        ...(input.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}),
      });
      void completion.catch(() => undefined);
      return { runId };
    },

    async delete(input: BotRoutineDeleteInput): Promise<void> {
      const existing = await owned(input.botId, input.id);
      await dependencies.service.remove(existing.id, {
        expectedUpdatedAt: input.expectedUpdatedAt ?? existing.updatedAt,
      });
      await dependencies.routineDeleted?.(input.botId, existing.id);
      dependencies.notifyChanged({ botId: input.botId, routineId: existing.id, removed: true });
    },

    /**
     * Deletes every routine a Bot owns, cancelling any live run first. Called
     * by Bot deletion; safe to repeat. Returns the removed routine ids.
     */
    async deleteRoutinesForBot(botId: string): Promise<string[]> {
      const removed: string[] = [];
      for (const task of await dependencies.store.list()) {
        if (task.botId !== botId) continue;
        try {
          await dependencies.service.remove(task.id);
        } catch (error) {
          // A concurrent removal already finished the job.
          if (await dependencies.store.get(task.id)) throw error;
          continue;
        }
        removed.push(task.id);
        dependencies.notifyChanged({ botId, routineId: task.id, removed: true });
      }
      return removed;
    },
  };
}

export type BotRoutineService = ReturnType<typeof createBotRoutineService>;

// ---------------------------------------------------------------------------
// Catch-up after a paused Bot resumes (spec 2026-10-09 §11.2)
// ---------------------------------------------------------------------------

export interface BotRoutineCatchUpDependencies {
  store: {
    list(): Promise<ScheduledTask[]>;
    /** Newest first. */
    runs(taskId: string): Promise<ScheduledRun[]>;
  };
  scheduler: {
    catchUp(id: string, missed: { runId: string; at: number }): Promise<ScheduledRun> | undefined;
  };
  now?: () => number;
}

/**
 * Re-runs, once, the newest fire each enabled routine skipped while its Bot
 * was paused, including a one-time routine spent by that fire. The run
 * records are the only state: a routine qualifies when
 * its newest run is a `bot_paused` skip less than 7 days old, so several
 * misses coalesce into one, and a later run of any kind ends the catch-up.
 */
export function createBotRoutineCatchUp(dependencies: BotRoutineCatchUpDependencies) {
  const now = dependencies.now ?? Date.now;
  return {
    async catchUp(botId: string): Promise<Array<{ taskId: string; completion: Promise<ScheduledRun> }>> {
      const dispatched: Array<{ taskId: string; completion: Promise<ScheduledRun> }> = [];
      for (const task of await dependencies.store.list()) {
        if (task.botId !== botId || (!task.enabled && task.routineSchedule?.kind !== "once")) continue;
        const [newest] = await dependencies.store.runs(task.id);
        if (newest?.result !== "skipped" || newest.reason !== "bot_paused") continue;
        if (now() - newest.startedAt >= BOT_ROUTINE_CATCH_UP_WINDOW_MS) continue;
        const completion = dependencies.scheduler.catchUp(task.id, { runId: newest.id, at: newest.startedAt });
        if (completion) dispatched.push({ taskId: task.id, completion });
      }
      return dispatched;
    },
  };
}

/**
 * Watches Bot session states and calls `catchUp` when a Bot leaves the
 * paused state (Resume or Dismiss), or the first time a Bot is seen running
 * normally (its pause may predate this listener). Ordinary idle and running
 * changes never catch up; `catchUp` itself is safe to repeat.
 */
export function createBotRoutineCatchUpTrigger(catchUp: (botId: string) => void) {
  const last = new Map<string, string>();
  return (botId: string, state: { kind: string }): void => {
    // Another process holding Bots says nothing about this Bot's pause.
    if (state.kind === "unavailable") return;
    const previous = last.get(botId);
    last.set(botId, state.kind);
    // A person-paused Bot is held like an interrupted one: nothing catches up
    // until it runs again. Its own `paused_by_person` skips never catch up.
    if (state.kind === "interrupted" || state.kind === "paused") return;
    if (previous !== undefined && previous !== "interrupted" && previous !== "paused") return;
    catchUp(botId);
  };
}

// ---------------------------------------------------------------------------
// Skipped while paused (plan §7.1, decision 4a)
// ---------------------------------------------------------------------------

/**
 * The routines of `botId` that fired while it was paused (since `since`),
 * with how many fires each skipped, for the notice written on unpause. The
 * run records are the only state; routines with no such skip are left out.
 */
export async function countSkippedWhilePaused(
  store: { list(): Promise<ScheduledTask[]>; runs(id: string): Promise<ScheduledRun[]> },
  botId: string,
  since: number,
): Promise<{ routineId: string; name: string; count: number }[]> {
  const skipped: { routineId: string; name: string; count: number }[] = [];
  const tasks = (await store.list())
    .filter((task) => task.botId === botId)
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const task of tasks) {
    let count = 0;
    for (const run of await store.runs(task.id)) {
      if (run.startedAt < since) continue;
      if (run.result === "skipped" && run.reason === "paused_by_person") count += 1;
    }
    if (count > 0) skipped.push({ routineId: task.id, name: task.name?.trim() || "Routine", count });
  }
  return skipped;
}
