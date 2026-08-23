import { BOT_CAPABILITY_LIMITS } from "../../renderer/shared/bot-capabilities.js";
import { botCapabilityFactsFingerprint } from "./bot-capability-catalog-core.js";
import type { BotCapabilityIncarnationStore } from "./bot-capability-incarnation-store.js";
import { mcpRuntimeConnectionSnapshot } from "./mcp-credential-cleanup-core.js";
import type { McpServer } from "./types.js";
import {
  normalizeSubagentMcpInventoryV2,
  type SubagentMcpRemoteTool,
} from "./subagents/subagent-mcp-read.js";
import type { SubagentMcpScopeV2 } from "./subagents/authority-v2.js";

export const BOT_MCP_DISCOVERY_DEADLINE_MS = 10_000;

export interface BotMcpInventoryDependencies {
  listServers(): Promise<readonly McpServer[]>;
  credentialSignature(server: McpServer, signal: AbortSignal): Promise<string>;
  inspectTools(server: McpServer, signal: AbortSignal): Promise<readonly SubagentMcpRemoteTool[]>;
  incarnations: Pick<BotCapabilityIncarnationStore, "reconcileNamespace">;
  deadlineMs?: number;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Bot MCP inventory discovery was cancelled.");
}

/**
 * Fresh, Bot-owned MCP discovery. It intentionally does not reuse the
 * subagent catalog cache or its 16-server/32-tool authority projection.
 */
export async function resolveBotMcpInventory(
  parentSignal: AbortSignal,
  dependencies: BotMcpInventoryDependencies,
): Promise<readonly SubagentMcpScopeV2[]> {
  if (parentSignal.aborted) throw abortReason(parentSignal);
  const deadlineMs = dependencies.deadlineMs ?? BOT_MCP_DISCOVERY_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000) {
    throw new Error("Bot MCP discovery deadline is invalid.");
  }
  const controller = new AbortController();
  const relay = () => controller.abort(abortReason(parentSignal));
  parentSignal.addEventListener("abort", relay, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error("Bot MCP inventory discovery deadline elapsed.")),
    deadlineMs,
  );
  let resolveCancelled!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });
  controller.signal.addEventListener("abort", resolveCancelled, { once: true });
  try {
    const work = (async () => {
      const servers = [...(await dependencies.listServers())]
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, BOT_CAPABILITY_LIMITS.connections);
      const signatures = await Promise.all(
        servers.map((server) => dependencies.credentialSignature(server, controller.signal)),
      );
      const incarnations = await dependencies.incarnations.reconcileNamespace(
        "mcp",
        servers.map((server, index) => ({
          sourceId: server.id,
          credentialSignature: signatures[index]!,
        })),
      );
      const incarnationById = new Map(
        incarnations.map((value) => [value.sourceId, value] as const),
      );
      const completed: SubagentMcpScopeV2[] = [];
      await Promise.allSettled(
        servers.filter(({ enabled }) => enabled).map(async (server) => {
          const incarnation = incarnationById.get(server.id);
          if (!incarnation) throw new Error("Bot MCP incarnation was not resolved.");
          const tools = normalizeSubagentMcpInventoryV2(
            await dependencies.inspectTools(server, controller.signal),
          ).map((tool) =>
            tool.effect === "read"
              ? { toolName: tool.toolName, schemaHash: tool.schemaHash, effect: tool.effect }
              : {
                  toolName: tool.toolName,
                  schemaHash: tool.schemaHash,
                  effect: tool.effect,
                  effectProfile: { ...tool.effectProfile },
                },
          );
          if (controller.signal.aborted || tools.length === 0) return;
          completed.push({
            serverId: server.id,
            connectionFingerprint: botCapabilityFactsFingerprint({
              runtime: mcpRuntimeConnectionSnapshot(server),
              resourceIncarnation: incarnation.resourceIncarnation,
              credentialIncarnation: incarnation.credentialIncarnation,
            }),
            tools,
          });
        }),
      );
      return completed.sort((left, right) => left.serverId.localeCompare(right.serverId));
    })();
    const outcome = await Promise.race([
      work.then((scopes) => ({ kind: "completed" as const, scopes })),
      cancelled.then(() => ({ kind: "cancelled" as const })),
    ]);
    if (parentSignal.aborted) throw abortReason(parentSignal);
    return outcome.kind === "completed" ? outcome.scopes : [];
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", relay);
    controller.signal.removeEventListener("abort", resolveCancelled);
    controller.abort(new Error("Bot MCP inventory discovery completed."));
  }
}
