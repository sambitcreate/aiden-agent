import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import { DataStore } from "./data-store.js";
import { migrateLegacyPiProviderId } from "../../renderer/shared/google-provider.js";
import { assertSafeScheduledPrompt } from "./schedule-guard.js";
import type {
  ScheduledRun,
  ScheduledRunResult,
  ScheduledTask,
  ScheduledTaskInput,
} from "./types.js";

const RUNS_PER_TASK = 50;
const STORED_OUTPUT_LIMIT = 64 * 1024;
const STORED_ERROR_LIMIT = 4 * 1024;

interface Persistence<T> {
  load(): Promise<T>;
  update<R>(mutation: (draft: T) => R | Promise<R>): Promise<R>;
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function validateTimezone(value: string): string {
  const timezone = value.trim() || systemTimezone();
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch {
    throw new Error(`Unknown timezone "${timezone}".`);
  }
  return timezone;
}

export function nextScheduledRun(cron: string, timezone: string, from = new Date()): number {
  const expression = cron.trim();
  if (!expression) throw new Error("A cron schedule is required.");
  let job: Cron;
  try {
    job = new Cron(expression, {
      paused: true,
      timezone: validateTimezone(timezone),
      mode: "5-or-6-parts",
    });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Invalid cron schedule.");
  }
  try {
    const next = job.nextRun(from);
    if (!next) throw new Error("This schedule has no future run.");
    return next.getTime();
  } finally {
    job.stop();
  }
}

export function nextScheduledRuns(
  cron: string,
  timezone: string,
  count: number,
  from = new Date(),
): number[] {
  const requested = Math.max(0, Math.min(10, Math.floor(count)));
  const job = new Cron(cron.trim(), {
    paused: true,
    timezone: validateTimezone(timezone),
    mode: "5-or-6-parts",
  });
  try {
    return job.nextRuns(requested, from).map((date) => date.getTime());
  } finally {
    job.stop();
  }
}

export function validateScriptName(value: string): string {
  const script = value.trim();
  if (
    !script ||
    script.length > 255 ||
    script === "." ||
    script === ".." ||
    script.includes("/") ||
    script.includes("\\") ||
    script.includes("\0")
  ) {
    throw new Error("Script must be a single file name from an allowed .aiden/scripts folder.");
  }
  return script;
}

function cleanOptional(value: string | undefined, limit = 512): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function normalizeInput(
  input: ScheduledTaskInput,
  existing: ScheduledTask | undefined,
  now: number,
): ScheduledTask {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new Error("Task name is required.");
  if (input.mode !== "llm" && input.mode !== "script") throw new Error("Invalid task mode.");
  const timezone = validateTimezone(input.timezone ?? existing?.timezone ?? systemTimezone());
  const cron = input.cron.trim();
  const enabled = input.enabled ?? existing?.enabled ?? true;
  const prompt = input.mode === "llm" ? cleanOptional(input.prompt, 32 * 1024) : undefined;
  const script = input.mode === "script" ? validateScriptName(input.script ?? "") : undefined;
  if (input.mode === "llm" && !prompt) throw new Error("LLM tasks require a prompt.");
  if (prompt) assertSafeScheduledPrompt(prompt);
  if (
    input.permission !== undefined &&
    input.permission !== "read-only" &&
    input.permission !== "full"
  ) {
    throw new Error("Invalid scheduled task permission.");
  }
  if (input.mode === "script" && input.permission !== "full") {
    throw new Error("Script tasks require Full permission because scripts can change the system.");
  }
  const workspaceId = cleanOptional(input.workspaceId);
  const nextRunAt = enabled ? nextScheduledRun(cron, timezone, new Date(now)) : undefined;
  return {
    id: existing?.id ?? cleanOptional(input.id, 160) ?? randomUUID(),
    name,
    enabled,
    mode: input.mode,
    cron,
    timezone,
    nextRunAt,
    lastRunAt: existing?.lastRunAt,
    workspaceId,
    providerId: cleanOptional(input.providerId),
    model: cleanOptional(input.model),
    prompt,
    script,
    permission: input.permission ?? existing?.permission ?? "read-only",
    chatId: workspaceId === existing?.workspaceId ? existing?.chatId : undefined,
    notify: input.notify ?? existing?.notify ?? true,
    lastResult: existing?.lastResult,
    lastError: existing?.lastError,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function isRunResult(value: unknown): value is ScheduledRunResult {
  return value === "success" || value === "error" || value === "silent" || value === "blocked";
}

function normalizeStoredTask(value: unknown): ScheduledTask | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const task = value as Record<string, unknown>;
  if (
    typeof task.id !== "string" ||
    !task.id ||
    typeof task.name !== "string" ||
    !task.name ||
    (task.mode !== "llm" && task.mode !== "script") ||
    typeof task.cron !== "string" ||
    typeof task.timezone !== "string" ||
    (task.permission !== "read-only" && task.permission !== "full") ||
    typeof task.createdAt !== "number" ||
    typeof task.updatedAt !== "number"
  ) {
    return null;
  }
  let scheduleError: string | undefined;
  try {
    nextScheduledRun(task.cron, task.timezone);
    if (task.mode === "llm") {
      if (typeof task.prompt !== "string" || !task.prompt.trim()) {
        throw new Error("LLM tasks require a prompt.");
      }
      assertSafeScheduledPrompt(task.prompt);
    } else {
      validateScriptName(typeof task.script === "string" ? task.script : "");
      if (task.permission !== "full") {
        throw new Error("Script tasks require Full permission.");
      }
    }
  } catch (error) {
    scheduleError = error instanceof Error ? error.message : "Invalid stored schedule.";
  }
  return {
    id: task.id,
    name: task.name,
    enabled: scheduleError ? false : task.enabled !== false,
    mode: task.mode,
    cron: task.cron,
    timezone: task.timezone,
    nextRunAt: scheduleError ? undefined : finiteTimestamp(task.nextRunAt),
    lastRunAt: finiteTimestamp(task.lastRunAt),
    workspaceId: typeof task.workspaceId === "string" ? task.workspaceId : undefined,
    // Resolve aliases only after config has had a chance to protect an edited
    // legacy preset (for example, a custom `gemini` endpoint). The default
    // resolver below still upgrades untouched legacy IDs for standalone tests.
    providerId: typeof task.providerId === "string" ? task.providerId : undefined,
    model: typeof task.model === "string" ? task.model : undefined,
    prompt: typeof task.prompt === "string" ? task.prompt : undefined,
    script: typeof task.script === "string" ? task.script : undefined,
    permission: task.permission,
    chatId: typeof task.chatId === "string" ? task.chatId : undefined,
    notify: task.notify !== false,
    lastResult: scheduleError
      ? "error"
      : isRunResult(task.lastResult)
        ? task.lastResult
        : undefined,
    lastError: scheduleError
      ? `Needs attention: ${scheduleError}`
      : typeof task.lastError === "string"
        ? task.lastError
        : undefined,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function normalizeStoredRun(value: unknown): ScheduledRun | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const run = value as Record<string, unknown>;
  if (
    typeof run.id !== "string" ||
    typeof run.taskId !== "string" ||
    typeof run.startedAt !== "number" ||
    typeof run.finishedAt !== "number" ||
    !isRunResult(run.result) ||
    typeof run.output !== "string"
  ) {
    return null;
  }
  return {
    id: run.id,
    taskId: run.taskId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    result: run.result,
    output: run.output.slice(0, STORED_OUTPUT_LIMIT),
    error: typeof run.error === "string" ? run.error.slice(0, STORED_ERROR_LIMIT) : undefined,
    chatId: typeof run.chatId === "string" ? run.chatId : undefined,
  };
}

export function createScheduleStore(
  tasks: Persistence<unknown[]>,
  runs: Persistence<unknown[]>,
  now: () => number = Date.now,
  resolveProviderId: (providerId: string | undefined) => Promise<string | undefined> = async (
    providerId,
  ) => migrateLegacyPiProviderId(providerId),
) {
  const chatClaims = new Map<string, Promise<string>>();

  async function list(): Promise<ScheduledTask[]> {
    const normalized = (await tasks.load())
      .map(normalizeStoredTask)
      .filter((task): task is ScheduledTask => task !== null);
    const resolved = await Promise.all(
      normalized.map(async (task) => {
        const providerId = await resolveProviderId(task.providerId);
        return providerId === task.providerId ? task : { ...task, providerId };
      }),
    );
    const migratedIds = new Map(
      resolved
        .filter((task, index) => task.providerId !== normalized[index]?.providerId)
        .map((task) => [task.id, task.providerId]),
    );
    if (migratedIds.size > 0) {
      // Persist the safe alias on first read so a later Pi provider can never
      // inherit this schedule merely because it claims the historic ID.
      await tasks.update((draft) => {
        for (let index = 0; index < draft.length; index += 1) {
          const value = draft[index];
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          const id = (value as Record<string, unknown>).id;
          const providerId = typeof id === "string" ? migratedIds.get(id) : undefined;
          if (providerId !== undefined) draft[index] = { ...value, providerId };
        }
      });
    }
    return resolved.sort((a, b) => b.createdAt - a.createdAt);
  }

  async function get(id: string): Promise<ScheduledTask | undefined> {
    return (await list()).find((task) => task.id === id);
  }

  return {
    list,
    get,

    async save(input: ScheduledTaskInput): Promise<ScheduledTask> {
      const providerId = await resolveProviderId(input.providerId);
      const resolvedInput = providerId === input.providerId ? input : { ...input, providerId };
      return tasks.update((draft) => {
        const index = draft
          .map(normalizeStoredTask)
          .findIndex((task) => task?.id === resolvedInput.id);
        const existing = index >= 0 ? (normalizeStoredTask(draft[index]) ?? undefined) : undefined;
        if (resolvedInput.id && !existing)
          throw new Error(`Scheduled task ${resolvedInput.id} not found.`);
        const task = normalizeInput(resolvedInput, existing, now());
        if (index >= 0) draft[index] = task;
        else draft.push(task);
        return structuredClone(task);
      });
    },

    async setEnabled(id: string, enabled: boolean): Promise<ScheduledTask> {
      return tasks.update((draft) => {
        const index = draft.map(normalizeStoredTask).findIndex((task) => task?.id === id);
        const existing = index >= 0 ? normalizeStoredTask(draft[index]) : null;
        if (!existing) throw new Error(`Scheduled task ${id} not found.`);
        const timestamp = now();
        const task: ScheduledTask = {
          ...existing,
          enabled,
          nextRunAt: enabled
            ? nextScheduledRun(existing.cron, existing.timezone, new Date(timestamp))
            : undefined,
          updatedAt: timestamp,
        };
        draft[index] = task;
        return structuredClone(task);
      });
    },

    async updateRuntime(
      id: string,
      patch: Partial<
        Pick<
          ScheduledTask,
          "nextRunAt" | "lastRunAt" | "lastResult" | "lastError" | "chatId" | "enabled"
        >
      >,
    ): Promise<ScheduledTask> {
      return tasks.update((draft) => {
        const index = draft.map(normalizeStoredTask).findIndex((task) => task?.id === id);
        const existing = index >= 0 ? normalizeStoredTask(draft[index]) : null;
        if (!existing) throw new Error(`Scheduled task ${id} not found.`);
        const task = { ...existing, ...patch, updatedAt: now() };
        draft[index] = task;
        return structuredClone(task);
      });
    },

    async ensureChatId(id: string, create: () => Promise<{ id: string }>): Promise<string> {
      const existing = await get(id);
      if (!existing) throw new Error(`Scheduled task ${id} not found.`);
      if (existing.chatId) return existing.chatId;
      const pending = chatClaims.get(id);
      if (pending) return pending;
      const claim = (async () => {
        const latest = await get(id);
        if (!latest) throw new Error(`Scheduled task ${id} not found.`);
        if (latest.chatId) return latest.chatId;
        const chat = await create();
        const updated = await this.updateRuntime(id, { chatId: chat.id });
        return updated.chatId as string;
      })().finally(() => chatClaims.delete(id));
      chatClaims.set(id, claim);
      return claim;
    },

    async clearChatId(id: string, expectedChatId: string): Promise<void> {
      await tasks.update((draft) => {
        const index = draft.map(normalizeStoredTask).findIndex((task) => task?.id === id);
        const existing = index >= 0 ? normalizeStoredTask(draft[index]) : null;
        if (!existing) throw new Error(`Scheduled task ${id} not found.`);
        if (existing.chatId !== expectedChatId) return;
        draft[index] = { ...existing, chatId: undefined, updatedAt: now() };
      });
    },

    async remove(id: string): Promise<void> {
      await tasks.update((draft) => {
        const index = draft.findIndex((value) => normalizeStoredTask(value)?.id === id);
        if (index < 0) throw new Error(`Scheduled task ${id} not found.`);
        draft.splice(index, 1);
      });
      await runs.update((draft) => {
        const kept = draft.filter((value) => normalizeStoredRun(value)?.taskId !== id);
        draft.splice(0, draft.length, ...kept);
      });
    },

    async recordRun(run: Omit<ScheduledRun, "id"> & { id?: string }): Promise<ScheduledRun> {
      const stored: ScheduledRun = {
        ...run,
        id: run.id ?? randomUUID(),
        output: run.output.slice(0, STORED_OUTPUT_LIMIT),
        error: run.error?.slice(0, STORED_ERROR_LIMIT),
      };
      await runs.update((draft) => {
        const normalized = draft
          .map(normalizeStoredRun)
          .filter((value): value is ScheduledRun => value !== null);
        normalized.push(stored);
        const retained = normalized
          .filter((value) => value.taskId === stored.taskId)
          .sort((a, b) => b.startedAt - a.startedAt)
          .slice(0, RUNS_PER_TASK);
        const other = normalized.filter((value) => value.taskId !== stored.taskId);
        draft.splice(0, draft.length, ...other, ...retained);
      });
      await this.updateRuntime(stored.taskId, {
        lastRunAt: stored.finishedAt,
        lastResult: stored.result,
        lastError: stored.error,
      });
      return stored;
    },

    async runs(taskId: string): Promise<ScheduledRun[]> {
      return (await runs.load())
        .map(normalizeStoredRun)
        .filter((run): run is ScheduledRun => run?.taskId === taskId)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, RUNS_PER_TASK);
    },
  };
}

const taskPersistence = new DataStore<unknown[]>("schedules.json", []);
const runPersistence = new DataStore<unknown[]>("schedule-runs.json", []);

// Imported lazily to keep the pure schedule-store factory free from config I/O in tests.
const resolvePersistedProviderId = async (providerId: string | undefined) => {
  const { configStore } = await import("./config-store.js");
  return configStore.resolveProviderId(providerId);
};

export const scheduleStore = createScheduleStore(
  taskPersistence,
  runPersistence,
  Date.now,
  resolvePersistedProviderId,
);
export type ScheduleStore = ReturnType<typeof createScheduleStore>;
