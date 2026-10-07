import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import { migrateLegacyPiProviderId } from "../../renderer/shared/google-provider.js";
import {
  ASSISTANT_SCHEDULE_EXECUTION_PROFILE,
  assertAssistantScheduleExecutionBoundary,
  assertSafeScheduledPrompt,
  validateScheduledMcpServerIds,
} from "./schedule-guard.js";
import type {
  ScheduledRun,
  ScheduledRunResult,
  ScheduledRunSkipReason,
  ScheduledTask,
  ScheduledTaskInput,
} from "./types.js";
import { validateScheduledMcpServerBindings } from "./schedule-mcp-binding.js";
import { acpHarnessUnavailableReason } from "../../renderer/shared/acp-harness.js";
import {
  botRoutineCron,
  parseBotRoutineDate,
  parseBotRoutineSchedule,
  type BotRoutineSchedule,
} from "../../renderer/shared/bot-routine-schedule.js";
import { isPathSafeBotCapabilityId } from "../../renderer/shared/bot-capabilities.js";
import { BOT_LIMITS } from "../../renderer/shared/bots.js";

const RUNS_PER_TASK = 50;
const STORED_OUTPUT_LIMIT = 64 * 1024;
const STORED_ERROR_LIMIT = 4 * 1024;

interface Persistence<T> {
  load(): Promise<T>;
  update<R>(mutation: (draft: T) => R | Promise<R>, isCurrent?: () => boolean): Promise<R>;
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nextTaskRevision(timestamp: number, previous?: number): number {
  return previous === undefined ? timestamp : Math.max(timestamp, previous + 1);
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

function yearIn(timestamp: number, timezone: string): number {
  const year = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric" })
    .formatToParts(new Date(timestamp))
    .find((part) => part.type === "year")?.value;
  return Number(year);
}

/**
 * Bot routines run inside their Bot's own conversation with the Bot's model,
 * access, and tools; the generic workspace, script, MCP, provider, and
 * Assistant fields would grant a second authority, so they are refused.
 */
function assertBotRoutineShape(task: {
  botId: string;
  mode: string;
  workspaceId?: string;
  script?: string;
  mcpServerIds?: readonly string[];
  mcpServerBindings?: readonly unknown[];
  executionProfile?: string;
  providerId?: string;
  model?: string;
  providerFingerprint?: string;
  cron: string;
  routineSchedule: BotRoutineSchedule;
}): void {
  if (!isPathSafeBotCapabilityId(task.botId, BOT_LIMITS.idChars)) {
    throw new Error("Invalid routine Bot.");
  }
  if (
    task.mode !== "llm" ||
    task.workspaceId !== undefined ||
    task.script !== undefined ||
    (task.mcpServerIds?.length ?? 0) > 0 ||
    (task.mcpServerBindings?.length ?? 0) > 0 ||
    task.executionProfile !== undefined ||
    task.providerId !== undefined ||
    task.model !== undefined ||
    task.providerFingerprint !== undefined
  ) {
    throw new Error("A Bot routine only carries a message for its Bot.");
  }
  if (task.cron !== botRoutineCron(task.routineSchedule)) {
    throw new Error("The routine schedule does not match its timing.");
  }
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
  if (input.botId !== undefined && existing && existing.botId !== input.botId) {
    throw new Error("A routine cannot move to another Bot.");
  }
  const botId = existing?.botId ?? input.botId;
  if (botId === undefined && input.routineSchedule !== undefined) {
    throw new Error("Only Bot routines use a routine schedule.");
  }
  const routineSchedule =
    botId === undefined
      ? undefined
      : parseBotRoutineSchedule(input.routineSchedule ?? existing?.routineSchedule);
  const cron = routineSchedule ? botRoutineCron(routineSchedule) : input.cron.trim();
  const enabled = input.enabled ?? existing?.enabled ?? true;
  const prompt = input.mode === "llm" ? cleanOptional(input.prompt, 32 * 1024) : undefined;
  const script = input.mode === "script" ? validateScriptName(input.script ?? "") : undefined;
  if (input.mode === "llm" && !prompt) throw new Error("LLM tasks require a prompt.");
  const harnessReason = input.mode === "llm" ? acpHarnessUnavailableReason(input.providerId) : undefined;
  if (harnessReason) throw new Error(harnessReason);
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
  if (
    input.executionProfile !== undefined &&
    input.executionProfile !== ASSISTANT_SCHEDULE_EXECUTION_PROFILE
  ) {
    throw new Error("Invalid scheduled task execution profile.");
  }
  const workspaceId = cleanOptional(input.workspaceId);
  const permission = input.permission ?? existing?.permission ?? "read-only";
  const mcpServerIds =
    input.mcpServerIds === undefined
      ? existing?.mcpServerIds
      : validateScheduledMcpServerIds(input.mcpServerIds);
  const mcpServerBindings =
    input.mcpServerBindings === undefined
      ? existing?.mcpServerBindings
      : validateScheduledMcpServerBindings(input.mcpServerBindings);
  if ((mcpServerIds?.length ?? 0) > 0 && input.mode !== "llm") {
    throw new Error("Only Ask Aiden tasks can use MCP servers.");
  }
  if ((mcpServerIds?.length ?? 0) > 0 && permission !== "full") {
    throw new Error("MCP-enabled scheduled tasks require Full permission.");
  }
  const executionProfile = input.executionProfile ?? existing?.executionProfile;
  if (input.webSearchEnabled !== undefined && typeof input.webSearchEnabled !== "boolean") {
    throw new Error("Invalid scheduled task Web Search authority.");
  }
  const webSearchEnabled =
    input.mode === "llm" && executionProfile === undefined
      ? (input.webSearchEnabled ?? existing?.webSearchEnabled ?? false)
      : false;
  const mainOwnedAssistantUpdate = input.executionProfile === ASSISTANT_SCHEDULE_EXECUTION_PROFILE;
  const providerId =
    existing?.executionProfile === ASSISTANT_SCHEDULE_EXECUTION_PROFILE && !mainOwnedAssistantUpdate
      ? existing.providerId
      : cleanOptional(input.providerId);
  const model =
    existing?.executionProfile === ASSISTANT_SCHEDULE_EXECUTION_PROFILE && !mainOwnedAssistantUpdate
      ? existing.model
      : cleanOptional(input.model);
  const providerFingerprint =
    existing?.executionProfile === ASSISTANT_SCHEDULE_EXECUTION_PROFILE && !mainOwnedAssistantUpdate
      ? existing.providerFingerprint
      : cleanOptional(input.providerFingerprint, 64);
  assertAssistantScheduleExecutionBoundary({
    executionProfile,
    mode: input.mode,
    permission,
    script,
    workspaceId,
    mcpServerIds,
    mcpServerBindings,
    providerId,
    model,
    providerFingerprint,
    webSearchEnabled,
  });
  if (botId !== undefined && routineSchedule) {
    assertBotRoutineShape({
      botId,
      mode: input.mode,
      workspaceId,
      script,
      mcpServerIds,
      mcpServerBindings,
      executionProfile,
      providerId,
      model,
      providerFingerprint,
      cron,
      routineSchedule,
    });
  }
  const nextRunAt = enabled ? nextScheduledRun(cron, timezone, new Date(now)) : undefined;
  if (
    routineSchedule?.kind === "once" &&
    nextRunAt !== undefined &&
    yearIn(nextRunAt, timezone) !== parseBotRoutineDate(routineSchedule.date).year
  ) {
    throw new Error("Pick a time in the future for this routine.");
  }
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
    providerId,
    model,
    providerFingerprint,
    prompt,
    script,
    permission,
    mcpServerIds,
    mcpServerBindings,
    executionProfile,
    webSearchEnabled,
    chatId: workspaceId === existing?.workspaceId ? existing?.chatId : undefined,
    ...(botId !== undefined ? { botId, routineSchedule } : {}),
    notify: input.notify ?? existing?.notify ?? true,
    lastResult: existing?.lastResult,
    lastError: existing?.lastError,
    createdAt: existing?.createdAt ?? now,
    updatedAt: nextTaskRevision(now, existing?.updatedAt),
  };
}

function isRunResult(value: unknown): value is ScheduledRunResult {
  return (
    value === "success" ||
    value === "error" ||
    value === "silent" ||
    value === "blocked" ||
    value === "skipped"
  );
}

function isSkipReason(value: unknown): value is ScheduledRunSkipReason {
  return value === "bot_paused" || value === "duplicate";
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
    (task.executionProfile !== undefined &&
      task.executionProfile !== ASSISTANT_SCHEDULE_EXECUTION_PROFILE) ||
    (task.webSearchEnabled !== undefined && typeof task.webSearchEnabled !== "boolean") ||
    typeof task.createdAt !== "number" ||
    typeof task.updatedAt !== "number"
  ) {
    return null;
  }
  const workspaceId = typeof task.workspaceId === "string" ? task.workspaceId : undefined;
  const prompt = typeof task.prompt === "string" ? task.prompt : undefined;
  const script = typeof task.script === "string" ? task.script : undefined;
  const executionProfile =
    task.executionProfile === ASSISTANT_SCHEDULE_EXECUTION_PROFILE
      ? ASSISTANT_SCHEDULE_EXECUTION_PROFILE
      : undefined;
  const webSearchEnabled =
    task.mode === "llm" && executionProfile === undefined && task.webSearchEnabled === true;
  const providerId = typeof task.providerId === "string" ? task.providerId : undefined;
  const model = typeof task.model === "string" ? task.model : undefined;
  const providerFingerprint =
    typeof task.providerFingerprint === "string" ? task.providerFingerprint : undefined;
  let mcpServerIds: string[] | undefined;
  let mcpServerBindings: ScheduledTask["mcpServerBindings"];
  let scheduleError: string | undefined;
  // A routine whose Bot identity is unreadable can never be attributed to a
  // Bot or a workspace again; dropping it is safer than reviving it as a
  // generic workspace task.
  if (task.botId !== undefined && !isPathSafeBotCapabilityId(task.botId, BOT_LIMITS.idChars)) {
    return null;
  }
  const botId = typeof task.botId === "string" ? task.botId : undefined;
  let routineSchedule: BotRoutineSchedule | undefined;
  try {
    if (botId !== undefined) {
      routineSchedule = parseBotRoutineSchedule(task.routineSchedule);
      assertBotRoutineShape({
        botId,
        mode: task.mode,
        workspaceId,
        script,
        mcpServerIds: Array.isArray(task.mcpServerIds) ? task.mcpServerIds : undefined,
        mcpServerBindings: Array.isArray(task.mcpServerBindings) ? task.mcpServerBindings : undefined,
        executionProfile,
        providerId,
        model,
        providerFingerprint,
        cron: task.cron,
        routineSchedule,
      });
    } else if (task.routineSchedule !== undefined) {
      throw new Error("Only Bot routines use a routine schedule.");
    }
    mcpServerIds = validateScheduledMcpServerIds(task.mcpServerIds);
    mcpServerBindings = validateScheduledMcpServerBindings(task.mcpServerBindings);
    nextScheduledRun(task.cron, task.timezone);
    if (task.mode === "llm") {
      if (!prompt?.trim()) {
        throw new Error("LLM tasks require a prompt.");
      }
      assertSafeScheduledPrompt(prompt);
      if ((mcpServerIds?.length ?? 0) > 0 && task.permission !== "full") {
        throw new Error("MCP-enabled scheduled tasks require Full permission.");
      }
    } else {
      validateScriptName(script ?? "");
      if (task.permission !== "full") {
        throw new Error("Script tasks require Full permission.");
      }
      if ((mcpServerIds?.length ?? 0) > 0) {
        throw new Error("Only Ask Aiden tasks can use MCP servers.");
      }
    }
    assertAssistantScheduleExecutionBoundary({
      executionProfile,
      mode: task.mode,
      permission: task.permission,
      script,
      workspaceId,
      mcpServerIds,
      mcpServerBindings,
      providerId,
      model,
      providerFingerprint,
      webSearchEnabled,
    });
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
    workspaceId,
    // Resolve aliases only after config has had a chance to protect an edited
    // legacy preset (for example, a custom `gemini` endpoint). The default
    // resolver below still upgrades untouched legacy IDs for standalone tests.
    providerId,
    model,
    providerFingerprint,
    prompt,
    script,
    permission: task.permission,
    mcpServerIds,
    mcpServerBindings,
    executionProfile,
    webSearchEnabled,
    chatId: typeof task.chatId === "string" ? task.chatId : undefined,
    ...(botId !== undefined ? { botId, ...(routineSchedule ? { routineSchedule } : {}) } : {}),
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
    ...(run.result === "skipped" && isSkipReason(run.reason) ? { reason: run.reason } : {}),
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
        .map((task, index) => [
          task.id,
          { from: normalized[index]?.providerId, to: task.providerId },
        ]),
    );
    if (migratedIds.size > 0) {
      // Persist the safe alias on first read so a later Pi provider can never
      // inherit this schedule merely because it claims the historic ID. Treat
      // the migration as a real revision, and do not overwrite a concurrent
      // edit that already selected another provider.
      await tasks.update((draft) => {
        for (let index = 0; index < draft.length; index += 1) {
          const value = draft[index];
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          const id = (value as Record<string, unknown>).id;
          const migration = typeof id === "string" ? migratedIds.get(id) : undefined;
          const current = normalizeStoredTask(value);
          if (!migration || !current || current.providerId !== migration.from) continue;
          draft[index] = {
            ...value,
            providerId: migration.to,
            updatedAt: nextTaskRevision(now(), current.updatedAt),
          };
        }
      });
      return list();
    }
    return resolved.sort((a, b) => b.createdAt - a.createdAt);
  }

  async function get(id: string): Promise<ScheduledTask | undefined> {
    return (await list()).find((task) => task.id === id);
  }

  async function restoreIfRevision(
    id: string,
    expectedUpdatedAt: number,
    previous: ScheduledTask | undefined,
  ): Promise<boolean> {
    return tasks.update((draft) => {
      const index = draft.map(normalizeStoredTask).findIndex((task) => task?.id === id);
      const current = index >= 0 ? normalizeStoredTask(draft[index]) : null;
      if (!current || current.updatedAt !== expectedUpdatedAt) return false;
      if (previous) draft[index] = previous;
      else draft.splice(index, 1);
      return true;
    });
  }

  async function updateRuntime(
    id: string,
    patch: Partial<
      Pick<
        ScheduledTask,
        "nextRunAt" | "lastRunAt" | "lastResult" | "lastError" | "chatId" | "enabled"
      >
    >,
    isCurrent: () => boolean = () => true,
  ): Promise<ScheduledTask> {
    return tasks.update((draft) => {
      const index = draft.map(normalizeStoredTask).findIndex((task) => task?.id === id);
      const existing = index >= 0 ? normalizeStoredTask(draft[index]) : null;
      if (!existing) throw new Error(`Scheduled task ${id} not found.`);
      if (patch.enabled === true) assertAssistantScheduleExecutionBoundary(existing);
      const task = {
        ...existing,
        ...patch,
        updatedAt: nextTaskRevision(now(), existing.updatedAt),
      };
      draft[index] = task;
      return structuredClone(task);
    }, isCurrent);
  }

  async function saveWithRollback(
    input: ScheduledTaskInput,
    isCurrent: () => boolean = () => true,
    expectedUpdatedAt?: number,
  ): Promise<{
    task: ScheduledTask;
    rollback(expectedUpdatedAt?: number): Promise<boolean>;
  }> {
    if (!isCurrent()) throw new Error("Scheduled task save was cancelled.");
    const providerId = await resolveProviderId(input.providerId);
    if (!isCurrent()) throw new Error("Scheduled task save was cancelled.");
    const resolvedInput = providerId === input.providerId ? input : { ...input, providerId };
    const saved = await tasks.update((draft) => {
      const index = draft
        .map(normalizeStoredTask)
        .findIndex((task) => task?.id === resolvedInput.id);
      const existing = index >= 0 ? (normalizeStoredTask(draft[index]) ?? undefined) : undefined;
      if (resolvedInput.id && !existing)
        throw new Error(`Scheduled task ${resolvedInput.id} not found.`);
      if (expectedUpdatedAt !== undefined && existing?.updatedAt !== expectedUpdatedAt) {
        throw new Error(
          "This automation changed before the edit was saved. List it again and retry.",
        );
      }
      const task = normalizeInput(resolvedInput, existing, now());
      if (index >= 0) draft[index] = task;
      else draft.push(task);
      return {
        task: structuredClone(task),
        previous: structuredClone(existing),
      };
    }, isCurrent);
    if (!isCurrent()) {
      await restoreIfRevision(saved.task.id, saved.task.updatedAt, saved.previous);
      throw new Error("Scheduled task save was cancelled.");
    }
    return {
      task: saved.task,
      rollback: (expectedRevision = saved.task.updatedAt) =>
        restoreIfRevision(saved.task.id, expectedRevision, saved.previous),
    };
  }

  return {
    list,
    get,

    saveWithRollback,

    async save(
      input: ScheduledTaskInput,
      isCurrent: () => boolean = () => true,
    ): Promise<ScheduledTask> {
      return (await saveWithRollback(input, isCurrent)).task;
    },

    restoreIfRevision,

    async setEnabled(id: string, enabled: boolean): Promise<ScheduledTask> {
      return tasks.update((draft) => {
        const index = draft.map(normalizeStoredTask).findIndex((task) => task?.id === id);
        const existing = index >= 0 ? normalizeStoredTask(draft[index]) : null;
        if (!existing) throw new Error(`Scheduled task ${id} not found.`);
        if (enabled) assertAssistantScheduleExecutionBoundary(existing);
        const timestamp = now();
        const task: ScheduledTask = {
          ...existing,
          enabled,
          nextRunAt: enabled
            ? nextScheduledRun(existing.cron, existing.timezone, new Date(timestamp))
            : undefined,
          updatedAt: nextTaskRevision(timestamp, existing.updatedAt),
        };
        draft[index] = task;
        return structuredClone(task);
      });
    },

    updateRuntime,

    async ensureChatId(
      id: string,
      create: (claimedChatId: string) => Promise<{ id: string }>,
    ): Promise<string> {
      const existing = await get(id);
      if (!existing) throw new Error(`Scheduled task ${id} not found.`);
      if (existing.chatId) return existing.chatId;
      const pending = chatClaims.get(id);
      if (pending) return pending;
      const claim = (async () => {
        const latest = await get(id);
        if (!latest) throw new Error(`Scheduled task ${id} not found.`);
        if (latest.chatId) return latest.chatId;
        // Persist the exact main-minted identity before chat creation. A crash
        // or failed schedule-store commit can therefore never leave a durable
        // chat without its task claim; a pre-create claim with no payload is
        // safely cleared by ensureChat on the next run.
        const claimedChatId = `scheduled-${randomUUID()}`;
        const updated = await updateRuntime(id, { chatId: claimedChatId });
        if (updated.chatId !== claimedChatId) {
          throw new Error("Could not claim the scheduled task's chat identity.");
        }
        const chat = await create(claimedChatId);
        if (chat.id !== claimedChatId) {
          throw new Error("Scheduled chat creation returned the wrong identity.");
        }
        return claimedChatId;
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
        draft[index] = {
          ...existing,
          chatId: undefined,
          updatedAt: nextTaskRevision(now(), existing.updatedAt),
        };
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

    async recordRun(
      run: Omit<ScheduledRun, "id"> & { id?: string },
      isCurrent: () => boolean = () => true,
    ): Promise<ScheduledRun> {
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
      }, isCurrent);
      await updateRuntime(stored.taskId, {
        lastRunAt: stored.finishedAt,
        lastResult: stored.result,
        lastError: stored.error,
      }, isCurrent);
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

export type ScheduleStore = ReturnType<typeof createScheduleStore>;
