import { productionSubagentMcpReadHost } from "../mcp.js";
import {
  normalizeSubagentMcpInventoryV2,
  subagentMcpConnectionFingerprint,
  type SubagentMcpClientPort,
} from "./subagent-mcp-read.js";
import type {
  SubagentMcpMutationBindingV2,
  SubagentMcpMutationHostV2,
  SubagentMcpMutationRemoteSessionV2,
} from "./subagent-mcp-mutation.js";

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("MCP mutation cancelled.");
}

/** Fresh remote-only production client held for exactly one inspection/call lifecycle. */
export const productionSubagentMcpMutationHost: SubagentMcpMutationHostV2 = Object.freeze({
  async openFreshSession(
    binding: SubagentMcpMutationBindingV2,
    signal: AbortSignal,
  ): Promise<SubagentMcpMutationRemoteSessionV2> {
    if (signal.aborted) throw abortReason(signal);
    const server = await productionSubagentMcpReadHost.resolveServer(binding.serverId, signal);
    if (!server?.enabled || server.transport === "stdio") {
      throw new Error("Subagent MCP mutation requires a configured remote server.");
    }
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let resolveReady!: (client: SubagentMcpClientPort) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<SubagentMcpClientPort>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const lifecycle = productionSubagentMcpReadHost
      .withClient(server, signal, async (client) => {
        resolveReady(client);
        await held;
      })
      .catch((error) => {
        rejectReady(error);
        throw error;
      });
    void lifecycle.catch(() => undefined);
    const client = await ready;
    let closed = false;
    let dispatched = false;
    const inspect: SubagentMcpMutationRemoteSessionV2["inspect"] = async (currentSignal) => {
      if (closed || currentSignal.aborted) throw abortReason(currentSignal);
      if (!(await client.credentialRevisionIsCurrent(currentSignal))) {
        throw new Error("MCP credential revision changed.");
      }
      const remote = await client.listTools(currentSignal);
      if (!(await client.credentialRevisionIsCurrent(currentSignal))) {
        throw new Error("MCP credential revision changed.");
      }
      const tools = normalizeSubagentMcpInventoryV2(remote, client.redactCredentialText);
      const tool = tools.find((candidate) => candidate.toolName === binding.tool.toolName);
      if (!tool || tool.effect !== "mutating") {
        throw new Error("MCP mutation binding changed.");
      }
      return {
        serverId: server.id,
        connectionFingerprint: subagentMcpConnectionFingerprint(server, client.credentialRevision),
        toolName: tool.toolName,
        schemaHash: tool.schemaHash,
        effectProfile: tool.effectProfile,
        inputSchema: tool.inputSchema,
      };
    };
    return {
      inspect,
      dispatchRaw(toolName, argumentsValue, currentSignal, beforeRawBytes) {
        if (closed || dispatched || toolName !== binding.tool.toolName || !client.callToolRaw) {
          throw new Error("MCP mutation raw dispatch is unavailable.");
        }
        dispatched = true;
        return client.callToolRaw(toolName, argumentsValue, currentSignal, beforeRawBytes);
      },
      redactCredentialText: client.redactCredentialText,
      async close() {
        if (closed) return;
        closed = true;
        release();
        await lifecycle;
      },
    };
  },
});
