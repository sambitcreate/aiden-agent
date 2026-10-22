import {
  ASSISTANT_AUTOMATION_MCP_SERVER_LIMIT,
  ASSISTANT_AUTOMATION_MCP_SERVER_NAME_LIMIT,
  ASSISTANT_AUTOMATION_MODEL_NAME_LIMIT,
  ASSISTANT_AUTOMATION_NAME_LIMIT,
  ASSISTANT_AUTOMATION_PROVIDER_NAME_LIMIT,
  ASSISTANT_AUTOMATION_TIMEZONE_LIMIT,
  ASSISTANT_AUTOMATION_WORKSPACE_NAME_LIMIT,
  isAssistantAutomationApprovalDetails,
  isScheduledTaskApprovalDetails,
  safeApprovalText,
  type ScheduledTaskApprovalDetails,
} from "../../renderer/shared/assistant.js";
import { formatScheduledTaskCadence } from "../../renderer/shared/scheduled-task-presentation.js";
import { boundedText } from "./run-event-projection.js";

/** The longest instructions or script a phone card shows; the summary bound. */
export const AIDEN_REMOTE_APPROVAL_SCHEDULE_TEXT_LIMIT = 2_000;
export const AIDEN_REMOTE_APPROVAL_SCHEDULE_CADENCE_LIMIT = 200;

/**
 * Display-only facts for a scheduled-task approval card on a phone (contract
 * revision 39, `schedule:cards`). Built on the host from validated details;
 * it never changes whether the phone may allow, and it carries no ids.
 */
export interface AidenRemoteApprovalSchedule {
  action: ScheduledTaskApprovalDetails["action"];
  name: string;
  /** Human cadence such as "Every day at 9:00 AM"; never cron syntax. */
  cadence: string;
  timezone: string;
  /** Present only while the task will run on its own. */
  nextRunAt?: string;
  mode: "llm" | "script";
  permission: "read-only" | "full";
  workspaceName?: string;
  /** Connector (MCP server) display names, at most 16. */
  connectors: string[];
  providerName?: string;
  modelName?: string;
  notify: boolean;
  enabled: boolean;
  schedulerEnabled: boolean;
  prompt?: string;
  script?: string;
  /** The instructions or script were shortened to fit. */
  truncated?: true;
}

const ACTIONS = ["create", "update", "pause", "resume", "remove", "run_now"] as const;

/** Cut to the wire bound, dropping a character the bound would split in half. */
function shortened(value: string): { text: string; truncated: boolean } {
  if (value.length <= AIDEN_REMOTE_APPROVAL_SCHEDULE_TEXT_LIMIT) return { text: value, truncated: false };
  let end = AIDEN_REMOTE_APPROVAL_SCHEDULE_TEXT_LIMIT;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: value.slice(0, end).trimEnd(), truncated: true };
}

type ScheduleCardSource = Pick<
  ScheduledTaskApprovalDetails,
  | "action" | "name" | "cron" | "timezone" | "nextRunAt" | "notify" | "mode" | "permission" | "workspaceName"
  | "mcpServerNames" | "providerName" | "modelName" | "enabled" | "schedulerEnabled" | "prompt" | "script"
>;

/**
 * Both kinds of `schedule_task` proposal: an ordinary chat's, and the
 * Assistant's own (a new task that starts enabled). The Assistant's edits
 * arrive as `edit_automation`, which phones keep as a summary card.
 */
function scheduleCardSource(details: unknown): ScheduleCardSource | undefined {
  if (isScheduledTaskApprovalDetails(details)) return details;
  if (isAssistantAutomationApprovalDetails(details) && details.action === "create") {
    return { ...details, action: "create", enabled: true, script: null };
  }
  return undefined;
}

/**
 * The phone card for a scheduled-task approval, or undefined for any other
 * approval. Fails closed: details that do not pass the renderer guard, or
 * text that would not survive the wire validator, yield no card.
 */
export function approvalScheduleCard(
  value: unknown,
  now = new Date(),
): AidenRemoteApprovalSchedule | undefined {
  const details = scheduleCardSource(value);
  if (!details) return undefined;
  const cadence = boundedText(
    formatScheduledTaskCadence(details.cron, details.timezone, now),
    AIDEN_REMOTE_APPROVAL_SCHEDULE_CADENCE_LIMIT,
  ).trim();
  const body = details.mode === "script" ? details.script : details.prompt;
  const content = body ? shortened(body) : undefined;
  const runsOnItsOwn =
    details.enabled && details.schedulerEnabled && details.action !== "remove" && details.nextRunAt > 0;
  const nextRun = runsOnItsOwn ? new Date(details.nextRunAt) : undefined;
  const card: AidenRemoteApprovalSchedule = {
    action: details.action,
    name: details.name,
    cadence: cadence || "Custom schedule",
    timezone: details.timezone,
    ...(nextRun && Number.isFinite(nextRun.getTime()) ? { nextRunAt: nextRun.toISOString() } : {}),
    mode: details.mode,
    permission: details.permission,
    ...(details.workspaceName ? { workspaceName: details.workspaceName } : {}),
    connectors: [...details.mcpServerNames],
    ...(details.mode === "llm" ? { providerName: details.providerName, modelName: details.modelName } : {}),
    notify: details.notify,
    enabled: details.enabled,
    schedulerEnabled: details.schedulerEnabled,
    ...(content?.text ? { [details.mode === "script" ? "script" : "prompt"]: content.text } : {}),
    ...(content?.truncated ? { truncated: true as const } : {}),
  };
  try {
    return parseAidenRemoteApprovalSchedule(card);
  } catch {
    return undefined;
  }
}

const SCHEDULE_KEYS = new Set([
  "action", "name", "cadence", "timezone", "nextRunAt", "mode", "permission", "workspaceName",
  "connectors", "providerName", "modelName", "notify", "enabled", "schedulerEnabled", "prompt",
  "script", "truncated",
]);

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

function text(record: Record<string, unknown>, key: string, limit: number, multiline = false): string {
  const value = record[key];
  if (!safeApprovalText(value, limit, multiline)) throw new Error(`Approval schedule ${key} is invalid.`);
  return value;
}

function optionalText(record: Record<string, unknown>, key: string, limit: number, multiline = false): string | undefined {
  return record[key] === undefined ? undefined : text(record, key, limit, multiline);
}

function flag(record: Record<string, unknown>, key: string): boolean {
  if (typeof record[key] !== "boolean") throw new Error(`Approval schedule ${key} must be boolean.`);
  return record[key] as boolean;
}

/** The wire validator every reader of `schedule` mirrors: exact keys, bounded safe text. */
export function parseAidenRemoteApprovalSchedule(value: unknown): AidenRemoteApprovalSchedule {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Approval schedule must be an object.");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!SCHEDULE_KEYS.has(key)) throw new Error(`Approval schedule has unknown key ${key}.`);
  }
  if (!(ACTIONS as readonly unknown[]).includes(record.action)) throw new Error("Approval schedule action is invalid.");
  if (record.mode !== "llm" && record.mode !== "script") throw new Error("Approval schedule mode is invalid.");
  if (record.permission !== "read-only" && record.permission !== "full") {
    throw new Error("Approval schedule permission is invalid.");
  }
  const connectors = record.connectors;
  if (
    !Array.isArray(connectors) ||
    connectors.length > ASSISTANT_AUTOMATION_MCP_SERVER_LIMIT ||
    !connectors.every((name) => safeApprovalText(name, ASSISTANT_AUTOMATION_MCP_SERVER_NAME_LIMIT))
  ) {
    throw new Error("Approval schedule connectors are invalid.");
  }
  const nextRunAt = optionalText(record, "nextRunAt", 40);
  if (nextRunAt !== undefined && (!RFC3339_UTC.test(nextRunAt) || !Number.isFinite(Date.parse(nextRunAt)))) {
    throw new Error("Approval schedule nextRunAt must be an RFC 3339 UTC date-time.");
  }
  const llm = record.mode === "llm";
  const providerName = optionalText(record, "providerName", ASSISTANT_AUTOMATION_PROVIDER_NAME_LIMIT);
  const modelName = optionalText(record, "modelName", ASSISTANT_AUTOMATION_MODEL_NAME_LIMIT);
  const prompt = optionalText(record, "prompt", AIDEN_REMOTE_APPROVAL_SCHEDULE_TEXT_LIMIT, true);
  const script = optionalText(record, "script", AIDEN_REMOTE_APPROVAL_SCHEDULE_TEXT_LIMIT, true);
  if (llm ? script !== undefined : prompt !== undefined || providerName !== undefined || modelName !== undefined) {
    throw new Error("Approval schedule content does not match its mode.");
  }
  if (record.truncated !== undefined && (record.truncated !== true || (prompt ?? script) === undefined)) {
    throw new Error("Approval schedule truncated must be true and mark shortened content.");
  }
  const workspaceName = optionalText(record, "workspaceName", ASSISTANT_AUTOMATION_WORKSPACE_NAME_LIMIT);
  return {
    action: record.action as AidenRemoteApprovalSchedule["action"],
    name: text(record, "name", ASSISTANT_AUTOMATION_NAME_LIMIT),
    cadence: text(record, "cadence", AIDEN_REMOTE_APPROVAL_SCHEDULE_CADENCE_LIMIT),
    timezone: text(record, "timezone", ASSISTANT_AUTOMATION_TIMEZONE_LIMIT),
    ...(nextRunAt !== undefined ? { nextRunAt } : {}),
    mode: record.mode,
    permission: record.permission,
    ...(workspaceName !== undefined ? { workspaceName } : {}),
    connectors: [...connectors] as string[],
    ...(providerName !== undefined ? { providerName } : {}),
    ...(modelName !== undefined ? { modelName } : {}),
    notify: flag(record, "notify"),
    enabled: flag(record, "enabled"),
    schedulerEnabled: flag(record, "schedulerEnabled"),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(script !== undefined ? { script } : {}),
    ...(record.truncated === true ? { truncated: true as const } : {}),
  };
}
