import type { AppSettings } from "./types.js";

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected a non-empty string for "${name}".`);
  }
  return value;
}

export function scheduledSettingsPatch(
  input: Record<string, unknown>,
  validateTimezone: (value: string) => string,
): Partial<AppSettings> {
  const patch: Partial<AppSettings> = {};
  if (typeof input.enabled === "boolean") patch.scheduledTasksEnabled = input.enabled;
  if (input.defaultMode === "llm" || input.defaultMode === "script") {
    patch.scheduledDefaultMode = input.defaultMode;
  }
  if (input.defaultPermission === "read-only" || input.defaultPermission === "full") {
    patch.scheduledDefaultPermission = input.defaultPermission;
  }
  if (typeof input.defaultMcpEnabled === "boolean") {
    patch.scheduledDefaultMcpEnabled = input.defaultMcpEnabled;
  }
  if (typeof input.defaultNotify === "boolean") patch.scheduledDefaultNotify = input.defaultNotify;
  if (input.defaultTimezone !== undefined) {
    patch.scheduledDefaultTimezone = validateTimezone(
      requiredString(input.defaultTimezone, "defaultTimezone"),
    );
  }
  return patch;
}
