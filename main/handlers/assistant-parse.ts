// Pure parsing for Aiden's nested settings block. Reads are deliberately
// tolerant because settings.json is user-editable; writes are strict so an
// invalid renderer patch never becomes persisted state.

import type { AppSettings, AssistantConfig, AssistantSettingsPermission } from "../services/types.js";

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/u;
const PERMISSIONS: ReadonlySet<AssistantSettingsPermission> = new Set(["full", "ask", "none"]);

export const DEFAULT_ASSISTANT_CONFIG: AssistantConfig = {
  enabled: false,
  hotkeyEnabled: true,
  hotkeyAccelerator: "Command+Alt+A",
  providerId: undefined,
  model: undefined,
  watchUncommitted: true,
  watchUntouchedProjects: true,
  watchConfigChanges: true,
  pollIntervalMinutes: 30,
  untouchedThresholdDays: 14,
  quietHoursEnabled: false,
  quietHoursStart: "22:00",
  quietHoursEnd: "08:00",
  maxNudgesPerDay: 5,
  urgencyThreshold: 7,
  settingsPermission: "ask",
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function storedBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function storedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function storedTime(value: unknown, fallback: string): string {
  return typeof value === "string" && TIME.test(value) ? value : fallback;
}

function storedPin(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function storedPermission(value: unknown): AssistantSettingsPermission {
  return PERMISSIONS.has(value as AssistantSettingsPermission)
    ? (value as AssistantSettingsPermission)
    : DEFAULT_ASSISTANT_CONFIG.settingsPermission;
}

function storedAccelerator(value: unknown): string {
  return typeof value === "string" && value.trim() && value.length <= 128
    ? value.trim()
    : DEFAULT_ASSISTANT_CONFIG.hotkeyAccelerator;
}

/** Fill defaults and fail closed around malformed device-local persisted data. */
export function assistantConfigFrom(settings: AppSettings): AssistantConfig {
  const input = record(settings.assistant);
  return {
    enabled: storedBoolean(input.enabled, DEFAULT_ASSISTANT_CONFIG.enabled),
    hotkeyEnabled: storedBoolean(input.hotkeyEnabled, DEFAULT_ASSISTANT_CONFIG.hotkeyEnabled),
    hotkeyAccelerator: storedAccelerator(input.hotkeyAccelerator),
    providerId: storedPin(input.providerId),
    model: storedPin(input.model),
    watchUncommitted: storedBoolean(
      input.watchUncommitted,
      DEFAULT_ASSISTANT_CONFIG.watchUncommitted,
    ),
    watchUntouchedProjects: storedBoolean(
      input.watchUntouchedProjects,
      DEFAULT_ASSISTANT_CONFIG.watchUntouchedProjects,
    ),
    watchConfigChanges: storedBoolean(
      input.watchConfigChanges,
      DEFAULT_ASSISTANT_CONFIG.watchConfigChanges,
    ),
    pollIntervalMinutes: storedInteger(
      input.pollIntervalMinutes,
      DEFAULT_ASSISTANT_CONFIG.pollIntervalMinutes,
      5,
      1440,
    ),
    untouchedThresholdDays: storedInteger(
      input.untouchedThresholdDays,
      DEFAULT_ASSISTANT_CONFIG.untouchedThresholdDays,
      1,
      365,
    ),
    quietHoursEnabled: storedBoolean(
      input.quietHoursEnabled,
      DEFAULT_ASSISTANT_CONFIG.quietHoursEnabled,
    ),
    quietHoursStart: storedTime(
      input.quietHoursStart,
      DEFAULT_ASSISTANT_CONFIG.quietHoursStart,
    ),
    quietHoursEnd: storedTime(input.quietHoursEnd, DEFAULT_ASSISTANT_CONFIG.quietHoursEnd),
    maxNudgesPerDay: storedInteger(
      input.maxNudgesPerDay,
      DEFAULT_ASSISTANT_CONFIG.maxNudgesPerDay,
      1,
      50,
    ),
    urgencyThreshold: storedInteger(
      input.urgencyThreshold,
      DEFAULT_ASSISTANT_CONFIG.urgencyThreshold,
      0,
      10,
    ),
    settingsPermission: storedPermission(input.settingsPermission),
  };
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid Aiden ${field}; use true or false.`);
  return value;
}

function requireInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid Aiden ${field}; use a number.`);
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function requireTime(value: unknown, field: string): string {
  if (typeof value !== "string" || !TIME.test(value)) {
    throw new Error(`Invalid Aiden quiet-hours ${field}; use HH:MM.`);
  }
  return value;
}

function requirePin(value: unknown): string | undefined {
  if (typeof value !== "string") throw new Error("Invalid Aiden model selection.");
  return value.trim() || undefined;
}

/**
 * Apply a renderer patch to the authoritative config. Unknown keys are ignored;
 * known keys reject invalid types instead of silently accepting a partial write.
 */
export function parseAssistantConfigPatch(
  current: AssistantConfig,
  patch: unknown,
): AssistantConfig {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Invalid Aiden settings patch.");
  }
  const input = patch as Record<string, unknown>;
  const next = { ...current };

  if ("enabled" in input) next.enabled = requireBoolean(input.enabled, "background activity");
  if ("hotkeyEnabled" in input) {
    next.hotkeyEnabled = requireBoolean(input.hotkeyEnabled, "shortcut setting");
  }
  if ("hotkeyAccelerator" in input) {
    if (
      typeof input.hotkeyAccelerator !== "string" ||
      !input.hotkeyAccelerator.trim() ||
      input.hotkeyAccelerator.length > 128
    ) {
      throw new Error("Invalid Aiden shortcut.");
    }
    next.hotkeyAccelerator = input.hotkeyAccelerator.trim();
  }
  if ("providerId" in input) next.providerId = requirePin(input.providerId);
  if ("model" in input) next.model = requirePin(input.model);
  if ("watchUncommitted" in input) {
    next.watchUncommitted = requireBoolean(input.watchUncommitted, "uncommitted-work setting");
  }
  if ("watchUntouchedProjects" in input) {
    next.watchUntouchedProjects = requireBoolean(
      input.watchUntouchedProjects,
      "untouched-project setting",
    );
  }
  if ("watchConfigChanges" in input) {
    next.watchConfigChanges = requireBoolean(
      input.watchConfigChanges,
      "configuration-change setting",
    );
  }
  if ("pollIntervalMinutes" in input) {
    next.pollIntervalMinutes = requireInteger(
      input.pollIntervalMinutes,
      "poll interval",
      5,
      1440,
    );
  }
  if ("untouchedThresholdDays" in input) {
    next.untouchedThresholdDays = requireInteger(
      input.untouchedThresholdDays,
      "untouched-project threshold",
      1,
      365,
    );
  }
  if ("quietHoursEnabled" in input) {
    next.quietHoursEnabled = requireBoolean(input.quietHoursEnabled, "quiet-hours setting");
  }
  if ("quietHoursStart" in input) {
    next.quietHoursStart = requireTime(input.quietHoursStart, "start");
  }
  if ("quietHoursEnd" in input) next.quietHoursEnd = requireTime(input.quietHoursEnd, "end");
  if ("maxNudgesPerDay" in input) {
    next.maxNudgesPerDay = requireInteger(input.maxNudgesPerDay, "daily limit", 1, 50);
  }
  if ("urgencyThreshold" in input) {
    next.urgencyThreshold = requireInteger(input.urgencyThreshold, "urgency threshold", 0, 10);
  }
  if ("settingsPermission" in input) {
    if (!PERMISSIONS.has(input.settingsPermission as AssistantSettingsPermission)) {
      throw new Error("Invalid Aiden settings permission.");
    }
    next.settingsPermission = input.settingsPermission as AssistantSettingsPermission;
  }

  return next;
}
