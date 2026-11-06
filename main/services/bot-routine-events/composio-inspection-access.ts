import type { BotCapabilityStore } from "../bot-capability-store.js";
import { isComposioServiceCapability } from "../bot-connection-capability-identity.js";
import { botMcpLiveToolGrantFacts } from "../bot-tool-authority.js";
import { composioServiceToolDescriptor, isComposioServiceServer } from "../composio-service-tool.js";
import { mcpServerOffersTools } from "../../../renderer/shared/mcp-exposure.js";
import type { McpServer } from "../types.js";
import { BotConnectorWatchError } from "./connector-service.js";

/** Offline only: no catalog snapshot or tools/list may precede this check. */
export function createComposioInspectionAccess(ports: {
  store: Pick<BotCapabilityStore, "getBotPolicy" | "getBotBinding">;
  currentServer(serverId: string): Promise<McpServer | undefined>;
  schedulesEnabled(): Promise<boolean>;
  connectionFingerprint(serverId: string, signal: AbortSignal): Promise<string | undefined>;
}) {
  return async (botId: string, server: McpServer, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const denied = () => new BotConnectorWatchError("capability_denied", "Allow Composio once and Schedules in this Bot’s current Access settings, then find sources again.");
    const currentServer = await ports.currentServer(server.id);
    if (!currentServer || !isComposioServiceServer(currentServer) || !currentServer.enabled || !mcpServerOffersTools(currentServer) || currentServer.hiddenTools?.length || !await ports.schedulesEnabled()) throw denied();
    const policy = await ports.store.getBotPolicy(botId);
    if (policy.accessMode === "custom") {
      const binding = await ports.store.getBotBinding(botId);
      const connection = binding?.connections.find((item) => item.sourceId === server.id);
      const expected = botMcpLiveToolGrantFacts(composioServiceToolDescriptor())!;
      const service = connection?.tools[0];
      if (!connection || !isComposioServiceCapability(connection) || !policy.custom.connectionIds.includes(connection.option.id)
        || connection.tools.length !== 1 || !service || service.name !== expected.name || service.exactFingerprint !== expected.exactFingerprint
        || !binding?.otherCapabilities.some((item) => item.kind === "schedules" && policy.custom.otherCapabilityIds.includes(item.option.id))
        || connection.connectionFingerprint !== await ports.connectionFingerprint(server.id, signal)) throw denied();
      if ((await ports.store.getBotPolicy(botId)).revision !== policy.revision) throw denied();
    }
    signal.throwIfAborted();
  };
}
