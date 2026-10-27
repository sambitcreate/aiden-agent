import { THEME_PRESETS } from "./appearance.js";

/** Portable, inert conversation descriptors. Values and authority are always read from the host. */
export const APP_CONTROL_IDS = [
  "appearance.mode",
  "appearance.chatWidth",
  "appearance.reduceMotion",
  "appearance.terminalTheme",
  "memory.enabled",
  "memory.workspace",
  "webSearch.enabled",
  "skills.enabled",
  "appearance.theme",
  "models.newChat",
] as const;
export type AppControlId = (typeof APP_CONTROL_IDS)[number];
export const APP_CONTROL_TOPICS = ["appearance", "memory", "web-search", "skills", "models"] as const;
export type AppControlTopic = (typeof APP_CONTROL_TOPICS)[number];
/**
 * The vocabulary paired phones understand (Remote `chat-ui-panels-v1`). They
 * reject a whole card that carries an unknown row or topic, so newer desktop
 * controls stay off the Remote surface until a protocol revision adds them.
 */
export const REMOTE_APP_CONTROL_IDS: ReadonlySet<AppControlId> = new Set(APP_CONTROL_IDS.slice(0, 8));
export const REMOTE_APP_CONTROL_TOPICS: ReadonlySet<AppControlTopic> = new Set(["appearance", "memory", "web-search", "skills"]);
/** A new-chat model value: `provider::model`. */
export function newChatModelValue(providerId: string, model: string): string {
  return `${providerId}::${model}`;
}
export function parseNewChatModelValue(value: string): { providerId: string; model: string } | undefined {
  const split = value.indexOf("::");
  if (split <= 0 || split + 2 >= value.length) return undefined;
  return { providerId: value.slice(0, split), model: value.slice(split + 2) };
}
export type AppControlValue = boolean | string;
export type AppControlPolicy = "disabled" | "ask" | "safe";
/** Preserve explicit legacy denial and fail closed for unsupported policy values. */
export function resolveAppControlPolicy(settings: {
  appControlPolicy?: unknown;
  assistant?: { settingsPermission?: unknown };
}): AppControlPolicy {
  if (settings.appControlPolicy === undefined && settings.assistant?.settingsPermission === "none")
    return "disabled";
  return settings.appControlPolicy === undefined || settings.appControlPolicy === "safe"
    ? "safe" : settings.appControlPolicy === "ask" ? "ask" : "disabled";
}
export interface AppControlPanel {
  version: 1;
  id: string;
  topic: AppControlTopic;
  fallback: string;
  workspaceId?: string;
}
export interface AppControlRow {
  id: AppControlId;
  label: string;
  description: string;
  scope: string;
  value: AppControlValue;
  revision: string;
  options?: { value: string; label: string }[];
  disabledReason?: string;
}
export interface AppControlSnapshot {
  version: 1;
  title: string;
  target: string;
  policy: AppControlPolicy;
  rows: AppControlRow[];
}
export interface AppControlOperation {
  control: AppControlId;
  value: AppControlValue;
  expectedRevision: string;
  operationId: string;
}
export interface AppControlReceipt {
  status: "applied" | "already_set" | "outcome_unknown";
  operationId: string;
  control: AppControlId;
  value: AppControlValue;
  scope: string;
  effective: "now" | "next_turn" | "next_session" | "after_preview";
  warning?: string;
}
export function isAppControlId(value: unknown): value is AppControlId {
  return APP_CONTROL_IDS.includes(value as AppControlId);
}
export function isAppControlTopic(value: unknown): value is AppControlTopic {
  return APP_CONTROL_TOPICS.includes(value as AppControlTopic);
}
export function parseAppControlOperation(value: unknown): AppControlOperation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid control operation.");
  const p = value as Record<string, unknown>;
  if (
    Object.keys(p).length !== 4 ||
    !isAppControlId(p.control) ||
    (typeof p.value !== "boolean" && typeof p.value !== "string") ||
    typeof p.expectedRevision !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/u.test(p.expectedRevision) ||
    typeof p.operationId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/u.test(p.operationId)
  ) {
    throw new Error("Invalid control operation.");
  }
  if (p.control === "models.newChat") {
    if (typeof p.value !== "string" || p.value.length > 300 || [...p.value].some((c) => c.charCodeAt(0) < 0x20) || !parseNewChatModelValue(p.value))
      throw new Error("Unsupported model.");
  } else if (p.control === "appearance.theme") {
    if (typeof p.value !== "string" || !THEME_PRESETS.some((preset) => preset.id === p.value))
      throw new Error("Unsupported color theme.");
  } else if (p.control.startsWith("appearance.")) {
    if (p.control === "appearance.terminalTheme") {
      if (typeof p.value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/u.test(p.value))
        throw new Error("Unsupported terminal theme.");
      return {
        control: p.control,
        value: p.value,
        expectedRevision: p.expectedRevision,
        operationId: p.operationId,
      };
    }
    const options =
      p.control === "appearance.mode"
        ? ["light", "dark", "system"]
        : p.control === "appearance.chatWidth"
          ? ["narrow", "default", "wide", "full"]
          : ["on", "off", "system"];
    if (typeof p.value !== "string" || !options.includes(p.value))
      throw new Error("Unsupported preference value.");
  } else if (typeof p.value !== "boolean") throw new Error("A switch requires a boolean value.");
  return {
    control: p.control,
    value: p.value,
    expectedRevision: p.expectedRevision,
    operationId: p.operationId,
  };
}
export function parseAppControlPanels(value: unknown): AppControlPanel[] | undefined {
  if (!Array.isArray(value) || value.length > 4) return undefined;
  const ids = new Set<string>();
  const panels: AppControlPanel[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const p = entry as Record<string, unknown>;
    if (
      p.version !== 1 ||
      typeof p.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/u.test(p.id) ||
      ids.has(p.id) ||
      !isAppControlTopic(p.topic) ||
      typeof p.fallback !== "string" ||
      p.fallback.length > 500 ||
      (p.workspaceId !== undefined &&
        (typeof p.workspaceId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(p.workspaceId))) ||
      Object.keys(p).some(
        (key) => !["version", "id", "topic", "fallback", "workspaceId"].includes(key),
      )
    )
      return undefined;
    ids.add(p.id);
    panels.push({
      version: 1,
      id: p.id,
      topic: p.topic,
      fallback: p.fallback,
      ...(p.workspaceId ? { workspaceId: p.workspaceId as string } : {}),
    });
  }
  return panels.length ? panels : undefined;
}
