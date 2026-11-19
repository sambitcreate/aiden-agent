// Pure parsing for Aiden's nested settings block. Reads are deliberately
// tolerant because settings.json is user-editable.

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
