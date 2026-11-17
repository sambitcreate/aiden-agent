/** Model-free, host-only authority for a cheap connected-app source read. */
import { isDeepStrictEqual } from "node:util";
import type { BotCapabilityStore } from "../bot-capability-store.js";
import type { BotRuntimeConnectionAuthority } from "../bot-runtime-authority.js";
import { botCapabilityFactsFingerprint } from "../bot-capability-catalog-core.js";
import { COMPOSIO_SERVICE_ACCESS_IDENTITY } from "../bot-connection-capability-identity.js";
import { botMcpLiveToolGrantFacts } from "../bot-tool-authority.js";
import { COMPOSIO_SERVICE_SERVER_ID } from "../../../renderer/shared/composio-service.js";
import type { SubagentMcpRemoteTool } from "../subagents/subagent-mcp-read.js";
import { composioServiceToolDescriptor } from "../composio-service-tool.js";

export interface BotConnectorSourceAdmission {
  readonly selectedConnection?: BotRuntimeConnectionAuthority;
  readonly signal: AbortSignal;
  assertCurrent?():void;
  revalidateBeforeEffect(): Promise<void>;
  release(): void;
}

export function composioSourceConnection(serverId: string, connectionFingerprint: string): BotRuntimeConnectionAuthority {
  if (serverId !== COMPOSIO_SERVICE_SERVER_ID || !/^[a-f0-9]{64}$/u.test(connectionFingerprint)) throw new Error("This live connector has no current host attestation.");
  const tool = botMcpLiveToolGrantFacts(composioServiceToolDescriptor())!;
  const tools = [tool];
  const toolsetFingerprint = botCapabilityFactsFingerprint(tools.map(({ name, exactFingerprint }) => ({ name, exactFingerprint })));
  return { sourceId: serverId, connectionFingerprint, toolsetFingerprint,
    exactFingerprint: botCapabilityFactsFingerprint({ connectionFingerprint, toolsetFingerprint, accessIdentity: COMPOSIO_SERVICE_ACCESS_IDENTITY }), tools };
}

export function createConnectorSourceAdmission(ports: {
  store: Pick<BotCapabilityStore, "admitConnectorSource">;
  audienceId: string;
  canonicalChat(botId: string): Promise<{ id: string } | null>;
  schedulesEnabled(): Promise<boolean>;
  sourceSelectionIds?(serverId: string): Promise<{ connectionId: string; schedulesId: string }>;
}) {
  return async (botId: string, serverId: string): Promise<BotConnectorSourceAdmission> => {
    const chat = await ports.canonicalChat(botId);
    if (!chat || !await ports.schedulesEnabled()) throw new Error("Open this Bot and enable Schedules before checking a source.");
    const sourceSelectionIds = await ports.sourceSelectionIds?.(serverId);
    const input = { ...(sourceSelectionIds ? { sourceSelectionIds } : {}), audienceId: ports.audienceId, botId, chatId: chat.id, serverId };
    const admitted = await ports.store.admitConnectorSource(input);
    const bound = admitted.connection;
    const selectedConnection: BotRuntimeConnectionAuthority | undefined = bound ? {
      sourceId: bound.sourceId, connectionFingerprint: bound.connectionFingerprint, toolsetFingerprint: bound.toolsetFingerprint,
      exactFingerprint: bound.exactFingerprint, tools: bound.tools.map(({ name, effect, inputSchemaFingerprint, outputSchemaFingerprint, effectFingerprint, exactFingerprint }) => ({ toolId: exactFingerprint, name, effect, inputSchemaFingerprint, outputSchemaFingerprint, effectFingerprint, exactFingerprint })),
    } : undefined;
    const revalidateBeforeEffect = async () => {
      admitted.lease.assertCurrent();
      if ((await ports.canonicalChat(botId))?.id !== chat.id || !await ports.schedulesEnabled()) throw new Error("This Bot's source authority changed.");
      const current = await ports.store.admitConnectorSource(input);
      try {
        if (!isDeepStrictEqual(current.connection, bound) || current.policy.policyEpoch !== admitted.policy.policyEpoch || current.chat?.policyEpoch !== admitted.chat?.policyEpoch) throw new Error("This Bot's source authority changed.");
        current.lease.assertCurrent(); admitted.lease.assertCurrent();
      } finally { current.lease.release(); }
    };
    try { await revalidateBeforeEffect(); } catch (error) { admitted.lease.release(); throw error; }
    return { ...(selectedConnection ? { selectedConnection } : {}), signal: admitted.lease.signal, assertCurrent:()=>admitted.lease.assertCurrent(), revalidateBeforeEffect, release: () => admitted.lease.release() };
  };
}

/** Current iMCP inventory only; no model/provider catalog is consulted. */
export function imcpSourceConnection(serverId:string,connectionFingerprint:string,metadata:readonly SubagentMcpRemoteTool[]):BotRuntimeConnectionAuthority {
  if(!serverId||!/^[a-f0-9]{64}$/u.test(connectionFingerprint)||metadata.length>256)throw new Error("This Mail client has no current exact source identity.");
  const tools=metadata.map(tool=>{const facts=botMcpLiveToolGrantFacts(tool);if(!facts)throw new Error("This Mail tool has no verified authority facts.");return facts;}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  if(!tools.length||new Set(tools.map(tool=>tool.name)).size!==tools.length)throw new Error("This Mail inventory is incomplete.");
  const toolsetFingerprint=botCapabilityFactsFingerprint(tools.map(({name,exactFingerprint})=>({name,exactFingerprint})));
  return {sourceId:serverId,connectionFingerprint,toolsetFingerprint,exactFingerprint:botCapabilityFactsFingerprint({connectionFingerprint,toolsetFingerprint}),tools};
}
