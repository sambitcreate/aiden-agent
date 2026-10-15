// Tool policy for one unattended scheduled LLM run: which tool names are
// withheld, and which (if any) MCP servers the run may reach. Pure apart from
// the injected web search availability read so it can be tested without
// Electron; `schedule-execution.ts` supplies the real service.

import { APPROVAL_TOOL_NAMES } from "./coding-tools.js";
import { scheduledTaskAllowsWebSearch } from "./schedule-guard.js";
import { SCHEDULE_TOOL_NAME } from "./schedule-tool.js";
import type { ScheduledMcpServerBinding, ScheduledTask } from "./types.js";

export interface ScheduledGenerationToolPolicy {
  excludeToolNames: Set<string>;
  allowMcpTools: boolean;
  mcpServerIds: readonly string[] | undefined;
  mcpServerBindings: readonly ScheduledMcpServerBinding[] | undefined;
  providerFingerprint: string | undefined;
}

export async function scheduledGenerationToolPolicy(
  task: Pick<
    ScheduledTask,
    | "mode"
    | "executionProfile"
    | "webSearchEnabled"
    | "permission"
    | "mcpServerIds"
    | "mcpServerBindings"
    | "providerFingerprint"
  >,
  webSearchAvailability: () => Promise<{ ready?: boolean }>,
): Promise<ScheduledGenerationToolPolicy> {
  // A scheduled run never creates further schedules.
  const excluded = new Set<string>([SCHEDULE_TOOL_NAME]);
  let webSearchReady = false;
  if (scheduledTaskAllowsWebSearch(task)) {
    try {
      webSearchReady = (await webSearchAvailability()).ready === true;
    } catch {
      // Availability is categorical and fail-closed; a storage/provider
      // read failure must never turn an explicit task grant into access.
      webSearchReady = false;
    }
  }
  if (!webSearchReady) excluded.add("web_search");
  if (task.permission === "read-only") {
    for (const name of APPROVAL_TOOL_NAMES) excluded.add(name);
  }
  const legacyAllMcp =
    task.mcpServerIds === undefined &&
    task.executionProfile === undefined &&
    task.permission === "full";
  const mcpServerIds = task.mcpServerIds ?? (legacyAllMcp ? undefined : []);
  const allowMcpTools =
    task.permission === "full" && (legacyAllMcp || (mcpServerIds?.length ?? 0) > 0);
  return {
    excludeToolNames: excluded,
    allowMcpTools,
    mcpServerIds,
    mcpServerBindings: task.mcpServerBindings,
    providerFingerprint: task.providerFingerprint,
  };
}
