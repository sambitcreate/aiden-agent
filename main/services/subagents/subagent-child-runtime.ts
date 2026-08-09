import { assistantUsageRecord } from "../usage-accounting.js";
import { usageStore } from "../usage-store.js";
import {
  runSubagentChild,
  type RunSubagentChildInput,
} from "./subagent-child-runner.js";
import { productionSubagentWebProxyHost } from "./subagent-web-proxy-production.js";
import { productionSubagentMcpReadHost } from "../mcp.js";
import { buildProductionSubagentChildTools } from "./subagent-tool-assembly.js";
import { productionSubagentMcpMutationHost } from "./subagent-mcp-mutation-production.js";
import {
  subagentChildDelegationEnabled,
  subagentChildMcpMutationsEnabled,
  subagentChildShellEnabled,
} from "./feature-flag.js";

/** Attach Electron-main persistence/accounting to the otherwise pure child runner. */
export function runProductionSubagentChild(input: RunSubagentChildInput) {
  const executeNested = input.executeNested
    ? (params: unknown, signal?: AbortSignal) => {
        if (!subagentChildDelegationEnabled()) {
          throw new Error(
            "Nested delegation is disabled by the host rollout flag.",
          );
        }
        return input.executeNested!(params, signal);
      }
    : undefined;
  return runSubagentChild({
    ...input,
    executeNested: subagentChildDelegationEnabled() ? executeNested : undefined,
    dependencies: {
      ...input.dependencies,
      buildTools: (toolInput) =>
        buildProductionSubagentChildTools(
          {
            ...toolInput,
            signal: input.signal,
            mcpMutationsEnabled: subagentChildMcpMutationsEnabled(),
            shellEnabled: subagentChildShellEnabled(),
          },
          {
            webHost: productionSubagentWebProxyHost,
            mcpHost: productionSubagentMcpReadHost,
            mcpMutationHost: productionSubagentMcpMutationHost,
          },
        ),
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
