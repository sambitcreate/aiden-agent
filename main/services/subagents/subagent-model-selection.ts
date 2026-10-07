// Pure per-child model and reasoning-effort policy. The Mac host resolves the
// runtime for whatever this module chooses; renderers and phones only display
// the recorded outcome. Permissions, approvals, sandbox, and working directory
// are deliberately absent: a child's model never changes its run grant.

import {
  GENERATION_THINKING_LEVELS,
  isGenerationThinkingLevel,
  type GenerationThinkingLevel,
} from "../../../renderer/shared/generation-thinking.js";
import type { SubagentModelSelectionSource } from "../../../renderer/shared/subagent-runs.js";
import { isSubagentRole, type SubagentRole } from "./capability-profile.js";

/** The tool schema lists at most this many models, parent first. */
export const MAX_SUBAGENT_MODEL_CHOICES = 6;
const MAX_MODEL_KEY_LENGTH = 320;
const SAFE_KEY = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;

export type { SubagentModelSelectionSource };

export interface SubagentModelCandidate {
  providerId: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
}

export interface SubagentModelRoleSetting {
  model?: string;
  effort?: GenerationThinkingLevel;
  /** A locked role ignores spawn arguments and applies after every default. */
  locked?: boolean;
}

/** Optional `settings.subagentModels`; absent means children inherit the parent. */
export interface SubagentModelSettings {
  defaultModel?: string;
  defaultEffort?: GenerationThinkingLevel;
  roles?: Partial<Record<SubagentRole, SubagentModelRoleSetting>>;
  /** Keys an agent may request. Absent: the parent plus each provider's default model. */
  allowedModels?: string[];
  maxEffort?: GenerationThinkingLevel;
  allowCostlierModels?: boolean;
}

export interface SubagentModelPolicy {
  parent: SubagentModelCandidate & { effort: GenerationThinkingLevel };
  /** Every connected chat model, in preference order. */
  candidates: readonly SubagentModelCandidate[];
  /** False for bot and Assistant generations, whose runtime is bound by their grant. */
  overridesAllowed: boolean;
  settings?: SubagentModelSettings;
}

export interface SubagentModelRequest {
  role: SubagentRole;
  model?: string;
  effort?: GenerationThinkingLevel;
}

export interface SubagentModelPlan {
  candidate: SubagentModelCandidate;
  modelSource: SubagentModelSelectionSource;
  /** Undefined means "use the chosen model's default effort". */
  effort?: GenerationThinkingLevel;
  effortSource: SubagentModelSelectionSource;
  /** Explicit agent picks are strict; configured values clamp with a warning. */
  strictEffort: boolean;
  warnings: string[];
}

export interface SubagentModelRuntimeFacts {
  supportedEfforts: readonly GenerationThinkingLevel[];
  defaultEffort: GenerationThinkingLevel;
  local: boolean;
  /** USD per million tokens; zero or absent means unknown or free. */
  cost?: { input: number; output: number };
}

export interface SubagentModelSelection {
  providerId: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  effort: GenerationThinkingLevel;
  modelSource: SubagentModelSelectionSource;
  effortSource: SubagentModelSelectionSource;
  warnings: string[];
}

export type SubagentModelResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SubagentModelToolOptions {
  models: readonly SubagentModelCandidate[];
  efforts: readonly GenerationThinkingLevel[];
}

export function subagentModelKey(candidate: Pick<SubagentModelCandidate, "providerId" | "modelId">): string {
  return `${candidate.providerId}/${candidate.modelId}`;
}

export function isSubagentModelKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_MODEL_KEY_LENGTH &&
    value.trim() === value &&
    SAFE_KEY.test(value) &&
    /^[^/]+\/.+$/u.test(value)
  );
}

function effortRank(level: GenerationThinkingLevel): number {
  return GENERATION_THINKING_LEVELS.indexOf(level);
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Lenient: an invalid field is dropped so a bad edit never blocks delegation. */
export function parseSubagentModelSettings(value: unknown): SubagentModelSettings | undefined {
  const input = plainRecord(value);
  if (!input) return undefined;
  const settings: SubagentModelSettings = {};
  if (isSubagentModelKey(input.defaultModel)) settings.defaultModel = input.defaultModel;
  if (isGenerationThinkingLevel(input.defaultEffort)) settings.defaultEffort = input.defaultEffort;
  if (isGenerationThinkingLevel(input.maxEffort)) settings.maxEffort = input.maxEffort;
  if (typeof input.allowCostlierModels === "boolean") {
    settings.allowCostlierModels = input.allowCostlierModels;
  }
  if (Array.isArray(input.allowedModels)) {
    settings.allowedModels = [...new Set(input.allowedModels.filter(isSubagentModelKey))];
  }
  const roles = plainRecord(input.roles);
  if (roles) {
    const parsed: Partial<Record<SubagentRole, SubagentModelRoleSetting>> = {};
    for (const [role, raw] of Object.entries(roles)) {
      const entry = plainRecord(raw);
      if (!isSubagentRole(role) || !entry) continue;
      const setting: SubagentModelRoleSetting = {};
      if (isSubagentModelKey(entry.model)) setting.model = entry.model;
      if (isGenerationThinkingLevel(entry.effort)) setting.effort = entry.effort;
      if (entry.locked === true) setting.locked = true;
      if (setting.model !== undefined || setting.effort !== undefined) parsed[role] = setting;
    }
    if (Object.keys(parsed).length > 0) settings.roles = parsed;
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/** The exact models an agent may request: parent first, bounded, never unconnected. */
export function requestableSubagentModels(policy: SubagentModelPolicy): SubagentModelCandidate[] {
  const parentKey = subagentModelKey(policy.parent);
  if (!policy.overridesAllowed) return [policy.parent];
  const byKey = new Map(policy.candidates.map((candidate) => [subagentModelKey(candidate), candidate]));
  const ordered: SubagentModelCandidate[] = [policy.parent];
  const seen = new Set([parentKey]);
  const add = (candidate: SubagentModelCandidate | undefined) => {
    if (!candidate || ordered.length >= MAX_SUBAGENT_MODEL_CHOICES) return;
    const key = subagentModelKey(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(candidate);
  };
  const allowed = policy.settings?.allowedModels;
  if (allowed) {
    for (const key of allowed) add(byKey.get(key));
    return ordered;
  }
  // Without an allowlist, take models round-robin by provider (parent's
  // provider first), in discovery order, which lists each provider default first.
  const queues = new Map<string, SubagentModelCandidate[]>([[policy.parent.providerId, []]]);
  for (const candidate of policy.candidates) {
    const queue = queues.get(candidate.providerId) ?? [];
    queue.push(candidate);
    queues.set(candidate.providerId, queue);
  }
  while (ordered.length < MAX_SUBAGENT_MODEL_CHOICES && [...queues.values()].some((queue) => queue.length > 0)) {
    for (const queue of queues.values()) add(queue.shift());
  }
  return ordered;
}

/** Undefined when only the parent model is allowed, so the schema hides both fields. */
export function subagentModelToolOptions(policy: SubagentModelPolicy): SubagentModelToolOptions | undefined {
  const models = requestableSubagentModels(policy);
  if (models.length < 2) return undefined;
  const ceiling = policy.settings?.maxEffort;
  return {
    models,
    efforts: GENERATION_THINKING_LEVELS.filter(
      (level) => ceiling === undefined || effortRank(level) <= effortRank(ceiling),
    ),
  };
}

function availableList(models: readonly SubagentModelCandidate[]): string {
  return models.map(subagentModelKey).join(", ");
}

/**
 * Phase one picks the model. Precedence: explicit spawn argument, then the
 * configured role or global default, then the parent; a locked role applies last.
 */
export function planSubagentModel(
  policy: SubagentModelPolicy,
  request: SubagentModelRequest,
  /** A depth-2 child inherits from its depth-1 parent, not the root response. */
  inheritFrom: SubagentModelCandidate & { effort: GenerationThinkingLevel } = policy.parent,
): SubagentModelResult<SubagentModelPlan> {
  const requestable = requestableSubagentModels(policy);
  const warnings: string[] = [];
  const parentKey = subagentModelKey(inheritFrom);
  const connected = new Map<string, SubagentModelCandidate>([
    [subagentModelKey(policy.parent), policy.parent],
    [parentKey, inheritFrom],
    ...policy.candidates.map((candidate) => [subagentModelKey(candidate), candidate] as const),
  ]);
  const role = policy.overridesAllowed ? policy.settings?.roles?.[request.role] : undefined;
  const locked = role?.locked === true;

  if (request.model !== undefined && !locked) {
    const chosen = requestable.find((candidate) => subagentModelKey(candidate) === request.model);
    if (!chosen) {
      return {
        ok: false,
        error:
          requestable.length < 2
            ? "Subagent model overrides are not available for this response; omit model to use the current model."
            : `Model ${request.model} is not available for subagents. Available models: ${availableList(requestable)}.`,
      };
    }
  }
  if (request.effort !== undefined && !policy.overridesAllowed) {
    return {
      ok: false,
      error: "Subagent effort overrides are not available for this response; omit effort to use the current setting.",
    };
  }
  if (request.effort !== undefined && !locked) {
    const ceiling = policy.settings?.maxEffort;
    if (ceiling !== undefined && effortRank(request.effort) > effortRank(ceiling)) {
      return {
        ok: false,
        error: `Effort ${request.effort} exceeds the subagent effort ceiling (${ceiling}).`,
      };
    }
  }

  const configured = (key: string | undefined, label: string): SubagentModelCandidate | undefined => {
    if (key === undefined) return undefined;
    const candidate = connected.get(key);
    if (!candidate) warnings.push(`${label} model ${key} is not connected; using the current model.`);
    return candidate;
  };

  let candidate: SubagentModelCandidate = inheritFrom;
  let modelSource: SubagentModelSelectionSource = "inherited";
  let effort: GenerationThinkingLevel | undefined;
  let effortSource: SubagentModelSelectionSource = "inherited";
  let strictEffort = false;

  if (locked) {
    const lockedModel = configured(role?.model, `Locked ${request.role}`);
    if (lockedModel) {
      candidate = lockedModel;
      modelSource = "role_locked";
    }
    if (role?.effort !== undefined) {
      effort = role.effort;
      effortSource = "role_locked";
    }
    if (request.model !== undefined || request.effort !== undefined) {
      warnings.push(`The ${request.role} role is locked by settings; requested model and effort were ignored.`);
    }
  } else {
    const explicit = request.model === undefined
      ? undefined
      : requestable.find((entry) => subagentModelKey(entry) === request.model);
    const configuredModel = policy.overridesAllowed
      ? configured(role?.model, `Configured ${request.role}`) ??
        (role?.model === undefined ? configured(policy.settings?.defaultModel, "Configured default") : undefined)
      : undefined;
    if (explicit) {
      candidate = explicit;
      modelSource = "requested";
    } else if (configuredModel) {
      candidate = configuredModel;
      modelSource = "configured";
    }
    const configuredEffort = policy.overridesAllowed
      ? role?.effort ?? policy.settings?.defaultEffort
      : undefined;
    if (request.effort !== undefined) {
      effort = request.effort;
      effortSource = "requested";
      strictEffort = true;
    } else if (configuredEffort !== undefined && modelSource !== "requested") {
      effort = configuredEffort;
      effortSource = "configured";
    }
  }

  if (effort === undefined && subagentModelKey(candidate) === parentKey) {
    effort = inheritFrom.effort;
    effortSource = "inherited";
  } else if (effort === undefined) {
    // A different model starts from its own default, never the parent's effort.
    effortSource = modelSource;
  }
  return { ok: true, value: { candidate, modelSource, effort, effortSource, strictEffort, warnings } };
}

/**
 * Phase two validates the effort against the chosen model's resolved runtime
 * and applies the effort ceiling and the no-costlier-than-parent guard.
 */
export function finalizeSubagentModel(
  policy: SubagentModelPolicy,
  plan: SubagentModelPlan,
  child: SubagentModelRuntimeFacts,
  parent: Pick<SubagentModelRuntimeFacts, "cost">,
): SubagentModelResult<SubagentModelSelection> {
  const warnings = [...plan.warnings];
  const label = subagentModelKey(plan.candidate);
  const ceiling = policy.settings?.maxEffort;
  const withinCeiling = (level: GenerationThinkingLevel) =>
    ceiling === undefined || effortRank(level) <= effortRank(ceiling);

  if (
    plan.modelSource === "requested" &&
    policy.settings?.allowCostlierModels !== true &&
    !child.local &&
    isCostlier(child.cost, parent.cost)
  ) {
    return {
      ok: false,
      error: `Model ${label} costs more than the current model. Choose the current model or a cheaper one, or allow costlier subagent models in settings.`,
    };
  }

  let effort = plan.effort ?? child.defaultEffort;
  if (!child.supportedEfforts.includes(effort)) {
    if (plan.strictEffort) {
      return {
        ok: false,
        error: `Effort ${effort} is not supported by ${label}. Supported efforts: ${child.supportedEfforts.join(", ") || "none"}.`,
      };
    }
    warnings.push(`Effort ${effort} is not supported by ${label}; using ${child.defaultEffort}.`);
    effort = child.defaultEffort;
  }
  if (!withinCeiling(effort)) {
    const capped = [...child.supportedEfforts]
      .filter(withinCeiling)
      .sort((left, right) => effortRank(right) - effortRank(left))[0];
    if (!capped) {
      return { ok: false, error: `${label} has no effort within the subagent ceiling (${ceiling}).` };
    }
    warnings.push(`Effort ${effort} exceeds the subagent ceiling; using ${capped}.`);
    effort = capped;
  }
  return {
    ok: true,
    value: {
      providerId: plan.candidate.providerId,
      providerLabel: plan.candidate.providerLabel,
      modelId: plan.candidate.modelId,
      modelLabel: plan.candidate.modelLabel,
      effort,
      modelSource: plan.modelSource,
      effortSource: plan.effortSource,
      warnings,
    },
  };
}

function isCostlier(
  child: SubagentModelRuntimeFacts["cost"],
  parent: SubagentModelRuntimeFacts["cost"],
): boolean {
  if (!child || (child.input <= 0 && child.output <= 0)) return false;
  if (!parent || (parent.input <= 0 && parent.output <= 0)) return true;
  return child.input > parent.input || child.output > parent.output;
}
