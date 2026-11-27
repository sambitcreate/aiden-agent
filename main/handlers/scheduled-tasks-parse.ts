import type {
  ScheduledTaskInput,
  ScheduledTaskMode,
  ScheduledTaskPermission,
} from "../services/types.js";
import { validateScheduledMcpServerIds } from "../services/schedule-guard.js";
import { parseScheduledTaskTrigger, type ScheduledTaskTrigger } from "../../renderer/shared/scheduled-task-trigger.js";

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected a non-empty string for "${name}".`);
  }
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function parseScheduledTaskInput(value: unknown): ScheduledTaskInput {
  const input = (
    value && typeof value === "object" && !Array.isArray(value) ? value : {}
  ) as Record<string, unknown>;
  const mode: ScheduledTaskMode =
    input.mode === "script"
      ? "script"
      : input.mode === "llm"
        ? "llm"
        : (() => {
            throw new Error("Invalid scheduled task mode.");
          })();
  // The chat a task posts into is set by Aiden when a chat makes the task;
  // a save can only keep it (main preserves it) or drop it with "Use its own chat".
  if (Object.prototype.hasOwnProperty.call(input, "originChatId")) {
    throw new Error("The chat a scheduled task posts into can't be set here.");
  }
  let permission: ScheduledTaskPermission | undefined;
  if ("permission" in input) {
    if (input.permission !== "full" && input.permission !== "read-only") {
      throw new Error("Invalid scheduled task permission.");
    }
    permission = input.permission;
  }
  // A trigger replaces the cron: a watch runs the task when something changes.
  // `null` turns a trigger task back into a scheduled one; omitted keeps it.
  let trigger: ScheduledTaskTrigger | null | undefined;
  if ("trigger" in input && input.trigger !== undefined) {
    trigger = input.trigger === null ? null : parseScheduledTaskTrigger(input.trigger);
  }
  return {
    id: optionalString(input.id),
    name: requiredString(input.name, "name"),
    enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
    mode,
    cron: trigger ? (typeof input.cron === "string" ? input.cron : "") : requiredString(input.cron, "cron"),
    ...(trigger !== undefined ? { trigger } : {}),
    timezone: optionalString(input.timezone),
    workspaceId: optionalString(input.workspaceId),
    providerId: optionalString(input.providerId),
    model: optionalString(input.model),
    prompt: optionalString(input.prompt),
    script: optionalString(input.script),
    permission,
    mcpServerIds: validateScheduledMcpServerIds(input.mcpServerIds),
    webSearchEnabled:
      typeof input.webSearchEnabled === "boolean" ? input.webSearchEnabled : undefined,
    notify: typeof input.notify === "boolean" ? input.notify : undefined,
  };
}
