import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  ASSISTANT_SCHEDULE_EXECUTION_PROFILE,
  assertSafeScheduledPrompt,
  recommendedScheduledPermission,
  validateScheduledMcpServerIds,
} from "./schedule-guard.js";
import { nextScheduledRun, systemTimezone, validateTimezone } from "./schedule-store.js";
import type {
  McpServer,
  ScheduledRun,
  ScheduledMcpServerBinding,
  ScheduledTask,
  ScheduledTaskInput,
  Workspace,
} from "./types.js";
import {
  assertScheduledMcpServerBindings,
  scheduledMcpServerBinding,
  validateScheduledMcpServerBindings,
} from "./schedule-mcp-binding.js";
import { SCHEDULED_PROVIDER_FINGERPRINT } from "./schedule-provider-binding.js";
import { declarePiRuntimeReplay } from "./pi-runtime-tool.js";
import {
  ASSISTANT_AUTOMATION_CRON_LIMIT,
  ASSISTANT_AUTOMATION_EDIT_TOOL_NAME,
  ASSISTANT_AUTOMATION_MCP_SERVER_ID_LIMIT,
  ASSISTANT_AUTOMATION_MCP_SERVER_NAME_LIMIT,
  ASSISTANT_AUTOMATION_MODEL_ID_LIMIT,
  ASSISTANT_AUTOMATION_MODEL_NAME_LIMIT,
  ASSISTANT_AUTOMATION_NAME_LIMIT,
  ASSISTANT_AUTOMATION_PROMPT_LIMIT,
  ASSISTANT_AUTOMATION_PROVIDER_ID_LIMIT,
  ASSISTANT_AUTOMATION_PROVIDER_NAME_LIMIT,
  ASSISTANT_AUTOMATION_TIMEZONE_LIMIT,
  ASSISTANT_AUTOMATION_TASK_ID_LIMIT,
  ASSISTANT_AUTOMATION_TOOL_NAME,
  ASSISTANT_AUTOMATION_WORKSPACE_ID_LIMIT,
  ASSISTANT_AUTOMATION_WORKSPACE_NAME_LIMIT,
  type AssistantAutomationApprovalDetails,
  type ScheduledTaskApprovalDetails,
} from "../../renderer/shared/assistant.js";
import { formatScheduledTaskCadence } from "../../renderer/shared/scheduled-task-presentation.js";

export const SCHEDULE_TOOL_NAME = ASSISTANT_AUTOMATION_TOOL_NAME;
export const EDIT_AUTOMATION_TOOL_NAME = ASSISTANT_AUTOMATION_EDIT_TOOL_NAME;
export const LIST_SCHEDULED_TASKS_TOOL_NAME = "list_scheduled_tasks";

type ScheduleToolAction = "create" | "update" | "list" | "pause" | "resume" | "remove" | "run_now";

interface ScheduleToolParams {
  action: ScheduleToolAction;
  id?: string;
  taskName?: string;
  expectedUpdatedAt?: number;
  name?: string;
  cron?: string;
  timezone?: string;
  mode?: "llm" | "script";
  prompt?: string;
  script?: string;
  workspaceId?: string;
  clearWorkspace?: boolean;
  permission?: "read-only" | "full";
  mcpServerIds?: string[];
  notify?: boolean;
}

interface EditAutomationToolParams {
  id: string;
  expectedUpdatedAt: number;
  name?: string;
  cron?: string;
  timezone?: string;
  prompt?: string;
  workspaceId?: string;
  clearWorkspace?: boolean;
  permission?: "read-only" | "full";
  mcpServerIds?: string[];
  notify?: boolean;
}

export interface AssistantScheduleModelSelection {
  providerId: string;
  providerName: string;
  model: string;
  modelName: string;
  providerFingerprint: string;
}

export type ScheduleToolAccess =
  | {
      kind: "standard";
      defaultWorkspaceId?: string;
      modelSelection?: AssistantScheduleModelSelection;
    }
  | {
      kind: "assistant-attended";
      modelSelection: AssistantScheduleModelSelection;
    };

export interface AssistantScheduleProposal {
  input: ScheduledTaskInput;
  expectedUpdatedAt?: number;
  details: Omit<
    AssistantAutomationApprovalDetails,
    "schedulerEnabled" | "workspaceName" | "mcpServerNames" | keyof AssistantScheduleModelSelection
  >;
}

const APPROVED_MCP_BINDINGS = Symbol("assistant-approved-mcp-bindings");

export function attachAssistantScheduleMcpApproval(
  args: unknown,
  bindings: readonly ScheduledMcpServerBinding[],
): void {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Automation approval arguments are invalid.");
  }
  Object.defineProperty(args, APPROVED_MCP_BINDINGS, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: structuredClone(bindings),
  });
}

function approvedMcpBindings(
  args: unknown,
  serverIds: readonly string[],
): ScheduledMcpServerBinding[] {
  if (serverIds.length === 0) return [];
  const bindings =
    args && typeof args === "object" && !Array.isArray(args)
      ? validateScheduledMcpServerBindings(
          (args as { [APPROVED_MCP_BINDINGS]?: unknown })[APPROVED_MCP_BINDINGS],
        )
      : undefined;
  if (
    bindings?.length !== serverIds.length ||
    serverIds.some((id, index) => bindings[index]?.id !== id)
  ) {
    throw new Error("The exact MCP approval expired before this automation could be saved.");
  }
  return bindings;
}

export function validateAssistantScheduleModelSelection(
  selection: AssistantScheduleModelSelection,
): AssistantScheduleModelSelection {
  const providerId = bounded(
    required(selection.providerId, "Provider ID"),
    "Provider ID",
    ASSISTANT_AUTOMATION_PROVIDER_ID_LIMIT,
  );
  const providerName = bounded(
    required(selection.providerName, "Provider name"),
    "Provider name",
    ASSISTANT_AUTOMATION_PROVIDER_NAME_LIMIT,
  );
  const model = bounded(
    required(selection.model, "Model ID"),
    "Model ID",
    ASSISTANT_AUTOMATION_MODEL_ID_LIMIT,
  );
  const modelName = bounded(
    required(selection.modelName, "Model name"),
    "Model name",
    ASSISTANT_AUTOMATION_MODEL_NAME_LIMIT,
  );
  if (!SCHEDULED_PROVIDER_FINGERPRINT.test(selection.providerFingerprint)) {
    throw new Error("Provider fingerprint is invalid.");
  }
  for (const [value, label] of [
    [providerId, "Provider ID"],
    [providerName, "Provider name"],
    [model, "Model ID"],
    [modelName, "Model name"],
  ] as const) {
    assertSafeDisplayText(value, label);
  }
  return {
    providerId,
    providerName,
    model,
    modelName,
    providerFingerprint: selection.providerFingerprint,
  };
}

function scheduleToolParams(value: unknown): Partial<ScheduleToolParams> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Partial<ScheduleToolParams>)
    : {};
}

export function scheduleToolRequiresApproval(value: unknown): boolean {
  return scheduleToolParams(value).action !== "list";
}

function approvalDisplayValue(value: unknown, limit: number, fallback: string): string {
  const candidate =
    typeof value === "string" ? value.replace(/\s+/gu, " ").trim().replace(/"/gu, "″") : "";
  if (!candidate) return fallback;
  const safe = [...candidate]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return !(
        codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        codePoint === 0x061c ||
        codePoint === 0x200e ||
        codePoint === 0x200f ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        codePoint === 0x2028 ||
        codePoint === 0x2029 ||
        (codePoint >= 0x2066 && codePoint <= 0x2069)
      );
    })
    .join("")
    .slice(0, limit);
  return safe || fallback;
}

function approvalTaskLabel(params: Partial<ScheduleToolParams>): string {
  const name = approvalDisplayValue(params.taskName, ASSISTANT_AUTOMATION_NAME_LIMIT, "");
  if (name) return `"${name}"`;
  return approvalDisplayValue(params.id, ASSISTANT_AUTOMATION_TASK_ID_LIMIT, "?");
}

function approvalScheduleLabel(
  cron: string | undefined,
  timezone: string | undefined,
  keepsExistingTimezone = false,
): string {
  const explicitTimezone = approvalDisplayValue(timezone, ASSISTANT_AUTOMATION_TIMEZONE_LIMIT, "");
  const resolvedTimezone = explicitTimezone || systemTimezone();
  const cadence = formatScheduledTaskCadence(cron?.trim() || "", resolvedTimezone);
  if (keepsExistingTimezone && !explicitTimezone) {
    return cadence === "Custom schedule"
      ? "custom schedule in the existing timezone"
      : `${cadence} (existing timezone)`;
  }
  return cadence === "Custom schedule" ? `custom schedule in ${resolvedTimezone}` : cadence;
}

export function summarizeScheduleToolCall(value: unknown): string {
  const params = scheduleToolParams(value);
  switch (params.action) {
    case "create":
      return `Create scheduled task "${approvalDisplayValue(params.name, ASSISTANT_AUTOMATION_NAME_LIMIT, "Untitled")}" (${approvalScheduleLabel(params.cron, params.timezone)}) with ${params.mode === "script" ? "Full" : params.permission === "full" || (params.mcpServerIds?.length ?? 0) > 0 ? "Full" : "read-only"} access${(params.mcpServerIds?.length ?? 0) > 0 ? " and MCP tools" : ""}`;
    case "update": {
      const changes = [
        params.name !== undefined ? "name" : undefined,
        params.cron !== undefined
          ? `schedule to ${approvalScheduleLabel(params.cron, params.timezone, true)}`
          : undefined,
        params.timezone !== undefined
          ? `timezone to ${approvalDisplayValue(params.timezone, ASSISTANT_AUTOMATION_TIMEZONE_LIMIT, "device default")}`
          : undefined,
        params.prompt !== undefined ? "instructions" : undefined,
        params.script !== undefined ? "script" : undefined,
        params.mode !== undefined ? `mode to ${params.mode}` : undefined,
        params.workspaceId !== undefined
          ? `project to ${approvalDisplayValue(params.workspaceId, ASSISTANT_AUTOMATION_WORKSPACE_ID_LIMIT, "none")}`
          : params.clearWorkspace
            ? "project to none"
            : undefined,
        params.permission !== undefined
          ? `access to ${params.permission}`
          : params.mode === "script" || (params.mcpServerIds?.length ?? 0) > 0
            ? "access to full"
            : undefined,
        params.mcpServerIds !== undefined
          ? `${params.mcpServerIds.length} MCP server${params.mcpServerIds.length === 1 ? "" : "s"}`
          : undefined,
        params.notify !== undefined ? `notifications ${params.notify ? "on" : "off"}` : undefined,
      ].filter((value): value is string => Boolean(value));
      return `Update scheduled task ${approvalTaskLabel(params)}${changes.length > 0 ? `: ${changes.join(", ")}` : ""}`;
    }
    case "pause":
      return `Pause scheduled task ${approvalTaskLabel(params)}`;
    case "resume":
      return `Resume scheduled task ${approvalTaskLabel(params)}`;
    case "remove":
      return `Delete scheduled task ${approvalTaskLabel(params)}`;
    case "run_now":
      return `Run scheduled task ${approvalTaskLabel(params)} now`;
    default:
      return "Manage scheduled tasks";
  }
}

export interface ScheduleToolDependencies {
  list(): Promise<ScheduledTask[]>;
  get(id: string): Promise<ScheduledTask | undefined>;
  save(
    input: ScheduledTaskInput,
    expectedUpdatedAt?: number,
    signal?: AbortSignal,
  ): Promise<ScheduledTask>;
  pause(id: string, expectedUpdatedAt: number, signal?: AbortSignal): Promise<ScheduledTask>;
  resume(id: string, expectedUpdatedAt: number, signal?: AbortSignal): Promise<ScheduledTask>;
  remove(id: string, expectedUpdatedAt: number, signal?: AbortSignal): Promise<void>;
  runNow(id: string, expectedUpdatedAt: number, signal?: AbortSignal): Promise<ScheduledRun>;
  getWorkspace(id: string): Promise<Workspace | undefined>;
  listMcpServers(): Promise<McpServer[]>;
  validateScript(input: { script: string; workspaceRoot?: string }): Promise<string>;
  isSchedulingEnabled(): Promise<boolean>;
}

const defaultDependencies: ScheduleToolDependencies = {
  list: async () => (await import("./schedule-store.js")).scheduleStore.list(),
  get: async (id) => (await import("./schedule-store.js")).scheduleStore.get(id),
  save: async (input, expectedUpdatedAt, signal) =>
    (await import("./schedule-service.js")).scheduleService.save(input, {
      expectedUpdatedAt,
      signal,
    }),
  pause: async (id, expectedUpdatedAt, signal) =>
    (await import("./schedule-service.js")).scheduleService.pause(id, {
      expectedUpdatedAt,
      signal,
    }),
  resume: async (id, expectedUpdatedAt, signal) =>
    (await import("./schedule-service.js")).scheduleService.resume(id, {
      expectedUpdatedAt,
      signal,
    }),
  remove: async (id, expectedUpdatedAt, signal) =>
    (await import("./schedule-service.js")).scheduleService.remove(id, {
      expectedUpdatedAt,
      signal,
    }),
  runNow: async (id, expectedUpdatedAt, signal) =>
    (await import("./schedule-service.js")).scheduleService.runNow(id, {
      expectedUpdatedAt,
      signal,
    }),
  getWorkspace: async (id) => (await import("./config-store.js")).configStore.getWorkspace(id),
  listMcpServers: async () => (await import("./config-store.js")).configStore.listMcpServers(),
  validateScript: async (input) =>
    (await import("./schedule-script.js")).resolveScheduledScript(input),
  isSchedulingEnabled: async () =>
    (await import("./config-store.js")).configStore
      .getSettings()
      .then((settings) => settings.scheduledTasksEnabled !== false),
};

function result(value: unknown): AgentToolResult<null> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: null,
  };
}

function throwIfScheduleToolAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Scheduled task action was cancelled.");
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required for this action.`);
  return normalized;
}

function requiredExpectedUpdatedAt(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("expectedUpdatedAt must be the exact revision returned by list.");
  }
  return value;
}

function verifyListedTaskIdentity(task: ScheduledTask, expectedName: string | undefined): void {
  const name = required(expectedName, "taskName");
  bounded(name, "taskName", ASSISTANT_AUTOMATION_NAME_LIMIT);
  assertSafeDisplayText(name, "taskName");
  if (name !== task.name) {
    throw new Error("This scheduled task changed. List tasks again before trying again.");
  }
}

function bounded(value: string, label: string, limit: number): string {
  if (value.length > limit) throw new Error(`${label} must be ${limit} characters or fewer.`);
  return value;
}

const ASSISTANT_CREATE_KEYS = new Set([
  "action",
  "name",
  "cron",
  "timezone",
  "prompt",
  "workspaceId",
  "permission",
  "mcpServerIds",
  "notify",
]);

const ASSISTANT_EDIT_KEYS = new Set([
  "id",
  "expectedUpdatedAt",
  "name",
  "cron",
  "timezone",
  "prompt",
  "workspaceId",
  "clearWorkspace",
  "permission",
  "mcpServerIds",
  "notify",
]);

function assertSafeDisplayText(value: string, label: string, multiline = false): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const allowedWhitespace =
      multiline && (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d);
    const unsafeControl =
      (!allowedWhitespace && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      (codePoint >= 0x2066 && codePoint <= 0x2069);
    if (unsafeControl) {
      throw new Error(`${label} contains unsupported control characters.`);
    }
  }
}

/**
 * Normalizes the attended Assistant proposal before approval and before save.
 * Reusing this exact path keeps the approved fields and persisted fields aligned.
 */
export function prepareAssistantScheduleProposal(
  value: unknown,
  from = new Date(),
): AssistantScheduleProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Scheduled task arguments must be an object.");
  }
  const record = value as Record<string, unknown>;
  const action = record.action;
  if (action !== "create") {
    throw new Error("Aiden can only prepare new scheduled tasks here.");
  }
  const unexpected = Object.keys(record).filter((key) => !ASSISTANT_CREATE_KEYS.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Aiden cannot set scheduled task field "${unexpected[0]}".`);
  }
  if (record.notify !== undefined && typeof record.notify !== "boolean") {
    throw new Error("notify must be true or false.");
  }
  if (
    record.permission !== undefined &&
    record.permission !== "read-only" &&
    record.permission !== "full"
  ) {
    throw new Error("permission must be read-only or full.");
  }
  const mcpServerIds = validateScheduledMcpServerIds(record.mcpServerIds) ?? [];
  const name = bounded(
    required(typeof record.name === "string" ? record.name : undefined, "name"),
    "name",
    ASSISTANT_AUTOMATION_NAME_LIMIT,
  );
  const prompt = bounded(
    required(typeof record.prompt === "string" ? record.prompt : undefined, "prompt"),
    "prompt",
    ASSISTANT_AUTOMATION_PROMPT_LIMIT,
  );
  const cron = bounded(
    required(typeof record.cron === "string" ? record.cron : undefined, "cron"),
    "cron",
    ASSISTANT_AUTOMATION_CRON_LIMIT,
  );
  const requestedTimezone = bounded(
    typeof record.timezone === "string" ? record.timezone.trim() : systemTimezone(),
    "timezone",
    ASSISTANT_AUTOMATION_TIMEZONE_LIMIT,
  );
  const timezone = validateTimezone(requestedTimezone);
  assertSafeDisplayText(name, "Task name");
  assertSafeDisplayText(prompt, "Task prompt", true);
  assertSafeDisplayText(cron, "Cron schedule");
  assertSafeDisplayText(timezone, "Timezone");
  assertSafeScheduledPrompt(prompt);
  const workspaceId =
    record.workspaceId === undefined
      ? undefined
      : bounded(
          required(
            typeof record.workspaceId === "string" ? record.workspaceId : undefined,
            "workspaceId",
          ),
          "workspaceId",
          ASSISTANT_AUTOMATION_WORKSPACE_ID_LIMIT,
        );
  if (workspaceId) assertSafeDisplayText(workspaceId, "Project ID");
  if (workspaceId && mcpServerIds.length > 0) {
    throw new Error(
      "Aiden automations must choose either one project or MCP servers, not both. Create separate automations for local project work and external-service access.",
    );
  }
  const permission =
    mcpServerIds.length > 0 ||
    record.permission === "full" ||
    (record.permission === undefined && recommendedScheduledPermission(prompt) === "full")
      ? "full"
      : "read-only";
  if (permission === "full" && !workspaceId && mcpServerIds.length === 0) {
    throw new Error(
      "Full access requires an exact project ID or approved MCP server from the listing tools.",
    );
  }
  const notify = record.notify !== false;
  const nextRunAt = nextScheduledRun(cron, timezone, from);
  return {
    input: {
      name,
      cron,
      timezone,
      mode: "llm",
      prompt,
      workspaceId,
      permission,
      mcpServerIds,
      executionProfile: ASSISTANT_SCHEDULE_EXECUTION_PROFILE,
      notify,
      enabled: true,
    },
    details: {
      kind: "assistant-automation",
      action: "create",
      name,
      prompt,
      cron,
      timezone,
      nextRunAt,
      notify,
      mode: "llm",
      permission,
      workspaceId: workspaceId ?? null,
      mcpServerIds,
    },
  };
}

/**
 * Pi calls this once before schema validation, approval, and execution. Filling
 * defaults here means the approval hook and the tool receive the same canonical
 * arguments even if device settings change while the user is deciding.
 */
export function canonicalizeAssistantScheduleToolArguments(
  value: unknown,
  from = new Date(),
): ScheduleToolParams {
  const proposal = prepareAssistantScheduleProposal(value, from);
  return {
    action: "create",
    name: proposal.input.name,
    cron: proposal.input.cron,
    timezone: proposal.input.timezone,
    prompt: proposal.input.prompt,
    workspaceId: proposal.input.workspaceId,
    permission: proposal.input.permission,
    mcpServerIds: proposal.input.mcpServerIds,
    notify: proposal.input.notify,
  };
}

/**
 * Corrects one provider-observed field-mapping mistake without widening
 * authority: an attended model may put an exact enabled MCP server ID into the
 * project-only workspaceId field. The repair is allowed only when no MCP scope
 * was otherwise requested, no project has that ID, and the ID exactly matches
 * an enabled configured server. The corrected Full scope is then used by both
 * the approval card and persistence.
 */
export async function repairAssistantScheduleMcpTarget(
  value: unknown,
  dependencies: Pick<
    ScheduleToolDependencies,
    "getWorkspace" | "listMcpServers"
  > = defaultDependencies,
  from = new Date(),
): Promise<AssistantScheduleProposal> {
  const proposal = prepareAssistantScheduleProposal(value, from);
  const workspaceId = proposal.input.workspaceId;
  if (!workspaceId || (proposal.input.mcpServerIds?.length ?? 0) > 0) return proposal;
  if (await dependencies.getWorkspace(workspaceId)) return proposal;
  const exactEnabledServer = (await dependencies.listMcpServers()).some(
    (server) => server.id === workspaceId && server.enabled,
  );
  if (!exactEnabledServer) return proposal;
  return prepareAssistantScheduleProposal(
    {
      action: "create",
      name: proposal.input.name,
      cron: proposal.input.cron,
      timezone: proposal.input.timezone,
      prompt: proposal.input.prompt,
      permission: "full",
      mcpServerIds: [workspaceId],
      notify: proposal.input.notify,
    },
    from,
  );
}

function sameStringList(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return (
    (left?.length ?? 0) === right.length && right.every((value, index) => left?.[index] === value)
  );
}

/**
 * Resolves a sparse edit against one exact Assistant-created task revision.
 * The merged proposal is what the user approves and what persistence later
 * revalidates, so omitted fields cannot reset the existing automation.
 */
export async function prepareAssistantEditAutomationProposal(
  value: unknown,
  dependencies: Pick<ScheduleToolDependencies, "get"> = defaultDependencies,
  from = new Date(),
): Promise<AssistantScheduleProposal> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Automation edit arguments must be an object.");
  }
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).filter((key) => !ASSISTANT_EDIT_KEYS.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Aiden cannot edit automation field "${unexpected[0]}".`);
  }

  const id = bounded(
    required(typeof record.id === "string" ? record.id : undefined, "id"),
    "id",
    ASSISTANT_AUTOMATION_TASK_ID_LIMIT,
  );
  assertSafeDisplayText(id, "Task ID");
  const expectedUpdatedAt =
    typeof record.expectedUpdatedAt === "number" &&
    Number.isFinite(record.expectedUpdatedAt) &&
    record.expectedUpdatedAt >= 0
      ? record.expectedUpdatedAt
      : undefined;
  if (expectedUpdatedAt === undefined) {
    throw new Error("expectedUpdatedAt is required and must come from list_scheduled_tasks.");
  }

  const patchKeys = [...ASSISTANT_EDIT_KEYS].filter(
    (key) => key !== "id" && key !== "expectedUpdatedAt" && record[key] !== undefined,
  );
  if (patchKeys.length === 0) {
    throw new Error("Include at least one automation field to change.");
  }
  if (record.clearWorkspace !== undefined && typeof record.clearWorkspace !== "boolean") {
    throw new Error("clearWorkspace must be true or false.");
  }
  if (record.workspaceId !== undefined && record.clearWorkspace === true) {
    throw new Error("Use either workspaceId or clearWorkspace, not both.");
  }
  if (record.notify !== undefined && typeof record.notify !== "boolean") {
    throw new Error("notify must be true or false.");
  }
  if (
    record.permission !== undefined &&
    record.permission !== "read-only" &&
    record.permission !== "full"
  ) {
    throw new Error("permission must be read-only or full.");
  }

  const existing = await dependencies.get(id);
  if (!existing) throw new Error(`Scheduled task ${id} was not found.`);
  if (existing.updatedAt !== expectedUpdatedAt) {
    throw new Error(
      "This automation changed since Aiden listed it. Call list_scheduled_tasks again before editing.",
    );
  }
  if (
    existing.mode !== "llm" ||
    existing.executionProfile !== ASSISTANT_SCHEDULE_EXECUTION_PROFILE
  ) {
    throw new Error("Aiden can edit only automations previously created with Aiden Assistant.");
  }

  const valueOrExisting = (key: "name" | "cron" | "timezone" | "prompt"): string => {
    const candidate = record[key];
    if (candidate === undefined) {
      const current = existing[key];
      if (typeof current !== "string") throw new Error(`Existing automation has no ${key}.`);
      return current;
    }
    return required(typeof candidate === "string" ? candidate : undefined, key);
  };
  const workspaceId =
    record.clearWorkspace === true
      ? undefined
      : record.workspaceId === undefined
        ? existing.workspaceId
        : required(
            typeof record.workspaceId === "string" ? record.workspaceId : undefined,
            "workspaceId",
          );
  const mcpServerIds =
    record.mcpServerIds === undefined
      ? (existing.mcpServerIds ?? [])
      : validateScheduledMcpServerIds(record.mcpServerIds);
  const merged = prepareAssistantScheduleProposal(
    {
      action: "create",
      name: valueOrExisting("name"),
      cron: valueOrExisting("cron"),
      timezone: valueOrExisting("timezone"),
      prompt: valueOrExisting("prompt"),
      workspaceId,
      permission: record.permission ?? existing.permission,
      mcpServerIds,
      notify: record.notify ?? existing.notify,
    },
    from,
  );
  const changed =
    merged.input.name !== existing.name ||
    merged.input.cron !== existing.cron ||
    merged.input.timezone !== existing.timezone ||
    merged.input.prompt !== existing.prompt ||
    merged.input.workspaceId !== existing.workspaceId ||
    merged.input.permission !== existing.permission ||
    !sameStringList(existing.mcpServerIds, merged.input.mcpServerIds ?? []) ||
    merged.input.notify !== existing.notify;
  if (!changed) throw new Error("The requested values already match this automation.");

  return {
    input: {
      ...merged.input,
      id: existing.id,
      enabled: existing.enabled,
      providerId: existing.providerId,
      model: existing.model,
    },
    expectedUpdatedAt,
    details: {
      ...merged.details,
      action: "edit",
      taskId: existing.id,
      enabled: existing.enabled,
    },
  };
}

export function summarizeEditAutomationToolCall(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "Edit an automation";
  }
  const id = (value as Partial<EditAutomationToolParams>).id?.trim();
  return `Edit scheduled task ${id || "?"}`;
}

function taskSummary(task: ScheduledTask) {
  return {
    id: task.id,
    name: task.name,
    enabled: task.enabled,
    mode: task.mode,
    cron: task.cron,
    timezone: task.timezone,
    workspaceId: task.workspaceId,
    permission: task.permission,
    mcpServerIds: task.mcpServerIds,
    notify: task.notify,
    nextRunAt: task.nextRunAt,
    lastRunAt: task.lastRunAt,
    lastResult: task.lastResult,
    updatedAt: task.updatedAt,
  };
}

function assistantTaskSummary(task: ScheduledTask) {
  return {
    id: task.id,
    name: task.name,
    enabled: task.enabled,
    mode: task.mode,
    cron: task.cron,
    timezone: task.timezone,
    workspaceId: task.workspaceId,
    permission: task.permission,
    mcpServerIds: task.mcpServerIds ?? [],
    notify: task.notify,
    updatedAt: task.updatedAt,
    editable: task.mode === "llm" && task.executionProfile === ASSISTANT_SCHEDULE_EXECUTION_PROFILE,
    nextRunAt: task.nextRunAt,
    lastRunAt: task.lastRunAt,
    lastResult: task.lastResult,
  };
}

async function workspaceFor(
  workspaceId: string | undefined,
  dependencies: ScheduleToolDependencies,
): Promise<Workspace | undefined> {
  if (!workspaceId) return undefined;
  const workspace = await dependencies.getWorkspace(workspaceId);
  if (!workspace) throw new Error(`Workspace ${workspaceId} was not found.`);
  if (workspace.permission === "none") {
    throw new Error(`Workspace ${workspaceId} has No Access.`);
  }
  return workspace;
}

export async function resolveAssistantScheduleProject(
  proposal: AssistantScheduleProposal,
  getWorkspace: ScheduleToolDependencies["getWorkspace"] = defaultDependencies.getWorkspace,
): Promise<Pick<AssistantAutomationApprovalDetails, "workspaceId" | "workspaceName">> {
  const workspaceId = proposal.input.workspaceId;
  if (!workspaceId) return { workspaceId: null, workspaceName: null };
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) {
    throw new Error(
      `Project id "${workspaceId}" was not returned by list_projects. workspaceId accepts project ids only; never put an MCP server id there. For an external service, use exact ids returned by list_mcp_servers in mcpServerIds. If list_mcp_servers returned no_enabled_servers, do not retry; tell the user to connect one.`,
    );
  }
  if (workspace.permission === "none") {
    throw new Error(`Project ${workspaceId} has No Access.`);
  }
  if (!workspace.folderPath) {
    throw new Error("The selected project does not have a folder for this automation.");
  }
  const workspaceName = bounded(
    required(workspace.name, "Project name"),
    "Project name",
    ASSISTANT_AUTOMATION_WORKSPACE_NAME_LIMIT,
  );
  assertSafeDisplayText(workspaceName, "Project name");
  return { workspaceId: workspace.id, workspaceName };
}

export async function resolveAssistantScheduleMcpServers(
  proposal: AssistantScheduleProposal,
  listMcpServers: ScheduleToolDependencies["listMcpServers"] = defaultDependencies.listMcpServers,
  expectedBindings?: readonly ScheduledMcpServerBinding[],
): Promise<
  Pick<AssistantAutomationApprovalDetails, "mcpServerIds" | "mcpServerNames"> & {
    mcpServerBindings: ScheduledMcpServerBinding[];
  }
> {
  const mcpServerIds = proposal.input.mcpServerIds ?? [];
  if (mcpServerIds.length === 0) {
    return { mcpServerIds: [], mcpServerNames: [], mcpServerBindings: [] };
  }
  const configured = await listMcpServers();
  const byId = new Map(configured.map((server) => [server.id, server]));
  const servers = mcpServerIds.map((id) => {
    const server = byId.get(id);
    if (!server) throw new Error(`MCP server ${id} was not found.`);
    if (!server.enabled) throw new Error(`MCP server "${server.name}" is disabled.`);
    const name = bounded(
      required(server.name, "MCP server name"),
      "MCP server name",
      ASSISTANT_AUTOMATION_MCP_SERVER_NAME_LIMIT,
    );
    assertSafeDisplayText(name, "MCP server name");
    return { server, name };
  });
  const mcpServerBindings = servers.map(({ server }) => scheduledMcpServerBinding(server));
  if (expectedBindings) {
    assertScheduledMcpServerBindings(
      servers.map(({ server }) => server),
      expectedBindings,
    );
  }
  return {
    mcpServerIds,
    mcpServerNames: servers.map(({ name }) => name),
    mcpServerBindings,
  };
}

interface PreparedStandardScheduleApproval {
  action: Exclude<ScheduleToolAction, "list">;
  input: ScheduledTaskInput;
  expectedUpdatedAt?: number;
  summary: string;
  details: ScheduledTaskApprovalDetails;
}

const PREPARED_STANDARD_SCHEDULE = Symbol("prepared-standard-schedule");

function sameIds(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return (left?.length ?? 0) === right.length && right.every((id, index) => left?.[index] === id);
}

function standardSelection(
  existing: ScheduledTask | undefined,
  selection: AssistantScheduleModelSelection | undefined,
): AssistantScheduleModelSelection {
  if (existing?.providerId && existing.model) {
    return {
      providerId: existing.providerId,
      providerName: existing.providerId,
      model: existing.model,
      modelName: existing.model,
      providerFingerprint:
        existing.providerFingerprint ?? selection?.providerFingerprint ?? "sha256:unbound",
    };
  }
  if (selection) return validateAssistantScheduleModelSelection(selection);
  return {
    providerId: "scheduler-default",
    providerName: "Scheduler default",
    model: "scheduler-default",
    modelName: "Scheduler default",
    providerFingerprint: "sha256:unbound",
  };
}

async function standardScope(
  input: ScheduledTaskInput,
  dependencies: ScheduleToolDependencies,
): Promise<{
  workspaceName: string | null;
  mcpServerNames: string[];
  mcpServerBindings: ScheduledMcpServerBinding[];
}> {
  const workspace = await workspaceFor(input.workspaceId, dependencies);
  const workspaceName = workspace
    ? bounded(required(workspace.name, "Project name"), "Project name", ASSISTANT_AUTOMATION_WORKSPACE_NAME_LIMIT)
    : null;
  if (workspaceName) assertSafeDisplayText(workspaceName, "Project name");
  const ids = input.mcpServerIds ?? [];
  if (input.workspaceId && ids.length > 0) {
    throw new Error("Scheduled tasks must choose either one project or MCP servers, not both.");
  }
  if (ids.length === 0) {
    return { workspaceName, mcpServerNames: [], mcpServerBindings: [] };
  }
  const configured = await dependencies.listMcpServers();
  const byId = new Map(configured.map((server) => [server.id, server]));
  const selected = ids.map((id) => {
    const server = byId.get(id);
    if (!server) throw new Error(`MCP server ${id} was not found.`);
    if (!server.enabled) throw new Error(`MCP server "${server.name}" is disabled.`);
    const name = bounded(
      required(server.name, "MCP server name"),
      "MCP server name",
      ASSISTANT_AUTOMATION_MCP_SERVER_NAME_LIMIT,
    );
    assertSafeDisplayText(name, "MCP server name");
    return { server, name };
  });
  return {
    workspaceName,
    mcpServerNames: selected.map(({ name }) => name),
    mcpServerBindings: selected.map(({ server }) => scheduledMcpServerBinding(server)),
  };
}

function standardApprovalSummary(details: ScheduledTaskApprovalDetails): string {
  const verb =
    details.action === "create"
      ? "Create"
      : details.action === "update"
        ? "Update"
        : details.action === "pause"
          ? "Pause"
          : details.action === "resume"
            ? "Resume"
            : details.action === "remove"
              ? "Delete"
              : "Run now";
  const cadence = approvalScheduleLabel(details.cron, details.timezone);
  const scope = details.workspaceName
    ? `project ${approvalDisplayValue(details.workspaceName, ASSISTANT_AUTOMATION_WORKSPACE_NAME_LIMIT, "unknown")} (${approvalDisplayValue(details.workspaceId, ASSISTANT_AUTOMATION_WORKSPACE_ID_LIMIT, "unknown")})`
    : details.mcpServerNames.length > 0
      ? `MCP ${details.mcpServerNames
          .map(
            (name, index) =>
              `${approvalDisplayValue(name, ASSISTANT_AUTOMATION_MCP_SERVER_NAME_LIMIT, "unknown")} (${approvalDisplayValue(details.mcpServerIds[index], ASSISTANT_AUTOMATION_MCP_SERVER_ID_LIMIT, "unknown")})`,
          )
          .join(", ")}`
      : details.permission === "full"
        ? "global host"
        : "no write or connector scope";
  const runtime =
    details.mode === "script"
      ? `script ${approvalDisplayValue(details.script, ASSISTANT_AUTOMATION_PROMPT_LIMIT, "unknown")}`
      : `${approvalDisplayValue(details.providerName, ASSISTANT_AUTOMATION_PROVIDER_NAME_LIMIT, "unknown")} / ${approvalDisplayValue(details.modelName, ASSISTANT_AUTOMATION_MODEL_NAME_LIMIT, "unknown")}`;
  const legacy = details.legacyGlobalMcp ? " · freezes legacy inherited MCP access" : "";
  return `${verb} scheduled task "${approvalDisplayValue(details.name, ASSISTANT_AUTOMATION_NAME_LIMIT, "Untitled")}" · ${cadence} · ${details.permission === "full" ? "Full" : "Read-only"} access · ${scope} · ${runtime}${legacy}`;
}

async function resolveStandardScheduleApproval(
  value: unknown,
  selection: AssistantScheduleModelSelection | undefined,
  dependencies: ScheduleToolDependencies,
  defaultWorkspaceId?: string,
  from = new Date(),
): Promise<PreparedStandardScheduleApproval> {
  const params = scheduleToolParams(value);
  if (!params.action || params.action === "list") {
    throw new Error("A mutating scheduled-task action is required.");
  }
  const action = params.action;
  let existing: ScheduledTask | undefined;
  let expectedUpdatedAt: number | undefined;
  let legacyGlobalMcp = false;
  if (action !== "create") {
    const id = required(params.id, "id");
    expectedUpdatedAt = requiredExpectedUpdatedAt(params.expectedUpdatedAt);
    existing = await dependencies.get(id);
    if (!existing) throw new Error(`Scheduled task ${id} was not found.`);
    verifyListedTaskIdentity(existing, params.taskName);
    if (existing.updatedAt !== expectedUpdatedAt) {
      throw new Error("This scheduled task changed. List tasks again before trying again.");
    }
    if (action === "update" && existing.executionProfile === ASSISTANT_SCHEDULE_EXECUTION_PROFILE) {
      throw new Error(
        "This automation is protected by Aiden Assistant. Edit it from the Aiden Assistant so its pinned execution profile can be re-approved.",
      );
    }
  }

  let input: ScheduledTaskInput;
  if (action === "create" || action === "update") {
    if (params.workspaceId?.trim() && params.clearWorkspace) {
      throw new Error("workspaceId and clearWorkspace cannot be used together.");
    }
    if (action === "update") {
      const changed = [
        params.name,
        params.cron,
        params.timezone,
        params.mode,
        params.prompt,
        params.script,
        params.workspaceId,
        params.clearWorkspace,
        params.permission,
        params.mcpServerIds,
        params.notify,
      ].some((entry) => entry !== undefined);
      if (!changed) throw new Error("Update requires at least one field to change.");
    }
    const mode = params.mode ?? existing?.mode ?? "llm";
    const workspaceId = params.clearWorkspace
      ? undefined
      : params.workspaceId?.trim() || existing?.workspaceId || (action === "create" ? defaultWorkspaceId : undefined);
    const workspace = await workspaceFor(workspaceId, dependencies);
    let prompt: string | undefined;
    let script: string | undefined;
    if (mode === "llm") {
      prompt = required(params.prompt ?? existing?.prompt, "prompt");
      bounded(prompt, "prompt", ASSISTANT_AUTOMATION_PROMPT_LIMIT);
      assertSafeDisplayText(prompt, "Task prompt", true);
      assertSafeScheduledPrompt(prompt);
    } else {
      if (params.permission === "read-only") throw new Error("Script tasks require Full permission.");
      script = required(params.script ?? existing?.script, "script");
      bounded(script, "script", ASSISTANT_AUTOMATION_PROMPT_LIMIT);
      assertSafeDisplayText(script, "Script name");
      await dependencies.validateScript({ script, workspaceRoot: workspace?.folderPath });
    }
    const requestedPermission = params.permission ?? existing?.permission ?? "read-only";
    let mcpServerIds: string[] = [];
    if (mode === "llm") {
      if (requestedPermission === "read-only" && (params.mcpServerIds?.length ?? 0) > 0) {
        throw new Error("MCP-enabled scheduled tasks require Full permission.");
      }
      const explicit =
        requestedPermission === "read-only"
          ? []
          : validateScheduledMcpServerIds(params.mcpServerIds ?? existing?.mcpServerIds);
      if (explicit !== undefined) {
        mcpServerIds = explicit;
      } else if (
        existing &&
        requestedPermission === "full" &&
        !workspaceId &&
        existing.mode === "llm" &&
        existing.permission === "full" &&
        !existing.workspaceId &&
        existing.mcpServerIds === undefined
      ) {
        legacyGlobalMcp = true;
        mcpServerIds = (await dependencies.listMcpServers())
          .filter((server) => server.enabled)
          .map((server) => server.id);
      }
    }
    if (workspaceId && mcpServerIds.length > 0) {
      throw new Error("Scheduled tasks must choose either one project or MCP servers, not both.");
    }
    const selected = standardSelection(existing, selection);
    input = {
      id: existing?.id,
      name: bounded(
        required(params.name ?? existing?.name, "name"),
        "name",
        ASSISTANT_AUTOMATION_NAME_LIMIT,
      ),
      enabled: existing?.enabled ?? true,
      mode,
      cron: bounded(
        required(params.cron ?? existing?.cron, "cron"),
        "cron",
        ASSISTANT_AUTOMATION_CRON_LIMIT,
      ),
      timezone: validateTimezone(params.timezone ?? existing?.timezone ?? systemTimezone()),
      workspaceId,
      providerId: existing?.providerId ?? (selection ? selected.providerId : undefined),
      model: existing?.model ?? (selection ? selected.model : undefined),
      providerFingerprint:
        existing?.providerFingerprint ?? (selection ? selected.providerFingerprint : undefined),
      prompt,
      script,
      permission: mode === "script" || mcpServerIds.length > 0 ? "full" : requestedPermission,
      mcpServerIds: mode === "llm" ? mcpServerIds : undefined,
      webSearchEnabled: existing?.webSearchEnabled,
      notify: params.notify ?? existing?.notify,
      executionProfile: existing?.executionProfile,
    };
    assertSafeDisplayText(input.name, "Task name");
    assertSafeDisplayText(input.cron, "Cron schedule");
  } else {
    input = { ...existing! };
    if (
      existing!.mode === "llm" &&
      existing!.permission === "full" &&
      !existing!.workspaceId &&
      existing!.mcpServerIds === undefined
    ) {
      legacyGlobalMcp = true;
      if (action === "run_now" || action === "resume") {
        throw new Error(
          "This legacy Full task still inherits every enabled MCP server. Update it first so Aiden can show and freeze the exact connector scope before it runs.",
        );
      }
      input.mcpServerIds = (await dependencies.listMcpServers())
        .filter((server) => server.enabled)
        .map((server) => server.id);
    }
  }

  const scope = await standardScope(input, dependencies);
  if (sameIds(existing?.mcpServerIds, input.mcpServerIds ?? [])) {
    input.mcpServerBindings = existing?.mcpServerBindings;
  } else if ((input.mcpServerIds?.length ?? 0) > 0) {
    input.mcpServerBindings = scope.mcpServerBindings;
  }
  const selected = standardSelection(existing, selection);
  const schedulerEnabled = await dependencies.isSchedulingEnabled();
  const cron = required(input.cron, "cron");
  const timezone = validateTimezone(input.timezone ?? systemTimezone());
  const details: ScheduledTaskApprovalDetails = {
    kind: "scheduled-task",
    action,
    taskId: existing?.id ?? null,
    expectedUpdatedAt: expectedUpdatedAt ?? null,
    enabled: input.enabled ?? true,
    name: required(input.name, "name"),
    prompt: input.mode === "llm" ? required(input.prompt, "prompt") : null,
    script: input.mode === "script" ? required(input.script, "script") : null,
    cron,
    timezone,
    nextRunAt: nextScheduledRun(cron, timezone, from),
    notify: input.notify !== false,
    mode: input.mode,
    permission: input.mode === "script" ? "full" : (input.permission ?? "read-only"),
    workspaceId: input.workspaceId ?? null,
    workspaceName: scope.workspaceName,
    mcpServerIds: [...(input.mcpServerIds ?? [])],
    mcpServerNames: scope.mcpServerNames,
    providerId: selected.providerId,
    providerName: selected.providerName,
    model: selected.model,
    modelName: selected.modelName,
    legacyGlobalMcp,
    schedulerEnabled,
  };
  const summary = standardApprovalSummary(details);
  if (summary.length > 1_900) {
    throw new Error(
      "The exact scheduled-task scope is too large to review safely. Use fewer or shorter MCP server identities, then try again.",
    );
  }
  return { action, input, expectedUpdatedAt, details, summary };
}

/** Resolves sparse standard-chat actions to the exact state shown for approval. */
export async function prepareStandardScheduleApproval(
  value: unknown,
  selection?: AssistantScheduleModelSelection,
  dependencies: ScheduleToolDependencies = defaultDependencies,
  defaultWorkspaceId?: string,
): Promise<Pick<PreparedStandardScheduleApproval, "summary" | "details">> {
  const prepared = await resolveStandardScheduleApproval(
    value,
    selection,
    dependencies,
    defaultWorkspaceId,
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Scheduled task arguments are invalid.");
  }
  Object.defineProperty(value, PREPARED_STANDARD_SCHEDULE, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: structuredClone(prepared),
  });
  return { summary: prepared.summary, details: prepared.details };
}

async function standardScheduleApprovalForExecution(
  value: unknown,
  selection: AssistantScheduleModelSelection | undefined,
  dependencies: ScheduleToolDependencies,
  defaultWorkspaceId?: string,
): Promise<PreparedStandardScheduleApproval> {
  const attached =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { [PREPARED_STANDARD_SCHEDULE]?: PreparedStandardScheduleApproval })[
          PREPARED_STANDARD_SCHEDULE
        ]
      : undefined;
  if (attached) return structuredClone(attached);
  return resolveStandardScheduleApproval(value, selection, dependencies, defaultWorkspaceId);
}

export function createAssistantScheduleListTool(
  dependencies: ScheduleToolDependencies = defaultDependencies,
): AgentTool {
  return declarePiRuntimeReplay(
    {
      name: LIST_SCHEDULED_TASKS_TOOL_NAME,
      label: "Scheduled Tasks",
      description:
        "List saved automations with redacted metadata, exact IDs, editability, and updatedAt revisions. Call with exactly {}. Use an editable task's exact id and updatedAt with edit_automation. This tool does not mutate tasks.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async (_toolCallId, rawParams): Promise<AgentToolResult<null>> => {
        if (
          !rawParams ||
          typeof rawParams !== "object" ||
          Array.isArray(rawParams) ||
          Object.keys(rawParams as Record<string, unknown>).length > 0
        ) {
          throw new Error("list_scheduled_tasks does not accept arguments.");
        }
        return result({
          tasks: (await dependencies.list()).map(assistantTaskSummary),
          schedulerEnabled: await dependencies.isSchedulingEnabled(),
        });
      },
    },
    "safe",
  );
}

export function createAssistantEditAutomationTool(
  modelSelection: AssistantScheduleModelSelection,
  dependencies: ScheduleToolDependencies = defaultDependencies,
): AgentTool {
  const approvedModel = validateAssistantScheduleModelSelection(modelSelection);
  return {
    name: EDIT_AUTOMATION_TOOL_NAME,
    label: "Edit Automation",
    description:
      "Edit one existing Aiden-created LLM automation. First call list_scheduled_tasks, then pass its exact id and updatedAt as expectedUpdatedAt. Include only fields that should change; omitted fields are preserved. Every edit pauses for explicit confirmation.",
    parameters: Type.Object(
      {
        id: Type.String({
          maxLength: ASSISTANT_AUTOMATION_TASK_ID_LIMIT,
          description: "Exact editable task ID from list_scheduled_tasks.",
        }),
        expectedUpdatedAt: Type.Number({
          description:
            "Exact updatedAt revision from the same list_scheduled_tasks result. Prevents stale overwrites.",
        }),
        name: Type.Optional(Type.String({ description: "Replacement task name." })),
        cron: Type.Optional(
          Type.String({
            description:
              'Replacement five- or six-part cron expression. For every day at 9 AM use "0 9 * * *".',
          }),
        ),
        timezone: Type.Optional(Type.String({ description: "Replacement IANA timezone." })),
        prompt: Type.Optional(Type.String({ description: "Replacement automation instruction." })),
        workspaceId: Type.Optional(
          Type.String({
            description:
              "Replacement exact project ID from list_projects. Omit to preserve the current project.",
          }),
        ),
        clearWorkspace: Type.Optional(
          Type.Boolean({
            description: "Set true to remove the current project. Do not combine with workspaceId.",
          }),
        ),
        permission: Type.Optional(
          Type.Union([Type.Literal("read-only"), Type.Literal("full")], {
            description: "Replacement access level. Omit to preserve current access.",
          }),
        ),
        mcpServerIds: Type.Optional(
          Type.Array(
            Type.String({
              maxLength: ASSISTANT_AUTOMATION_MCP_SERVER_ID_LIMIT,
              description: "Exact enabled MCP server ID from list_mcp_servers.",
            }),
            {
              maxItems: 16,
              description:
                "Replacement exact MCP scope. Pass [] to remove MCP access; omit to preserve it.",
            },
          ),
        ),
        notify: Type.Optional(
          Type.Boolean({
            description: "Replacement desktop notification preference.",
          }),
        ),
      },
      {
        additionalProperties: false,
        description:
          "Edit one exact automation revision. id and expectedUpdatedAt are required, plus at least one field to change.",
      },
    ),
    execute: async (_toolCallId, rawParams, signal): Promise<AgentToolResult<null>> => {
      const proposal = await prepareAssistantEditAutomationProposal(rawParams, {
        get: (id) => dependencies.get(id),
      });
      if (signal?.aborted) throw new Error("Automation edit was cancelled.");
      const mcpServerBindings = approvedMcpBindings(rawParams, proposal.input.mcpServerIds ?? []);
      await Promise.all([
        resolveAssistantScheduleProject(proposal, (id) => dependencies.getWorkspace(id)),
        resolveAssistantScheduleMcpServers(
          proposal,
          () => dependencies.listMcpServers(),
          mcpServerBindings,
        ),
      ]);
      if (signal?.aborted) throw new Error("Automation edit was cancelled.");
      const schedulerEnabled = await dependencies.isSchedulingEnabled();
      if (signal?.aborted) throw new Error("Automation edit was cancelled.");
      const task = await dependencies.save(
        {
          ...proposal.input,
          providerId: approvedModel.providerId,
          model: approvedModel.model,
          providerFingerprint: approvedModel.providerFingerprint,
          mcpServerBindings,
        },
        proposal.expectedUpdatedAt,
        signal,
      );
      return result({
        task: assistantTaskSummary(task),
        schedulerEnabled,
        status: !schedulerEnabled
          ? "updated_but_scheduling_off"
          : task.enabled
            ? "updated"
            : "updated_but_inactive",
      });
    },
  };
}

export function createScheduleTaskTool(
  access: ScheduleToolAccess = { kind: "standard" },
  dependencies: ScheduleToolDependencies = defaultDependencies,
): AgentTool {
  if (access.kind === "assistant-attended") {
    const approvedModel = validateAssistantScheduleModelSelection(access.modelSelection);
    return {
      name: SCHEDULE_TOOL_NAME,
      label: "Scheduled Tasks",
      description:
        "Propose one new LLM automation. action, name, cron, and prompt are required. Creation always pauses for explicit confirmation. Full access requires an exact project ID from list_projects or exact enabled server IDs from list_mcp_servers. MCP-enabled automations run with Full access. Listing, scripts, run-now, pause, resume, and delete are unavailable.",
      parameters: Type.Object(
        {
          action: Type.Literal("create"),
          name: Type.String({ description: "Required task name." }),
          cron: Type.String({
            description:
              'Required five- or six-part cron expression. For every day at 9 AM use "0 9 * * *". The field name is cron, not schedule.',
          }),
          prompt: Type.String({
            description: "Required automation instruction.",
          }),
          timezone: Type.Optional(
            Type.String({
              description: "IANA timezone. Defaults to the device timezone.",
            }),
          ),
          workspaceId: Type.Optional(
            Type.String({
              description:
                "Exact project ID from list_projects. Required for Full project access and optional for project-scoped read-only work.",
            }),
          ),
          permission: Type.Optional(
            Type.Union([Type.Literal("read-only"), Type.Literal("full")], {
              description:
                "Defaults to read-only. Use Full only when the task must edit files, run commands, or call MCP tools.",
            }),
          ),
          mcpServerIds: Type.Optional(
            Type.Array(
              Type.String({
                maxLength: ASSISTANT_AUTOMATION_MCP_SERVER_ID_LIMIT,
                description: "Exact enabled MCP server ID from list_mcp_servers.",
              }),
              {
                maxItems: 16,
                description:
                  "Exact MCP servers this automation may call unattended. Any non-empty list requires Full access.",
              },
            ),
          ),
          notify: Type.Optional(
            Type.Boolean({
              description: "Show a desktop notification after non-silent runs.",
            }),
          ),
        },
        {
          additionalProperties: false,
          description:
            "Propose one approval-gated automation. action, name, cron, and prompt are all required.",
        },
      ),
      prepareArguments: (rawParams) => canonicalizeAssistantScheduleToolArguments(rawParams),
      execute: async (_toolCallId, rawParams, signal): Promise<AgentToolResult<null>> => {
        const proposal = await repairAssistantScheduleMcpTarget(rawParams, dependencies);
        const mcpServerBindings = approvedMcpBindings(rawParams, proposal.input.mcpServerIds ?? []);
        if (signal?.aborted) throw new Error("Scheduled task creation was cancelled.");
        await Promise.all([
          resolveAssistantScheduleProject(proposal, (id) => dependencies.getWorkspace(id)),
          resolveAssistantScheduleMcpServers(
            proposal,
            () => dependencies.listMcpServers(),
            mcpServerBindings,
          ),
        ]);
        if (signal?.aborted) throw new Error("Scheduled task creation was cancelled.");
        const schedulerEnabled = await dependencies.isSchedulingEnabled();
        if (signal?.aborted) throw new Error("Scheduled task creation was cancelled.");
        const task = await dependencies.save(
          {
            ...proposal.input,
            providerId: approvedModel.providerId,
            model: approvedModel.model,
            providerFingerprint: approvedModel.providerFingerprint,
            mcpServerBindings,
          },
          undefined,
          signal,
        );
        return result({
          task: assistantTaskSummary(task),
          schedulerEnabled,
          status: !schedulerEnabled
            ? "saved_but_scheduling_off"
            : task.enabled
              ? "saved"
              : "saved_but_inactive",
        });
      },
    };
  }

  return {
    name: SCHEDULE_TOOL_NAME,
    label: "Scheduled Tasks",
    description:
      "Manage Aiden scheduled tasks. Actions: create, update, list, pause, resume, remove, run_now. List tasks immediately before any existing-task action, then pass its exact id, taskName, and updatedAt revision so stale changes and runs fail closed. Create requires name and cron plus prompt for llm mode or script for script mode. Tasks default to read-only; use full only when the task clearly needs unattended writes or commands. Scheduled runs cannot call this tool.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("create"),
        Type.Literal("update"),
        Type.Literal("list"),
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("remove"),
        Type.Literal("run_now"),
      ]),
      id: Type.Optional(
        Type.String({
          description: "Exact task ID for update, pause, resume, remove, or run_now.",
        }),
      ),
      taskName: Type.Optional(
        Type.String({
          maxLength: ASSISTANT_AUTOMATION_NAME_LIMIT,
          description:
            "Exact task name returned by list. Required for update, pause, resume, remove, or run_now so the confirmation is understandable.",
        }),
      ),
      expectedUpdatedAt: Type.Optional(
        Type.Number({
          description:
            "Exact updatedAt revision returned by list. Required for update, pause, resume, remove, and run_now so stale changes fail closed.",
        }),
      ),
      name: Type.Optional(Type.String({ description: "Task name. Required for create." })),
      cron: Type.Optional(
        Type.String({
          description: "Five- or six-part cron expression. Required for create.",
        }),
      ),
      timezone: Type.Optional(
        Type.String({
          description: "IANA timezone. Defaults to the device timezone.",
        }),
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("llm"), Type.Literal("script")], {
          description: "Execution mode. Defaults to llm.",
        }),
      ),
      prompt: Type.Optional(
        Type.String({ description: "LLM instruction. Required for llm mode." }),
      ),
      script: Type.Optional(
        Type.String({
          description: "File name from the workspace or global .aiden/scripts folder.",
        }),
      ),
      workspaceId: Type.Optional(
        Type.String({
          description:
            "Workspace ID. Defaults to the current chat workspace on create and preserves the current workspace on update.",
        }),
      ),
      clearWorkspace: Type.Optional(
        Type.Boolean({
          description:
            "Set true to use global scope instead of the current/default workspace. Do not combine with workspaceId.",
        }),
      ),
      permission: Type.Optional(
        Type.Union([Type.Literal("read-only"), Type.Literal("full")], {
          description: "LLM task permission. Defaults to read-only.",
        }),
      ),
      mcpServerIds: Type.Optional(
        Type.Array(Type.String(), {
          maxItems: 16,
          description: "Exact configured MCP server IDs approved for unattended use.",
        }),
      ),
      notify: Type.Optional(
        Type.Boolean({
          description: "Show a desktop notification after non-silent runs.",
        }),
      ),
    }),
    execute: async (_toolCallId, rawParams, signal): Promise<AgentToolResult<null>> => {
      const params = rawParams as ScheduleToolParams;
      throwIfScheduleToolAborted(signal);
      if (params.action === "list") {
        return result({ tasks: (await dependencies.list()).map(taskSummary) });
      }

      if (params.action === "create" || params.action === "update") {
        const prepared = await standardScheduleApprovalForExecution(
          rawParams,
          access.modelSelection,
          dependencies,
          access.defaultWorkspaceId,
        );
        throwIfScheduleToolAborted(signal);
        // Revalidate mutable inventories after approval. Persistence performs
        // the final revision compare-and-swap for updates.
        await standardScope(prepared.input, dependencies);
        if (prepared.input.mode === "script") {
          const workspace = await workspaceFor(prepared.input.workspaceId, dependencies);
          await dependencies.validateScript({
            script: required(prepared.input.script, "script"),
            workspaceRoot: workspace?.folderPath,
          });
        }
        throwIfScheduleToolAborted(signal);
        const task = await dependencies.save(
          prepared.input,
          prepared.expectedUpdatedAt,
          signal,
        );
        return result({
          task: taskSummary(task),
          permissionRecommendation:
            params.action === "create" &&
            prepared.input.mode === "llm" &&
            (prepared.input.mcpServerIds?.length ?? 0) === 0 &&
            !params.permission &&
            recommendedScheduledPermission(required(prepared.input.prompt, "prompt")) === "full"
              ? "This prompt appears to need writes or commands. The task remains read-only; ask the user before changing it to full."
              : undefined,
        });
      }

      const id = required(params.id, "id");
      const existing = await dependencies.get(id);
      if (!existing) throw new Error(`Scheduled task ${id} was not found.`);
      verifyListedTaskIdentity(existing, params.taskName);
      const expectedUpdatedAt = requiredExpectedUpdatedAt(params.expectedUpdatedAt);
      if (existing.updatedAt !== expectedUpdatedAt) {
        throw new Error("This scheduled task changed. List tasks again before trying again.");
      }
      if (params.action === "pause")
        return result({
          task: taskSummary(await dependencies.pause(id, expectedUpdatedAt, signal)),
        });
      if (params.action === "resume")
        return result({
          task: taskSummary(await dependencies.resume(id, expectedUpdatedAt, signal)),
        });
      if (params.action === "remove") {
        await dependencies.remove(id, expectedUpdatedAt, signal);
        return result({ removed: id });
      }
      if (params.action === "run_now") {
        return result({ run: await dependencies.runNow(id, expectedUpdatedAt, signal) });
      }
      throw new Error(`Unsupported schedule action: ${String(params.action)}.`);
    },
  };
}

export function scheduleTaskToolsForContext(context: {
  workspaceId?: string;
  allowScheduling?: boolean;
  mode?: "standard" | "assistant-attended";
  assistantModelSelection?: AssistantScheduleModelSelection;
}): AgentTool[] {
  if (context.allowScheduling === false) return [];
  if (context.mode === "assistant-attended") {
    if (!context.assistantModelSelection) {
      throw new Error("Assistant scheduling requires an exact provider and model selection.");
    }
    return [
      createAssistantScheduleListTool(),
      createScheduleTaskTool({
        kind: "assistant-attended",
        modelSelection: context.assistantModelSelection,
      }),
      createAssistantEditAutomationTool(context.assistantModelSelection),
    ];
  }
  return [
    createScheduleTaskTool({
      kind: "standard",
      defaultWorkspaceId: context.workspaceId,
      modelSelection: context.assistantModelSelection,
    }),
  ];
}
