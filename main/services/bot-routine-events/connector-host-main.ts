import { isDeepStrictEqual } from "node:util";
import { imcpMailToolSchemaEligible } from "./connector-bindings.js";
import { app } from "../../platform.js";
import { configStore } from "../config-store.js";
import { botStore } from "../bot-store.js";
import { botApplicationService } from "../bot-application-service-main.js";
import { isBotPaused } from "../bot-pause-main.js";
import { assertMcpPresetServer, getMcpPreset } from "../mcp-presets.js";
import { mcpMacAppStatus } from "../mcp-mac-apps.js";
import { mcpServerOffersTools } from "../../../renderer/shared/mcp-exposure.js";
import { mcpManager, withBotConnectorMcpClient } from "../mcp.js";
import { admitWithBotConnectorInventoryScope } from "../bot-connector-inventory-scope.js";
import { botMcpLiveToolGrantFacts, botMcpLiveToolMatchesGrant } from "../bot-tool-authority.js";
import { botCapabilityStore, resolveBotRuntimeMcpConnectionIdentities } from "../bot-capability-services-main.js";
import { BotConnectorWatchError, createBotConnectorWatchService, type BotConnectorWatchServicePorts } from "./connector-service.js";
import { connectorWatchJson, type ImcpWatchPort, type ImcpWatchTool } from "./connector-watch-imcp.js";
import type { BotConnectorWatchBinding } from "./connector-types.js";
import type { BotRuntimeAuthorityAdmission, BotRuntimeConnectionAuthority } from "../bot-runtime-authority.js";
import type { SubagentMcpRemoteTool } from "../subagents/subagent-mcp-read.js";
import type { McpServer } from "../types.js";
import { boundedConnectorText } from "./connector-text.js";
import { isComposioServiceServer } from "../composio-service-tool.js";
import { createComposioSourceInspection } from "./composio-source-inspection.js";
import { createComposioInspectionAccess } from "./composio-inspection-access.js";
import { saveComposioWatchInspection } from "./composio-inspection-file.js";

const REQUIRED = ["mail_mailboxes_list", "mail_messages_search"] as const;
const unavailable = (message: string): never => { throw new BotConnectorWatchError("unavailable", message); };
async function trustedServer(serverId: string): Promise<McpServer> {
  const server = (await configStore.listMcpServers()).find((candidate) => candidate.id === serverId);
  if (!server || !server.enabled || !mcpServerOffersTools(server) || server.presetId !== "imcp" || server.authProvider) return unavailable("This connector changed or is off. Review it in Settings → Connectors.");
  try { assertMcpPresetServer(server); } catch { return unavailable("This connector launch configuration changed. Restore the trusted iMCP preset in Settings → Connectors."); }
  const preset = getMcpPreset("imcp");
  if (!preset || preset.transport !== "stdio") return unavailable("This Mail connector is not supported.");
  const status = await mcpMacAppStatus(preset);
  if (!status.installed || !status.open || status.command !== server.command) return unavailable("Open the trusted iMCP app and finish existing Mail access in Settings → Connectors, then try again.");
  if (!mcpManager.hasExistingConnector(server.id)) return unavailable("Connect iMCP in Settings → Connectors first. Watches never open a new approval session.");
  return server;
}
async function admit(botId: string, serverId: string): Promise<BotRuntimeAuthorityAdmission> {
  if (!await botApplicationService.getCanonicalChat(botId)) return unavailable("Open this Bot once to finish its setup before creating a watch.");
  const admission = await admitWithBotConnectorInventoryScope(serverId, async () => (await import("../bot-runtime/bot-session-main.js")).admitBotConnectorWork(botId));
  if (!admission.authority.otherCapabilities.some((capability) => capability.kind === "schedules")) {
    admission.release(); throw new BotConnectorWatchError("capability_denied", "Enable Schedules in this Bot's access before setting up a watch.");
  }
  return admission;
}
async function connection(admission: BotRuntimeAuthorityAdmission, serverId: string): Promise<BotRuntimeConnectionAuthority> {
  const grant = admission.authority.connections.find((item) => item.sourceId === serverId);
  const identity = (await resolveBotRuntimeMcpConnectionIdentities(admission.signal)).find((item) => item.serverId === serverId);
  if (!grant || identity?.connectionFingerprint !== grant.connectionFingerprint) throw new BotConnectorWatchError("capability_denied", "Add this exact connector to the Bot's access before creating a watch.");
  return grant;
}
function inspectTools(grant: BotRuntimeConnectionAuthority, tools: readonly SubagentMcpRemoteTool[], expected?: BotConnectorWatchBinding) {
  return REQUIRED.map((name) => {
    const matches = tools.filter((item) => item.name === name);
    const live = matches.length === 1 ? matches[0] : undefined;
    const allowed = grant.tools.find((item) => item.name === name);
    if (!live || !imcpMailToolSchemaEligible(live) || !allowed || allowed.effect !== "read" || !botMcpLiveToolMatchesGrant(allowed, live)) return unavailable("This iMCP version does not provide the verified read-only Mail tools. Review its setup in Settings → Connectors.");
    const exact = botMcpLiveToolGrantFacts(live)!;
    if (expected && !expected.tools.some((item) => isDeepStrictEqual(item, exact))) return unavailable("This connector's read tools changed. Choose its source again.");
    return exact;
  });
}
async function withPort<T>(botId: string, binding: BotConnectorWatchBinding, signal: AbortSignal, action: (port: ImcpWatchPort) => Promise<T>): Promise<T> {
  const assertActive = async () => { signal.throwIfAborted(); if (await isBotPaused(botId)) return unavailable("This Bot is paused. Resume it before checking."); signal.throwIfAborted(); };
  await assertActive();
  const server = await trustedServer(binding.serverId);
  const admission = await admit(botId, binding.serverId);
  const combined = AbortSignal.any([signal, admission.signal, AbortSignal.timeout(15_000)]);
  try {
    const grant = await connection(admission, server.id);
    if (!isDeepStrictEqual(grant, binding.connection)) return unavailable("This connector's account or access changed. Choose its source again.");
    return await withBotConnectorMcpClient(server, combined, async (raw) => {
      let eligible: ImcpWatchTool | undefined;
      return action({
        async assertEligible(tool, callSignal) {
          await assertActive(); callSignal.throwIfAborted(); await trustedServer(binding.serverId);
          const tools = await raw.list(); inspectTools(grant, tools, binding);
          await admission.revalidateBeforeEffect(); await assertActive(); combined.throwIfAborted(); callSignal.throwIfAborted();
          if (!REQUIRED.includes(tool as typeof REQUIRED[number])) return unavailable("This connector watch requested an unsupported operation.");
          eligible = tool;
        },
        async call(tool, args, callSignal) {
          if (eligible !== tool) return unavailable("The connector read was not authorized.");
          eligible = undefined; await assertActive(); callSignal.throwIfAborted(); combined.throwIfAborted();
          return raw.call(tool, args);
        },
      });
    });
  } finally { admission.release(); }
}

/** Explicit Find sources only: catalog metadata under the person's one service allowance. */
const inspectComposioSource = createComposioSourceInspection({
  hasExistingConnector: (serverId) => mcpManager.hasExistingConnector(serverId),
  preflight: createComposioInspectionAccess({ store: botCapabilityStore,
    currentServer: async (serverId) => (await configStore.listMcpServers()).find((configured) => configured.id === serverId),
    schedulesEnabled: async () => (await configStore.getSettings()).scheduledTasksEnabled !== false,
    connectionFingerprint: async (serverId, signal) => (await resolveBotRuntimeMcpConnectionIdentities(signal)).find((identity) => identity.serverId === serverId)?.connectionFingerprint,
  }),
  admit, connection, withClient: withBotConnectorMcpClient,
  publish: (botId, result, current) => botApplicationService.withBotMutation(botId, () => saveComposioWatchInspection(app.getPath("userData"), botId, result, current)),
});

export function productionConnectorWatchService(ports: Pick<BotConnectorWatchServicePorts, "store" | "dispatcher" | "changed" | "isPaused">) {
  return createBotConnectorWatchService({ ...ports, supported: () => process.platform === "darwin" && app.isReady(),
    knownBot: async (botId) => (await botStore.get(botId)) !== null,
    now: Date.now, withPort,
    retainSource: (binding) => mcpManager.retainExistingConnector(binding.serverId),
    withBotMutation: (botId, operation) => botApplicationService.withBotMutation(botId, operation),
    authorize: async (botId, binding) => {
      // No data read: prove the exact installed trusted tool schemas again at delivery/run time.
      await withPort(botId, binding, new AbortController().signal, (port) => port.assertEligible("mail_messages_search", new AbortController().signal));
      const admission = await admit(botId, binding.serverId);
      const grant = await connection(admission, binding.serverId);
      if (!isDeepStrictEqual(grant, binding.connection)) { admission.release(); return unavailable("This connector's access changed."); }
      return { signal: admission.signal, release: () => admission.release() };
    },
    discover: async (botId, signal, assertActive) => {
      await assertActive();
      const configuredServers = await configStore.listMcpServers();
      const servers = configuredServers.filter((server) => server.presetId === "imcp" && server.enabled && mcpServerOffersTools(server));
      const composioServers = configuredServers.filter((server) => server.enabled && mcpServerOffersTools(server) && isComposioServiceServer(server));
      const bindings: BotConnectorWatchBinding[] = []; const unavailableReasons: string[] = [];
      for (const configured of servers) {
        await assertActive();
        let admission: BotRuntimeAuthorityAdmission | undefined;
        try {
          const server = await trustedServer(configured.id); admission = await admit(botId, server.id); const grant = await connection(admission, server.id);
          await withBotConnectorMcpClient(server, AbortSignal.any([signal, admission.signal, AbortSignal.timeout(15_000)]), async (raw) => {
            await assertActive();
            const tools = inspectTools(grant, await raw.list()); await admission!.revalidateBeforeEffect(); await assertActive();
            const result = connectorWatchJson(await raw.call("mail_mailboxes_list", {})) as { itemListElement?: unknown };
            await assertActive();
            if (!result || !Array.isArray(result.itemListElement) || result.itemListElement.length > 500) return unavailable("The Mail mailbox list was incomplete.");
            for (const item of result.itemListElement as Array<{ "@id"?: unknown; name?: unknown; account?: { "@id"?: unknown; email?: unknown } }>) {
              if (!item || typeof item["@id"] !== "string" || item["@id"].length > 200 || !item.account || typeof item.account["@id"] !== "string" || item.account["@id"].length > 500) continue;
              bindings.push({ adapter: "imcp-mail-v1", serverId: server.id, connection: structuredClone(grant), tools, mailbox: item["@id"], account: item.account["@id"], labels: {
                providerLabel: "iMCP Mail", accountLabel: typeof item.account.email === "string" ? boundedConnectorText(item.account.email, 500) : "Selected Mail account", resourceLabel: typeof item.name === "string" && item.name ? boundedConnectorText(item.name, 500) : "Mail mailbox" } });
            }
          });
        } catch (error) { unavailableReasons.push(error instanceof BotConnectorWatchError ? error.message : "Mail sources are unavailable. Finish existing access in Settings → Connectors."); }
        finally { admission?.release(); }
        await assertActive();
      }
      for (const server of composioServers) {
        await assertActive();
        try { unavailableReasons.push(await inspectComposioSource(botId, server, signal, assertActive)); }
        catch (error) {
          if (signal.aborted) throw error;
          unavailableReasons.push(error instanceof BotConnectorWatchError ? error.message : "Composio sources are unavailable. Review its existing setup in Settings → Connectors.");
        }
      }
      if (!servers.length && !composioServers.length) unavailableReasons.push("Connect and allow an app in Settings → Connectors first.");
      unavailableReasons.push("Calendar watches are unavailable until a trusted connector supports exact account and occurrence identity.");
      return { bindings, unavailableReasons };
    },
  });
}
