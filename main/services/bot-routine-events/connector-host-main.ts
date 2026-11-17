import { botRuntimeInventoryLeases } from "../bot-runtime-inventory-lease.js";
import { mcpConfigurationLeases } from "../mcp-config-lease.js";
import { isDeepStrictEqual } from "node:util";
import { createImcpMailHost } from "./imcp-mail-host.js";
import { app } from "../../platform.js";
import { configStore } from "../config-store.js";
import { botStore } from "../bot-store.js";
import { botApplicationService } from "../bot-application-service-main.js";
import { isBotPaused } from "../bot-pause-main.js";
import { assertMcpPresetServer, getMcpPreset } from "../mcp-presets.js";
import { mcpMacAppStatus } from "../mcp-mac-apps.js";
import { mcpServerOffersTools, mcpToolsOfferedToModel } from "../../../renderer/shared/mcp-exposure.js";
import { mcpManager, withBotConnectorMcpClient } from "../mcp.js";
import { botCapabilityStore, botConnectorSourceSelectionIds, resolveBotRuntimeMcpConnectionIdentities } from "../bot-capability-services-main.js";
import { BotConnectorWatchError, createBotConnectorWatchService, type BotConnectorWatchServicePorts } from "./connector-service.js";
import { BOT_DESKTOP_AUDIENCE_ID } from "../bot-runtime-authority-main.js";
import { createConnectorSourceAdmission, composioSourceConnection, imcpSourceConnection, type BotConnectorSourceAdmission } from "./connector-source-admission.js";
import { createComposioCalendarHost } from "./composio-calendar-host.js";
import { composioCalendarHostTransport } from "./composio-calendar-host-port.js";
import type { BotConnectorWatchBinding, ComposioCalendarWatchBinding } from "./connector-types.js";
import type { BotRuntimeAuthorityAdmission } from "../bot-runtime-authority.js";
import type { McpServer } from "../types.js";
import { isComposioServiceServer } from "../composio-service-tool.js";
import { createComposioSourceInspection } from "./composio-source-inspection.js";
import { createComposioInspectionAccess } from "./composio-inspection-access.js";
import { saveComposioWatchInspection } from "./composio-inspection-file.js";

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

const composioAccess=createComposioInspectionAccess({ store: botCapabilityStore,
    currentServer: async (serverId) => (await configStore.listMcpServers()).find((configured) => configured.id === serverId),
    schedulesEnabled: async () => (await configStore.getSettings()).scheduledTasksEnabled !== false,
    connectionFingerprint: async (serverId, signal) => (await resolveBotRuntimeMcpConnectionIdentities(signal)).find((identity) => identity.serverId === serverId)?.connectionFingerprint,
  });
async function trustedComposioServer(serverId:string):Promise<McpServer>{const server=(await configStore.listMcpServers()).find(row=>row.id===serverId);if(!server||!server.enabled||!mcpServerOffersTools(server)||server.hiddenTools?.length)return unavailable("Review the saved Composio connection in Settings → Connectors.");try{if(!isComposioServiceServer(server))return unavailable("Restore the trusted Composio preset.");}catch{return unavailable("Restore the trusted Composio preset.");}if(!mcpManager.hasExistingConnector(serverId))return unavailable("Connect Composio in the foreground first. Calendar watches never reconnect it.");return server;}
const sourceAdmitCore=createConnectorSourceAdmission({sourceSelectionIds:botConnectorSourceSelectionIds,store:botCapabilityStore,audienceId:BOT_DESKTOP_AUDIENCE_ID,
  canonicalChat:botId=>botApplicationService.getCanonicalChat(botId),schedulesEnabled:async()=>(await configStore.getSettings()).scheduledTasksEnabled!==false});
async function sourceAdmit(botId:string,serverId:string){
  const connector=mcpConfigurationLeases.acquire(serverId), inventory=botRuntimeInventoryLeases.acquire();
  try {
    const held=await sourceAdmitCore(botId,serverId);
    try{connector.assertCurrent();inventory.assertCurrent();}catch(error){held.release();throw error;}
    return {...held,assertCurrent:()=>{held.assertCurrent?.();connector.assertCurrent();inventory.assertCurrent();},signal:AbortSignal.any([held.signal,connector.signal,inventory.signal]),release:()=>{held.release();inventory.release();},revalidateBeforeEffect:async()=>{connector.assertCurrent();inventory.assertCurrent();await held.revalidateBeforeEffect();connector.assertCurrent();inventory.assertCurrent();}};
  }catch(error){inventory.release();throw error;}
}
async function sourceFingerprint(admission:BotConnectorSourceAdmission,serverId:string,raw:import("../mcp.js").BotConnectorMcpClientPort,foreground:boolean):Promise<string>{
  await admission.revalidateBeforeEffect();
  if(foreground&&!raw.connectionFingerprint?.()){
    const identity=(await resolveBotRuntimeMcpConnectionIdentities(admission.signal)).find(item=>item.serverId===serverId);
    if(!identity||!raw.attestConnectionFingerprint)return unavailable("This current connector cannot attest its source identity.");
    await admission.revalidateBeforeEffect();raw.attestConnectionFingerprint(identity.connectionFingerprint);
  }
  const fingerprint=raw.connectionFingerprint?.();
  if(!fingerprint)return unavailable("Find this source in the foreground to verify its current approved connection.");
  if(admission.selectedConnection&&admission.selectedConnection.connectionFingerprint!==fingerprint)throw new BotConnectorWatchError("capability_denied","Allow this exact current connector in the Bot's Access settings.");
  await admission.revalidateBeforeEffect();return fingerprint;
}
const mail=createImcpMailHost({server:trustedServer,admit:sourceAdmit,withClient:withBotConnectorMcpClient,isPaused:isBotPaused,
  assertConnection:async(admission,server,raw,foreground)=>{await sourceFingerprint(admission,server.id,raw,foreground);},
  connection:async(admission,server,raw,metadata,foreground)=>{
    const grant=imcpSourceConnection(server.id,await sourceFingerprint(admission,server.id,raw,foreground),mcpToolsOfferedToModel(server,metadata,tool=>tool.name));
    if(admission.selectedConnection&&!isDeepStrictEqual(admission.selectedConnection,grant))throw new BotConnectorWatchError("capability_denied","This Mail connector's tools or access changed. Choose its source again.");
    await admission.revalidateBeforeEffect();return grant;
  }});
const calendar=createComposioCalendarHost({transport:composioCalendarHostTransport,server:trustedComposioServer,
  preflight:async(_botId,server,signal)=>{signal.throwIfAborted();await trustedComposioServer(server.id);if((await configStore.getSettings()).scheduledTasksEnabled===false)throw new BotConnectorWatchError("capability_denied","Enable Schedules before checking a Calendar source.");signal.throwIfAborted();},
  admit:sourceAdmit,connection:async(admission,serverId,raw,foreground)=>{
    const grant=composioSourceConnection(serverId,await sourceFingerprint(admission,serverId,raw,foreground));
    if(admission.selectedConnection&&!isDeepStrictEqual(admission.selectedConnection,grant))throw new BotConnectorWatchError("capability_denied","Allow this exact current Composio connection in the Bot's Access settings.");
    await admission.revalidateBeforeEffect();return grant;
  },isPaused:isBotPaused,now:Date.now,withClient:(server,signal,_foreground,action)=>withBotConnectorMcpClient(server,signal,action)});

/** Explicit Find sources only: catalog metadata under the person's one service allowance. */
const inspectComposioSource = createComposioSourceInspection({
  hasExistingConnector: (serverId) => mcpManager.hasExistingConnector(serverId),
  preflight: composioAccess,
  admit:sourceAdmit, connection:async(held,serverId,raw)=>{
    const grant=composioSourceConnection(serverId,await sourceFingerprint(held,serverId,raw,true));
    if(held.selectedConnection&&!isDeepStrictEqual(held.selectedConnection,grant))throw new BotConnectorWatchError("capability_denied","Allow Composio once in this Bot's current Access settings.");
    return grant;
  }, withClient: withBotConnectorMcpClient,
  publish: (botId, result, current) => botApplicationService.withBotMutation(botId, () => saveComposioWatchInspection(app.getPath("userData"), botId, result, current)),
});

export function productionConnectorWatchService(ports: Pick<BotConnectorWatchServicePorts, "store" | "dispatcher" | "changed" | "isPaused">) {
  return createBotConnectorWatchService({ ...ports, supported: () => ["darwin","linux"].includes(process.platform) && app.isReady(),
    mailAvailable:()=>process.platform==="darwin",calendarAvailable:calendar.available,withCalendarPort:calendar.withPort,
    knownBot: async (botId) => (await botStore.get(botId)) !== null,
    now: Date.now, withPort:mail.withPort,
    retainSource: (binding) => mcpManager.retainExistingConnector(binding.serverId),
    withBotMutation: (botId, operation) => botApplicationService.withBotMutation(botId, operation),
    authorize: async (botId, binding, signal=new AbortController().signal) => {
      if(binding.adapter==="composio-calendar-v1")return calendar.authorize(botId,binding,signal);
      return mail.authorize(botId,binding,signal);
    },
    discover: async (botId, signal, assertActive) => {
      await assertActive();
      const configuredServers = await configStore.listMcpServers();
      const servers = configuredServers.filter((server) => process.platform==="darwin" && server.presetId === "imcp" && server.enabled && mcpServerOffersTools(server));
      const composioServers = configuredServers.filter((server) => server.enabled && mcpServerOffersTools(server) && isComposioServiceServer(server));
      const bindings: BotConnectorWatchBinding[] = []; const unavailableReasons: string[] = [];
      for (const configured of servers) {
        await assertActive();
        try{bindings.push(...await mail.discover(botId,configured.id,signal,assertActive));}
        catch(error){if(signal.aborted)throw error;unavailableReasons.push(error instanceof BotConnectorWatchError?error.message:"Mail sources are unavailable. Finish existing access in Settings → Connectors.");}
        await assertActive();
      }
      for (const server of composioServers) {
        await assertActive();
        try { if(calendar.available())bindings.push(...await calendar.discover(botId,server.id,signal,assertActive));else unavailableReasons.push(await inspectComposioSource(botId, server, signal, assertActive)); }
        catch (error) {
          if (signal.aborted) throw error;
          unavailableReasons.push(error instanceof BotConnectorWatchError ? error.message : "Composio sources are unavailable. Review its existing setup in Settings → Connectors.");
        }
      }
      if (!servers.length && !composioServers.length) unavailableReasons.push("Connect and allow an app in Settings → Connectors first.");
      if(!calendar.available())unavailableReasons.push("Calendar watches await verified Composio account routing, schemas and read-response acceptance.");
      return { bindings, unavailableReasons };
    },
  });
}

/** Revalidate a queued task's exact source with its already accepted model grant. */
export function validateCalendarConnectorExecution(botId:string,binding:ComposioCalendarWatchBinding,admission?:BotRuntimeAuthorityAdmission,signal:AbortSignal=admission?.signal??new AbortController().signal):Promise<void>{return calendar.validate(botId,binding,signal,admission);}
