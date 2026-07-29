import type { AgentTool } from "@earendil-works/pi-agent-core";

export const SUBAGENTS_FEATURE_FLAG = "AIDEN_SUBAGENTS_ENABLED";
export const SUBAGENT_HISTORY_DISABLED_ERROR =
  "Subagent history is unavailable while subagents are disabled.";

/** Subagents are internal opt-in until the packaged soak gate is complete. */
export function subagentsEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment[SUBAGENTS_FEATURE_FLAG] === "1";
}

/** Aggregate release evidence exists only inside the same internal opt-in. */
export function subagentHealthMetricsEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return subagentsEnabled(environment);
}

export function assertSubagentHistoryEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (!subagentsEnabled(environment)) {
    throw new Error(SUBAGENT_HISTORY_DISABLED_ERROR);
  }
}

/**
 * The single registration seam for the model-facing tool. The factory is not
 * evaluated while disabled, so tool construction cannot gain side effects.
 */
export function registerSubagentTool(
  tools: AgentTool[],
  createTool: (() => AgentTool) | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (!subagentsEnabled(environment)) return;
  if (!createTool) {
    throw new Error("Subagent tool construction is unavailable in this build phase.");
  }
  tools.push(createTool());
}
