import type { AgentTool } from "@earendil-works/pi-agent-core";

export const SUBAGENTS_FEATURE_FLAG = "AIDEN_SUBAGENTS_ENABLED";
export const SUBAGENT_V2_FEATURE_FLAG = "AIDEN_SUBAGENTS_V2_ENABLED";
export const SUBAGENT_CHILD_WEB_FEATURE_FLAG =
  "AIDEN_SUBAGENT_CHILD_WEB_ENABLED";
export const SUBAGENT_CHILD_MCP_FEATURE_FLAG =
  "AIDEN_SUBAGENT_CHILD_MCP_ENABLED";
export const SUBAGENT_CHILD_MCP_MUTATIONS_FEATURE_FLAG =
  "AIDEN_SUBAGENT_CHILD_MCP_MUTATIONS_ENABLED";
export const SUBAGENT_CHILD_WRITE_FEATURE_FLAG =
  "AIDEN_SUBAGENT_CHILD_WRITE_ENABLED";
export const SUBAGENT_CHILD_SHELL_FEATURE_FLAG =
  "AIDEN_SUBAGENT_CHILD_SHELL_ENABLED";
export const SUBAGENT_CHILD_DELEGATION_FEATURE_FLAG =
  "AIDEN_SUBAGENT_CHILD_DELEGATION_ENABLED";
export const SUBAGENT_BACKGROUND_FEATURE_FLAG =
  "AIDEN_SUBAGENT_BACKGROUND_ENABLED";
export const SUBAGENT_HISTORY_DISABLED_ERROR =
  "Subagent history is unavailable while subagents are disabled.";

/**
 * Native subagents are available by default after the packaged soak gate.
 * Keep the existing environment variable as an emergency rollback switch.
 */
export function subagentsEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment[SUBAGENTS_FEATURE_FLAG]?.trim() !== "0";
}

/**
 * Select the canonical V2 lifecycle only while the whole feature is live.
 * Either switch set to `0` rolls production back to the V1 store; no V2 file
 * is opened, migrated, or mutated on that path.
 */
export function subagentV2Enabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    subagentsEnabled(environment) &&
    environment[SUBAGENT_V2_FEATURE_FLAG]?.trim() !== "0"
  );
}

/** Independent default-on rollback for host-proxied child web access. */
export function subagentChildWebEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    subagentV2Enabled(environment) &&
    environment[SUBAGENT_CHILD_WEB_FEATURE_FLAG]?.trim() !== "0"
  );
}

/** Independent default-on rollback for server-declared read-only child MCP access. */
export function subagentChildMcpEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    subagentV2Enabled(environment) &&
    environment[SUBAGENT_CHILD_MCP_FEATURE_FLAG]?.trim() !== "0"
  );
}

/**
 * Independent default-on rollback for foreground, approval-bound child MCP
 * mutations after the Phase 5C activation gate.
 */
export function subagentChildMcpMutationsEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    subagentChildMcpEnabled(environment) &&
    environment[SUBAGENT_CHILD_MCP_MUTATIONS_FEATURE_FLAG]?.trim() !== "0"
  );
}

/** Independent default-on rollback for approval-bound foreground child writes. */
export function subagentChildWriteEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    subagentV2Enabled(environment) &&
    environment[SUBAGENT_CHILD_WRITE_FEATURE_FLAG]?.trim() !== "0"
  );
}

/** Independent default-on rollback for attended full-host child shell execution. */
export function subagentChildShellEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    subagentV2Enabled(environment) &&
    environment[SUBAGENT_CHILD_SHELL_FEATURE_FLAG]?.trim() !== "0"
  );
}

/** Independent default-on rollback for bounded foreground depth-2 delegation. */
export function subagentChildDelegationEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    subagentV2Enabled(environment) &&
    environment[SUBAGENT_CHILD_DELEGATION_FEATURE_FLAG]?.trim() !== "0"
  );
}

/** Independent default-on rollback for durable read-only app-lifetime runs. */
export function subagentBackgroundEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    subagentV2Enabled(environment) &&
    environment[SUBAGENT_BACKGROUND_FEATURE_FLAG]?.trim() !== "0"
  );
}

/** Aggregate release evidence follows the same runtime capability boundary. */
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
    throw new Error(
      "Subagent tool construction is unavailable in this build phase.",
    );
  }
  tools.push(createTool());
}
