import { GENERATION_THINKING_LEVELS, type GenerationThinkingLevel } from "./generation-thinking.js";

export const ADVISOR_CONFIGURATION_VERSION = 1 as const;
export const ADVISOR_DISCLOSURE_VERSION = 1 as const;

export interface AdvisorExecutorBlockRuleV1 {
  providerId: string;
  modelId: string;
  minEffort?: Exclude<GenerationThinkingLevel, "off">;
}

export interface AdvisorSelectionV1 {
  providerId: string;
  modelId: string;
  effort?: Exclude<GenerationThinkingLevel, "off">;
  disabledForExecutors: AdvisorExecutorBlockRuleV1[];
  disclosureVersion: typeof ADVISOR_DISCLOSURE_VERSION;
}

export interface AdvisorConfigurationV1 {
  version: typeof ADVISOR_CONFIGURATION_VERSION;
  selection: AdvisorSelectionV1 | null;
  disabledForExecutors: AdvisorExecutorBlockRuleV1[];
}

const SAFE_ID = /^[^\p{Cc}]{1,256}$/u;
const EFFORTS = new Set<string>(GENERATION_THINKING_LEVELS.filter((level) => level !== "off"));

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => key in value) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && SAFE_ID.test(value);
}

function parseBlockRule(value: unknown): AdvisorExecutorBlockRuleV1 | undefined {
  const input = record(value);
  if (!input || !exactKeys(input, ["providerId", "modelId"], ["minEffort"])) return undefined;
  if (!safeId(input.providerId) || !safeId(input.modelId)) return undefined;
  if (input.minEffort !== undefined && !EFFORTS.has(input.minEffort as string)) return undefined;
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    ...(input.minEffort === undefined
      ? {}
      : { minEffort: input.minEffort as Exclude<GenerationThinkingLevel, "off"> }),
  };
}

function parseBlockRules(value: unknown): AdvisorExecutorBlockRuleV1[] | undefined {
  if (!Array.isArray(value) || value.length > 128) return undefined;
  const rules = value.map(parseBlockRule);
  return rules.some((entry) => entry === undefined)
    ? undefined
    : (rules as AdvisorExecutorBlockRuleV1[]);
}

export function parseAdvisorSelection(value: unknown): AdvisorSelectionV1 | null | undefined {
  if (value === null) return null;
  const input = record(value);
  if (
    !input ||
    !exactKeys(
      input,
      ["providerId", "modelId", "disabledForExecutors", "disclosureVersion"],
      ["effort"],
    ) ||
    !safeId(input.providerId) ||
    !safeId(input.modelId) ||
    input.disclosureVersion !== ADVISOR_DISCLOSURE_VERSION ||
    (input.effort !== undefined && !EFFORTS.has(input.effort as string))
  ) {
    return undefined;
  }
  const disabledForExecutors = parseBlockRules(input.disabledForExecutors);
  if (!disabledForExecutors) return undefined;
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    ...(input.effort === undefined
      ? {}
      : { effort: input.effort as Exclude<GenerationThinkingLevel, "off"> }),
    disabledForExecutors,
    disclosureVersion: ADVISOR_DISCLOSURE_VERSION,
  };
}

export function parseAdvisorConfiguration(value: unknown): AdvisorConfigurationV1 | null {
  const input = record(value);
  if (!input || !exactKeys(input, ["version", "selection", "disabledForExecutors"])) return null;
  if (input.version !== ADVISOR_CONFIGURATION_VERSION) return null;
  const selection = parseAdvisorSelection(input.selection);
  const disabledForExecutors = parseBlockRules(input.disabledForExecutors);
  if (
    selection === undefined ||
    !disabledForExecutors ||
    (selection !== null &&
      JSON.stringify(selection.disabledForExecutors) !== JSON.stringify(disabledForExecutors))
  ) {
    return null;
  }
  return {
    version: ADVISOR_CONFIGURATION_VERSION,
    selection,
    disabledForExecutors,
  };
}

export function emptyAdvisorConfiguration(): AdvisorConfigurationV1 {
  return {
    version: ADVISOR_CONFIGURATION_VERSION,
    selection: null,
    disabledForExecutors: [],
  };
}
