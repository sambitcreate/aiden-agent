import { createHash, randomBytes } from "node:crypto";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import type { AidenRemoteModelService } from "./aiden-remote-models.js";
import {
  AidenIdempotencyLedger,
  type AidenIdempotencySnapshot,
} from "./aiden-remote-operation-contract.js";
import type { ScheduledTaskApplicationService } from "./scheduled-task-application-service.js";
import { scheduledTaskRevision } from "./scheduled-task-application-service.js";
import type {
  ScheduledRun,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskMode,
  ScheduledTaskPermission,
} from "./types.js";

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{16,128}$/u;
const TASK_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/u;
const SCRIPT_ID_PATTERN = /^script_[A-Za-z0-9_-]{43}$/u;
const SCRIPT_CLAIM_TTL_MS = 10 * 60_000;
const MAX_SCRIPT_CLAIMS = 4_096;

interface ScriptClaim {
  deviceId: string;
  workspaceId?: string;
  name: string;
  expiresAt: number;
}

export interface AidenRemoteScheduledTaskProjection {
  id: string;
  revision: string;
  name: string;
  enabled: boolean;
  schedule: string;
  timezone: string;
  mode: ScheduledTaskMode;
  permission: ScheduledTaskPermission;
  workspaceId?: string;
  providerId?: string;
  modelId?: string;
  mcpServerIds?: string[];
  scriptId?: string;
  prompt?: string;
  notify: boolean;
  running: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  lastResult?: string;
  createdAt: string;
  updatedAt: string;
}

function ownRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(record, key))
    && Object.keys(record).every((key) => allowed.has(key));
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && [...value].length <= maximum;
}

function boundedIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64) return undefined;
  const ids = value.map((item) => boundedString(item, 256) ? item : "");
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return undefined;
  return ids;
}

function safeTaskId(value: string): string {
  if (!TASK_ID_PATTERN.test(value)) {
    throw new AidenRemoteServiceError("invalid_request", "The scheduled-task identifier is invalid.", 400);
  }
  return value;
}

function timestamp(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

function redactSummary(value: string): string {
  return [...value
    .replace(/\/(?:Users|home)\/[^\s"'`]+/gu, "[local path]")
    .replace(/\b(?:sk|key|token|secret|bearer)[-_][A-Za-z0-9._-]{12,}\b/giu, "[redacted]")]
    .slice(0, 20_000)
    .join("");
}

function mapRun(run: ScheduledRun) {
  const failed = run.result === "error" || run.result === "blocked";
  const summary = redactSummary(run.error ?? run.output);
  return {
    id: run.id,
    taskId: run.taskId,
    status: failed ? "failed" as const : "succeeded" as const,
    startedAt: new Date(run.startedAt).toISOString(),
    finishedAt: new Date(run.finishedAt).toISOString(),
    ...(summary ? { summary } : {}),
    ...(failed ? { errorCode: run.result === "blocked" ? "blocked" : "execution_failed" } : {}),
  };
}

function mapError(error: unknown): never {
  if (error instanceof AidenRemoteServiceError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (/not found/iu.test(message)) {
    throw new AidenRemoteServiceError("not_found", "This scheduled task no longer exists.", 404);
  }
  if (/changed|revision/iu.test(message)) {
    throw new AidenRemoteServiceError("revision_conflict", "This scheduled task changed. Refresh it before trying again.", 409);
  }
  if (/already running/iu.test(message)) {
    throw new AidenRemoteServiceError("operation_in_progress", "This scheduled task is already running.", 409, true);
  }
  if (/workspace|script|provider|model|MCP|cron|schedule|timezone|permission|prompt/iu.test(message)) {
    throw new AidenRemoteServiceError("invalid_request", message.slice(0, 500), 400);
  }
  throw new AidenRemoteServiceError("internal_error", "Aiden could not complete this scheduled-task request.", 500);
}

export class AidenRemoteScheduleService {
  private readonly idempotency: AidenIdempotencyLedger;
  private readonly scriptClaims = new Map<string, ScriptClaim>();

  constructor(
    private readonly options: {
      application: Pick<ScheduledTaskApplicationService,
        "list" | "get" | "save" | "remove" | "pause" | "resume" | "runNow" | "runs" | "preview" | "scripts" | "mcpServers" | "settings" | "updateSettings" | "isRunning">;
      models: Pick<AidenRemoteModelService, "resolve">;
      idempotency?: AidenIdempotencyLedger;
      persistIdempotency?: (snapshot: AidenIdempotencySnapshot) => Promise<void>;
      now?: () => number;
    },
  ) {
    this.idempotency = options.idempotency ?? new AidenIdempotencyLedger();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private pruneScripts(): void {
    const now = this.now();
    for (const [digest, claim] of this.scriptClaims) {
      if (claim.expiresAt <= now) this.scriptClaims.delete(digest);
    }
  }

  private issueScript(deviceId: string, workspaceId: string | undefined, name: string): string {
    this.pruneScripts();
    if (this.scriptClaims.size >= MAX_SCRIPT_CLAIMS) {
      const oldest = this.scriptClaims.keys().next().value as string | undefined;
      if (oldest) this.scriptClaims.delete(oldest);
    }
    const token = `script_${randomBytes(32).toString("base64url")}`;
    this.scriptClaims.set(createHash("sha256").update(token).digest("base64url"), {
      deviceId,
      ...(workspaceId ? { workspaceId } : {}),
      name,
      expiresAt: this.now() + SCRIPT_CLAIM_TTL_MS,
    });
    return token;
  }

  private consumeScript(deviceId: string, workspaceId: string | undefined, token: string): string {
    this.pruneScripts();
    if (!SCRIPT_ID_PATTERN.test(token)) {
      throw new AidenRemoteServiceError("handle_invalid", "This script selection is invalid.", 400);
    }
    const claim = this.scriptClaims.get(createHash("sha256").update(token).digest("base64url"));
    if (!claim) throw new AidenRemoteServiceError("handle_expired", "This script selection expired. Refresh the inventory.", 410);
    if (claim.deviceId !== deviceId) throw new AidenRemoteServiceError("handle_wrong_device", "This script selection belongs to another device.", 403);
    if (claim.workspaceId !== workspaceId) throw new AidenRemoteServiceError("operation_stale", "This script selection belongs to another workspace.", 409);
    return claim.name;
  }

  private project(deviceId: string, task: ScheduledTask): AidenRemoteScheduledTaskProjection {
    return {
      id: task.id,
      revision: scheduledTaskRevision(task),
      name: [...task.name].slice(0, 120).join(""),
      enabled: task.enabled,
      schedule: task.cron,
      timezone: task.timezone,
      mode: task.mode,
      permission: task.permission,
      ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
      ...(task.providerId ? { providerId: task.providerId } : {}),
      ...(task.model ? { modelId: task.model } : {}),
      ...(task.mcpServerIds ? { mcpServerIds: [...task.mcpServerIds] } : {}),
      ...(task.script ? { scriptId: this.issueScript(deviceId, task.workspaceId, task.script) } : {}),
      ...(task.prompt ? { prompt: task.prompt } : {}),
      notify: task.notify,
      running: this.options.application.isRunning(task.id),
      ...(timestamp(task.nextRunAt) ? { nextRunAt: timestamp(task.nextRunAt)! } : {}),
      ...(timestamp(task.lastRunAt) ? { lastRunAt: timestamp(task.lastRunAt)! } : {}),
      ...(task.lastResult ? { lastResult: task.lastResult } : {}),
      createdAt: new Date(task.createdAt).toISOString(),
      updatedAt: new Date(task.updatedAt).toISOString(),
    };
  }

  private async mutation(deviceId: string, value: unknown): Promise<ScheduledTaskInput> {
    const record = ownRecord(value);
    if (!record || !exactKeys(record,
      ["name", "schedule", "timezone", "mode", "permission", "confirmedForeground"],
      ["workspaceId", "providerId", "modelId", "mcpServerIds", "scriptId", "prompt", "notify"],
    ) || record.confirmedForeground !== true || !boundedString(record.name, 120)
      || !boundedString(record.schedule, 500) || !boundedString(record.timezone, 120)
      || (record.mode !== "llm" && record.mode !== "script")
      || (record.permission !== "full" && record.permission !== "read-only")
      || (record.workspaceId !== undefined && !boundedString(record.workspaceId, 128))
      || (record.notify !== undefined && typeof record.notify !== "boolean")) {
      throw new AidenRemoteServiceError("permission_confirmation_required", "Creating or editing unattended work requires final foreground review.", 409);
    }
    const workspaceId = typeof record.workspaceId === "string" ? record.workspaceId : undefined;
    const ids = boundedIds(record.mcpServerIds);
    if (record.mcpServerIds !== undefined && ids === undefined) {
      throw new AidenRemoteServiceError("invalid_request", "The selected MCP scope is invalid.", 400);
    }
    if (record.mode === "llm") {
      if (!boundedString(record.prompt, 32 * 1_024)) {
        throw new AidenRemoteServiceError("invalid_request", "Ask Aiden tasks require a bounded prompt.", 400);
      }
      const resolved = await this.options.models.resolve(
        typeof record.providerId === "string" ? record.providerId : undefined,
        typeof record.modelId === "string" ? record.modelId : undefined,
      );
      return {
        name: record.name.trim(), mode: "llm", cron: record.schedule.trim(), timezone: record.timezone.trim(),
        permission: record.permission, prompt: record.prompt, providerId: resolved.providerId,
        model: resolved.modelId, ...(workspaceId ? { workspaceId } : {}),
        ...(ids ? { mcpServerIds: ids } : {}), ...(typeof record.notify === "boolean" ? { notify: record.notify } : {}),
      };
    }
    if (record.permission !== "full" || typeof record.scriptId !== "string") {
      throw new AidenRemoteServiceError("invalid_request", "Script tasks require Full permission and a current script selection.", 400);
    }
    return {
      name: record.name.trim(), mode: "script", cron: record.schedule.trim(), timezone: record.timezone.trim(),
      permission: "full", script: this.consumeScript(deviceId, workspaceId, record.scriptId),
      ...(workspaceId ? { workspaceId } : {}), ...(typeof record.notify === "boolean" ? { notify: record.notify } : {}),
    };
  }

  private async executeIdempotent<T>(
    scope: { deviceId: string; route: string; resourceId: string; key: string },
    input: unknown,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!IDEMPOTENCY_KEY_PATTERN.test(scope.key)) {
      throw new AidenRemoteServiceError("invalid_request", "Idempotency-Key is invalid.", 400);
    }
    if (!this.options.persistIdempotency) return this.idempotency.execute(scope, input, action);
    let release!: () => void;
    let reject!: (error: unknown) => void;
    const admission = new Promise<void>((resolve, rejectPromise) => { release = resolve; reject = rejectPromise; });
    const pending = this.idempotency.execute(scope, input, async () => { await admission; return action(); });
    try {
      await this.options.persistIdempotency(this.idempotency.snapshot());
      release();
    } catch (error) {
      reject(error);
      await pending.catch(() => undefined);
      throw new AidenRemoteServiceError("internal_error", "Aiden could not durably prepare this scheduled-task request.", 500);
    }
    let result: T | undefined;
    let failure: unknown;
    try { result = await pending; } catch (error) { failure = error; }
    try {
      await this.options.persistIdempotency(this.idempotency.snapshot());
    } catch {
      throw new AidenRemoteServiceError("idempotency_in_flight", "The scheduled-task change may have completed, but Aiden could not record its outcome.", 409);
    }
    if (failure) throw failure;
    return result!;
  }

  async list(deviceId: string) {
    return { tasks: (await this.options.application.list()).map((task) => this.project(deviceId, task)) };
  }

  async get(deviceId: string, taskId: string) {
    try { return this.project(deviceId, await this.options.application.get(safeTaskId(taskId))); }
    catch (error) { mapError(error); }
  }

  async create(deviceId: string, key: string, value: unknown) {
    const input = await this.mutation(deviceId, value);
    try {
      return await this.executeIdempotent(
        { deviceId, route: "POST /scheduled-tasks", resourceId: "scheduled-tasks", key },
        value,
        async () => this.project(deviceId, await this.options.application.save(input)),
      );
    } catch (error) { mapError(error); }
  }

  async update(deviceId: string, taskId: string, revision: string, value: unknown) {
    const id = safeTaskId(taskId);
    const input = { ...(await this.mutation(deviceId, value)), id };
    try { return this.project(deviceId, await this.options.application.save(input, { expectedRevision: revision })); }
    catch (error) { mapError(error); }
  }

  async remove(taskId: string, revision: string): Promise<void> {
    try { await this.options.application.remove(safeTaskId(taskId), revision); }
    catch (error) { mapError(error); }
  }

  async pause(deviceId: string, taskId: string, revision: string, key: string) {
    const id = safeTaskId(taskId);
    try {
      return await this.executeIdempotent(
        { deviceId, route: `POST /scheduled-tasks/${id}/pause`, resourceId: id, key },
        { revision },
        async () => this.project(deviceId, await this.options.application.pause(id, revision)),
      );
    } catch (error) { mapError(error); }
  }

  async resume(deviceId: string, taskId: string, revision: string, key: string) {
    const id = safeTaskId(taskId);
    try {
      return await this.executeIdempotent(
        { deviceId, route: `POST /scheduled-tasks/${id}/resume`, resourceId: id, key },
        { revision },
        async () => this.project(deviceId, await this.options.application.resume(id, revision)),
      );
    } catch (error) { mapError(error); }
  }

  async run(deviceId: string, taskId: string, key: string) {
    const id = safeTaskId(taskId);
    const runId = `run_${randomBytes(24).toString("base64url")}`;
    try {
      return await this.executeIdempotent(
        { deviceId, route: `POST /scheduled-tasks/${id}/run`, resourceId: id, key },
        {},
        async () => {
          await this.options.application.runNow(id, runId);
          return { taskId: id, runId, status: "accepted" as const, acceptedAt: new Date(this.now()).toISOString() };
        },
      );
    } catch (error) { mapError(error); }
  }

  async runs(taskId: string) {
    try { return { runs: (await this.options.application.runs(safeTaskId(taskId))).map(mapRun) }; }
    catch (error) { mapError(error); }
  }

  preview(value: unknown) {
    const record = ownRecord(value);
    if (!record || !exactKeys(record, ["cron", "timezone"], ["count"])
      || !boundedString(record.cron, 500) || !boundedString(record.timezone, 120)
      || (record.count !== undefined && (!Number.isInteger(record.count) || (record.count as number) < 1 || (record.count as number) > 20))) {
      throw new AidenRemoteServiceError("invalid_request", "The schedule preview request is invalid.", 400);
    }
    try {
      return { dates: this.options.application.preview(record.cron, record.timezone, typeof record.count === "number" ? record.count : 3).map((date) => new Date(date).toISOString()) };
    } catch (error) { mapError(error); }
  }

  async scripts(deviceId: string, workspaceId?: string) {
    try {
      return { scripts: (await this.options.application.scripts(workspaceId)).map((name) => ({ id: this.issueScript(deviceId, workspaceId, name), name })) };
    } catch (error) { mapError(error); }
  }

  async mcpServers() {
    try {
      const servers = await this.options.application.mcpServers();
      return {
        servers: servers.slice(0, 4_000).map((server) => {
          if (!boundedString(server.id, 256) || !boundedString(server.name, 256)) {
            throw new Error("MCP inventory contains an invalid entry.");
          }
          return { id: server.id, name: server.name };
        }),
      };
    } catch (error) { mapError(error); }
  }

  async settings() {
    const current = await this.options.application.settings();
    return { revision: current.revision, ...current.value };
  }

  async updateSettings(revision: string, value: unknown) {
    const record = ownRecord(value);
    if (!record || record.confirmedForeground !== true || !exactKeys(record, ["confirmedForeground"], ["enabled", "defaultMode", "defaultPermission", "defaultMcpEnabled", "defaultNotify", "defaultTimezone"]) || Object.keys(record).length < 2) {
      throw new AidenRemoteServiceError("permission_confirmation_required", "Scheduled-task settings require explicit foreground confirmation.", 409);
    }
    if ((record.enabled !== undefined && typeof record.enabled !== "boolean")
      || (record.defaultMode !== undefined && record.defaultMode !== "llm" && record.defaultMode !== "script")
      || (record.defaultPermission !== undefined && record.defaultPermission !== "read-only" && record.defaultPermission !== "full")
      || (record.defaultMcpEnabled !== undefined && typeof record.defaultMcpEnabled !== "boolean")
      || (record.defaultNotify !== undefined && typeof record.defaultNotify !== "boolean")
      || (record.defaultTimezone !== undefined && !boundedString(record.defaultTimezone, 120))) {
      throw new AidenRemoteServiceError("invalid_request", "One or more scheduled-task settings are invalid.", 400);
    }
    const { confirmedForeground: _confirmed, ...patch } = record;
    try {
      const saved = await this.options.application.updateSettings(revision, patch);
      return { revision: saved.revision, ...saved.value };
    } catch (error) { mapError(error); }
  }
}
