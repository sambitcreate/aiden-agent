import { randomUUID } from "node:crypto";
import { formatBotRoutineLabel } from "../../renderer/shared/bot-routine-label.js";
import {
  parseBotRoutineSchedule,
  type BotRoutineSchedule,
} from "../../renderer/shared/bot-routine-schedule.js";
import { isPathSafeBotCapabilityId } from "../../renderer/shared/bot-capabilities.js";
import { BOT_LIMITS } from "../../renderer/shared/bots.js";
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

/** Stable idempotency key for one routine firing (or one explicit manual run). */
export function botRoutineRequestId(taskId: string, trigger: ScheduledRunTrigger): string {
  return trigger.kind === "automatic"
    ? `routine:${taskId}:${trigger.fireTime}`
    : `routine:${taskId}:manual-${trigger.key}`;
}

/** The message a routine submits to its Bot: the person's words plus the silence rule. */
export function botRoutineMessage(prompt: string): string {
  return `${prompt.trim()}\n\n${BOT_ROUTINE_SILENT_INSTRUCTION}`;
}

export function isSilentBotRoutineReply(text: string): boolean {
  return text.trim() === BOT_ROUTINE_SILENT_TOKEN;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface BotRoutineExecutorDependencies {
  store: {
    recordRun(run: Omit<ScheduledRun, "id"> & { id?: string }): Promise<ScheduledRun>;
  };
  /** Late-bound so the Bot runtime can be swapped in after the scheduler is built. */
  ports(): BotRoutinePorts | Promise<BotRoutinePorts>;
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
}

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

export function createBotRoutineExecutor(dependencies: BotRoutineExecutorDependencies) {
  const now = dependencies.now ?? Date.now;

  async function execute(
    task: ScheduledTask & { botId: string },
    trigger: ScheduledRunTrigger,
    signal: AbortSignal,
  ): Promise<BotRoutineOutcome> {
    const prompt = task.prompt?.trim();
    if (!prompt) throw new Error("This routine has no message.");
    const ports = await dependencies.ports();
    if (signal.aborted) throw new Error("Routine was cancelled.");
    const state = await abortable(ports.state(task.botId), signal);
    // A paused (interrupted) Bot turn belongs to the person: a routine must
    // neither resume nor dismiss it, so the firing is recorded and dropped.
    if (state.kind === "interrupted") {
      return { result: "skipped", reason: "bot_paused", output: "", surface: false };
    }
    if (state.kind === "needs_model") {
      throw new Error("This Bot needs an AI model before its routines can run.");
    }
    if (state.kind === "unavailable") {
      throw new Error("Bots are open in another Aiden window.");
    }
    let submission: { submissionId: string; deduped: boolean };
    try {
      submission = await abortable(
        ports.send(task.botId, {
          text: botRoutineMessage(prompt),
          requestId: botRoutineRequestId(task.id, trigger),
          ifNotInterrupted: true,
          ...(task.name?.trim() ? { label: task.name.trim() } : {}),
        }),
        signal,
      );
    } catch (error) {
      // The Bot was interrupted between the state check and the send.
      if ((error as { reason?: unknown } | null)?.reason === "bot_paused") {
        return { result: "skipped", reason: "bot_paused", output: "", surface: false };
      }
      throw error;
    }
    if (submission.deduped) {
      return { result: "skipped", reason: "duplicate", output: "", surface: false };
    }
    const outcome = await abortable(
      ports.awaitReply(task.botId, submission.submissionId, signal),
      signal,
    );
    if (outcome.kind === "failed") throw new Error(outcome.error);
    if (outcome.kind === "interrupted") {
      throw new Error("The Bot was interrupted while working on this routine.");
    }
    if (isSilentBotRoutineReply(outcome.text)) {
      await ports.markSilent(task.botId, submission.submissionId);
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
      let outcome: BotRoutineOutcome;
      try {
        outcome = await execute(task as ScheduledTask & { botId: string }, trigger, options.signal);
      } catch (error) {
        const cancelled = options.signal.aborted;
        outcome = {
          result: cancelled ? "blocked" : "error",
          output: "",
          error: cancelled ? "Routine was cancelled." : message(error),
          // Failures always surface; a cancellation is the person's own action.
          surface: !cancelled,
        };
      }
      const run = await dependencies.store.recordRun({
        id: options.runId,
        taskId: task.id,
        startedAt,
        finishedAt: now(),
        result: outcome.result,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        output: outcome.output,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      });
      if (outcome.surface) dependencies.notify(task, outcome.error ?? outcome.output);
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
  updatedAt: number;
}

export interface BotRoutineCreateInput {
  botId: string;
  name: string;
  schedule: BotRoutineSchedule;
  prompt: string;
  timezone?: string;
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
  };
  botExists(botId: string): Promise<boolean>;
  defaultTimezone(): string;
  notifyChanged(payload: { botId: string; routineId: string; removed?: boolean }): void;
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

  return {
    async list(botId: string): Promise<BotRoutine[]> {
      const at = now();
      return (await dependencies.store.list())
        .filter((task): task is ScheduledTask & { botId: string } => task.botId === botId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((task) => projectBotRoutine(task, at));
    },

    async create(input: BotRoutineCreateInput): Promise<BotRoutine> {
      await requireBot(input.botId);
      const task = await dependencies.service.save({
        name: input.name,
        mode: "llm",
        cron: "",
        timezone: input.timezone ?? dependencies.defaultTimezone(),
        prompt: input.prompt,
        permission: "read-only",
        botId: input.botId,
        routineSchedule: input.schedule,
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

    async delete(input: BotRoutineDeleteInput): Promise<void> {
      const existing = await owned(input.botId, input.id);
      await dependencies.service.remove(existing.id, {
        expectedUpdatedAt: input.expectedUpdatedAt ?? existing.updatedAt,
      });
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
