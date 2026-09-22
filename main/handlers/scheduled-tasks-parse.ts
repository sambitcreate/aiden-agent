import type {
  ScheduledTaskInput,
  ScheduledTaskMode,
  ScheduledTaskPermission,
} from "../services/types.js";
import { validateScheduledMcpServerIds } from "../services/schedule-guard.js";

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected a non-empty string for "${name}".`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
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
  let permission: ScheduledTaskPermission | undefined;
  if ("permission" in input) {
    if (input.permission !== "full" && input.permission !== "read-only") {
      throw new Error("Invalid scheduled task permission.");
    }
    permission = input.permission;
  }
  return {
    id: optionalString(input.id),
    name: requiredString(input.name, "name"),
    enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
    mode,
    cron: requiredString(input.cron, "cron"),
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
