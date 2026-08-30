import { GENERATION_THINKING_LEVELS, type GenerationThinkingLevel } from "./generation-thinking.js";

export interface AdvisorSelectionV1 {
  providerId: string;
  modelId: string;
  effort?: Exclude<GenerationThinkingLevel, "off">;
}

const SAFE_ID = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,256}$/u;
const EFFORTS = new Set<string>(GENERATION_THINKING_LEVELS.filter((level) => level !== "off"));

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

/** Strict one-consultation selection; it is never persisted or reused. */
export function parseAdvisorSelection(value: unknown): AdvisorSelectionV1 | undefined {
  const input = record(value);
  if (!input) return undefined;
  const keys = Object.keys(input);
  if (
    !keys.every((key) => key === "providerId" || key === "modelId" || key === "effort") ||
    !safeId(input.providerId) ||
    !safeId(input.modelId) ||
    (input.effort !== undefined && !EFFORTS.has(input.effort as string))
  ) {
    return undefined;
  }
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    ...(input.effort === undefined
      ? {}
      : { effort: input.effort as Exclude<GenerationThinkingLevel, "off"> }),
  };
}
