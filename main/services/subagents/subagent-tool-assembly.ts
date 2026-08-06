import type { WorkspacePermission } from "../types.js";
import type { SubagentAuthorityV2 } from "./authority-v2.js";
import type { SubagentReadToolName } from "./capability-profile.js";
import type { SubagentOutboundToolBindingV2 } from "./outbound-approval-v2.js";
import {
  createReadOnlySubagentMcpTools,
  subagentMcpAgentToolNameForBinding,
  subagentMcpApprovalBindings,
  type SubagentMcpReadHost,
} from "./subagent-mcp-read.js";
import {
  createSubagentMcpMutationToolsV2,
  subagentMcpMutationBindingsV2,
  type SubagentMcpMutationBindingV2,
  type SubagentMcpMutationHostV2,
} from "./subagent-mcp-mutation.js";
import type { SubagentWebProxyHost } from "./subagent-web-proxy.js";
import { buildSubagentCapabilityTools } from "./capability-tools.js";
import {
  createSubagentWorkspaceWriteTools,
  type SubagentWorkspaceWriteToolBindingV2,
} from "./subagent-workspace-write.js";
import { createSubagentShellTool, type SubagentShellToolBindingV2 } from "./subagent-shell.js";

export interface ProductionSubagentToolAssemblyInput {
  workspaceRoot: string;
  permission: WorkspacePermission;
  role: string;
  inheritedCeiling: readonly SubagentReadToolName[];
  authority?: SubagentAuthorityV2;
  currentAuthority?: () => SubagentAuthorityV2 | undefined;
  consumeNetworkOperation?: (authority: SubagentAuthorityV2) => boolean;
  mcpMutationsEnabled?: boolean;
  shellEnabled?: boolean;
  now?: () => number;
  signal?: AbortSignal;
}

export interface ProductionSubagentToolAssemblyDependencies {
  webHost: Pick<SubagentWebProxyHost, "toolForAuthority">;
  mcpHost: SubagentMcpReadHost;
  mcpMutationHost?: SubagentMcpMutationHostV2;
}

/** Positive main-owned assembly; no ambient parent registry or credential object enters. */
export async function buildProductionSubagentChildTools(
  input: ProductionSubagentToolAssemblyInput,
  dependencies: ProductionSubagentToolAssemblyDependencies,
) {
  const tools = buildSubagentCapabilityTools({
    workspaceRoot: input.workspaceRoot,
    permission:
      input.authority && !input.authority.capabilities.workspaceRead ? "none" : input.permission,
    capabilityProfile: {
      kind: "subagent",
      role: input.role,
      inheritedCeiling: input.inheritedCeiling,
    },
  }).tools;
  const outboundApprovalBindings: SubagentOutboundToolBindingV2[] = [];
  const workspaceWriteApprovalBindings: SubagentWorkspaceWriteToolBindingV2[] = [];
  const mcpMutationApprovalBindings: SubagentMcpMutationBindingV2[] = [];
  const shellApprovalBindings: SubagentShellToolBindingV2[] = [];
  const authority = input.authority;
  if (!authority) {
    return {
      tools,
      outboundApprovalBindings,
      workspaceWriteApprovalBindings,
      mcpMutationApprovalBindings,
      shellApprovalBindings,
    };
  }
  if (authority.execution !== "foreground") {
    throw new Error("Background subagent tool assembly is unavailable.");
  }
  if (!input.currentAuthority) {
    throw new Error("Current subagent authority resolution is unavailable.");
  }
  const readScopes = authority.capabilities.mcp.flatMap((scope) => {
    const readTools = scope.tools.filter((tool) => tool.effect === "read");
    return readTools.length > 0 ? [{ ...scope, tools: readTools }] : [];
  });
  const mutationScopes = authority.capabilities.mcp.flatMap((scope) => {
    const mutationTools = scope.tools.filter((tool) => tool.effect === "mutating");
    return mutationTools.length > 0 ? [{ ...scope, tools: mutationTools }] : [];
  });
  const hasOutboundCapability =
    authority.capabilities.web || readScopes.length > 0 || mutationScopes.length > 0;
  if (hasOutboundCapability && !input.consumeNetworkOperation) {
    throw new Error("Subagent network budget is unavailable.");
  }
  const web = authority.capabilities.web
    ? dependencies.webHost.toolForAuthority(
        authority,
        input.currentAuthority,
        input.consumeNetworkOperation!,
      )
    : undefined;
  if (web) {
    tools.push(web);
    outboundApprovalBindings.push({ toolName: web.name, kind: "web" });
  }
  if (readScopes.length > 0) {
    const mcpTools = await createReadOnlySubagentMcpTools({
      scopes: readScopes,
      host: dependencies.mcpHost,
      signal: input.signal,
      consumeNetworkOperation: () => {
        const current = input.currentAuthority?.();
        const now = input.now ?? Date.now;
        if (
          !current ||
          JSON.stringify(current) !== JSON.stringify(authority) ||
          current.expiresAt <= now()
        ) {
          throw new Error("Subagent MCP authority was revoked.");
        }
        const consumed = input.consumeNetworkOperation?.(current);
        if (consumed !== true) {
          throw new Error("Subagent MCP network budget was not granted.");
        }
      },
    });
    tools.push(...mcpTools);
    outboundApprovalBindings.push(
      ...subagentMcpApprovalBindings(readScopes).map(
        (binding): SubagentOutboundToolBindingV2 => ({
          toolName: binding.childAgentToolName,
          kind: "mcp",
          mcp: {
            serverId: binding.serverId,
            connectionFingerprint: binding.connectionFingerprint,
            tool: binding.tool,
          },
        }),
      ),
    );
  }
  if (mutationScopes.length > 0) {
    if (!input.mcpMutationsEnabled || !dependencies.mcpMutationHost) {
      throw new Error("Subagent MCP mutation tool assembly is unavailable.");
    }
    const bindings = subagentMcpMutationBindingsV2(mutationScopes, (serverId, toolName) =>
      subagentMcpAgentToolNameForBinding({ serverId }, { toolName }),
    );
    const mutationTools = await createSubagentMcpMutationToolsV2({
      bindings,
      host: dependencies.mcpMutationHost,
      signal: input.signal ?? new AbortController().signal,
    });
    tools.push(...mutationTools);
    mcpMutationApprovalBindings.push(...bindings);
  }
  if (authority.capabilities.workspaceWrite) {
    if (input.permission !== "ask" && input.permission !== "full") {
      throw new Error("Subagent workspace-write permission is unavailable.");
    }
    const write = createSubagentWorkspaceWriteTools();
    tools.push(...write.tools);
    workspaceWriteApprovalBindings.push(...write.bindings);
  }
  if (authority.capabilities.shell) {
    if (!input.shellEnabled || input.permission === "none") {
      throw new Error("Subagent shell tool assembly is unavailable.");
    }
    const shell = createSubagentShellTool();
    tools.push(shell.tool);
    shellApprovalBindings.push(shell.binding);
  }
  return {
    tools,
    outboundApprovalBindings,
    workspaceWriteApprovalBindings,
    mcpMutationApprovalBindings,
    shellApprovalBindings,
  };
}
