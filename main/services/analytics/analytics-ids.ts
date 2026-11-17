import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

import { BOT_PRESETS } from "../../../renderer/shared/bot-presets.js";
import type { GenerationThinkingLevel } from "../../../renderer/shared/generation-thinking.js";
import { ANTIGRAVITY_PROVIDER_ID } from "../antigravity/models.js";
import { CONCENTRATE_PROVIDER_ID } from "../concentrate-provider.js";
import { isCustomProviderId } from "../custom-provider-id.js";
import { MCP_PRESETS } from "../mcp-presets.js";
import type { ScheduledRunTrigger } from "../schedule-service-core.js";
import type { Workspace } from "../types.js";
import { isValidPropValue, type AnalyticsEventProps } from "./analytics-events.js";
import { normalizeKnownId } from "./analytics-sanitize.js";

// Turns the app's own identifiers into values the registry can carry. Anything
// a person could have typed (a custom provider, a local model, their own
// connector) leaves as "custom". This file imports nothing from Electron, so
// services bundled into the CLI can use it as they are.

const CUSTOM = "custom";
const ID_SPEC = { kind: "id" } as const;

let bundledCatalog: ReadonlyMap<string, ReadonlySet<string>> | undefined;

// The ids that ship in this build: Pi's bundled providers and models, plus the
// providers Aiden registers itself. Models fetched later never count, because a
// live list can carry whatever an endpoint returns.
function catalog(): ReadonlyMap<string, ReadonlySet<string>> {
  if (bundledCatalog) return bundledCatalog;
  const entries = new Map<string, ReadonlySet<string>>([
    [CONCENTRATE_PROVIDER_ID, new Set()],
    [ANTIGRAVITY_PROVIDER_ID, new Set()],
  ]);
  try {
    for (const provider of builtinProviders()) {
      entries.set(provider.id, new Set(provider.getModels().map((model) => model.id)));
    }
  } catch {
    // Every id then reads as "custom"; the action being counted carries on.
  }
  bundledCatalog = entries;
  return entries;
}

// A registry id is lowercase, so a catalog id like "Qwen/Qwen3" is sent folded.
function registryId(value: string): string {
  const folded = value.toLowerCase();
  return isValidPropValue(ID_SPEC, folded) ? folded : CUSTOM;
}

export function analyticsProviderId(providerId: unknown): string {
  if (typeof providerId !== "string" || isCustomProviderId(providerId)) return CUSTOM;
  return catalog().has(providerId) ? registryId(providerId) : CUSTOM;
}

export function analyticsModelId(providerId: unknown, modelId: unknown): string {
  if (typeof providerId !== "string" || typeof modelId !== "string" || isCustomProviderId(providerId)) return CUSTOM;
  return catalog().get(providerId)?.has(modelId) ? registryId(modelId) : CUSTOM;
}

const BOT_PRESET_IDS: ReadonlySet<string> = new Set(BOT_PRESETS.map((preset) => preset.id));
const CONNECTOR_PRESET_IDS: ReadonlySet<string> = new Set(MCP_PRESETS.map((preset) => preset.id));

export function analyticsBotPresetId(presetId: unknown): string {
  return normalizeKnownId(presetId, BOT_PRESET_IDS);
}

export function analyticsConnectorPresetId(presetId: unknown): string {
  return normalizeKnownId(presetId, CONNECTOR_PRESET_IDS);
}

export function analyticsThinking(
  level: GenerationThinkingLevel | undefined,
): AnalyticsEventProps<"chat_message_sent">["thinking"] {
  return level ?? "other";
}

// A chat on the hidden folder of a "No workspace" chat is not in a workspace.
export function analyticsWorkspaceKind(
  workspace: Pick<Workspace, "managedWorktree" | "scratch" | "noWorkspace"> | null | undefined,
): AnalyticsEventProps<"chat_created">["workspace_kind"] {
  if (!workspace || workspace.noWorkspace) return "none";
  if (workspace.managedWorktree) return "worktree";
  return workspace.scratch ? "scratch" : "folder";
}

export function analyticsRunTrigger(trigger: ScheduledRunTrigger): AnalyticsEventProps<"scheduled_task_ran">["trigger"] {
  return trigger.kind === "event" ? trigger.source : trigger.kind;
}
