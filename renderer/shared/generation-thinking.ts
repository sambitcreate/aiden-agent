export const GENERATION_THINKING_LEVELS = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type GenerationThinkingLevel =
  (typeof GENERATION_THINKING_LEVELS)[number];

const GENERATION_THINKING_LEVEL_SET = new Set<string>(
  GENERATION_THINKING_LEVELS,
);

export function isGenerationThinkingLevel(
  value: unknown,
): value is GenerationThinkingLevel {
  return typeof value === "string" && GENERATION_THINKING_LEVEL_SET.has(value);
}
