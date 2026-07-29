import { assistantUsageRecord } from "../usage-accounting.js";
import { usageStore } from "../usage-store.js";
import { buildAgentTools } from "../tools.js";
import { runSubagentChild, type RunSubagentChildInput } from "./subagent-child-runner.js";

/** Attach Electron-main persistence/accounting to the otherwise pure child runner. */
export function runProductionSubagentChild(input: RunSubagentChildInput) {
  return runSubagentChild({
    ...input,
    dependencies: {
      ...input.dependencies,
      buildTools: async ({ workspaceRoot, permission, role, inheritedCeiling }) =>
        buildAgentTools({
          workspaceRoot,
          permission,
          mode: "subagent",
          capabilityProfile: {
            kind: "subagent",
            role,
            inheritedCeiling,
          },
        }),
      recordUsage: async (message, runtime) => {
        await input.dependencies?.recordUsage?.(message, runtime);
        await usageStore.record(
          assistantUsageRecord({
            message,
            provider: runtime.provider,
            model: runtime.model,
            source: "subagent",
          }),
        );
      },
    },
  });
}
