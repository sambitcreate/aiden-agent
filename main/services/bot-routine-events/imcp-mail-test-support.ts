/** Synthetic iMCP + real protected source ceilings; never an app/process transport. */
import { createBotCapabilityStore } from "../bot-capability-store.js";
import { createBotCapabilityOpaqueIdMint } from "../bot-capability-bindings.js";
import { buildBotCapabilityCatalogSnapshot } from "../bot-capability-catalog-core.js";
import { BOT_FULL_ACCESS_NOTICE_VERSION } from "../../../renderer/shared/bot-capabilities.js";
import { createConnectorSourceAdmission, imcpSourceConnection } from "./connector-source-admission.js";
import { createImcpMailHost } from "./imcp-mail-host.js";
import { botConnectorInventoryCacheOnly, botConnectorInventoryServer } from "../bot-connector-inventory-scope.js";
import type { SubagentMcpRemoteTool } from "../subagents/subagent-mcp-read.js";
import type { McpServer } from "../types.js";
import { isDeepStrictEqual } from "node:util";

export function syntheticMailMetadata():SubagentMcpRemoteTool[]{return [
  {name:"mail_mailboxes_list",annotations:{readOnlyHint:true,openWorldHint:false},inputSchema:{type:"object",additionalProperties:false,properties:{}}},
  {name:"mail_messages_search",annotations:{readOnlyHint:true,openWorldHint:false},inputSchema:{type:"object",additionalProperties:false,properties:{sender:{type:"string"},subject:{type:"string"},mailbox:{type:"string"},start:{type:"string"},end:{type:"string"},isRead:{type:"boolean"},limit:{type:"integer",minimum:1,maximum:100},cursor:{type:"string"}}}},
];}
export async function createModelFreeMailFixture(root:string){
  const botId="bot:one",serverId="preset-imcp",fingerprint="a".repeat(64);let metadata=syntheticMailMetadata(),messages=["initial"],live=true,lists=0,reads=0;
  const grant=imcpSourceConnection(serverId,fingerprint,metadata);
  const snapshot=buildBotCapabilityCatalogSnapshot({inventory:{providers:[{sourceId:"unavailable-default",label:"Default",available:false,connectionFingerprint:"b".repeat(64),models:[{sourceId:"missing",label:"Missing",available:false,modelFingerprint:"c".repeat(64)}]}],fileScopes:[{sourceId:"full",label:"Full",kind:"full_mac",available:true,scopeFingerprint:"d".repeat(64)},{sourceId:"home",label:"Home",kind:"bot_home",available:true,scopeFingerprint:"e".repeat(64)}],shell:{available:false,shellFingerprint:"f".repeat(64)},connections:[{sourceId:serverId,label:"Mail",available:true,connectionFingerprint:fingerprint,tools:grant.tools.map(({name,inputSchemaFingerprint,outputSchemaFingerprint,effect,effectFingerprint})=>({name,inputSchemaFingerprint,outputSchemaFingerprint,effect,effectFingerprint}))}],skills:[],otherCapabilities:[{kind:"schedules",label:"Schedules",available:true,capabilityFingerprint:"1".repeat(64)}]},notice:{version:BOT_FULL_ACCESS_NOTICE_VERSION,requiresAcknowledgement:true},mintOpaqueId:createBotCapabilityOpaqueIdMint(Buffer.alloc(32,7))});
  const store=createBotCapabilityStore({root:()=>root});await store.initialize();await store.acknowledgeNotice("desktop",{version:BOT_FULL_ACCESS_NOTICE_VERSION,decision:"continue_full",confirmedForeground:true});
  const policy=await store.createBotPolicy({botId,catalog:snapshot.catalog,access:{accessMode:"full",catalogRevision:snapshot.catalog.revision,confirmedForeground:true}});
  await store.createChatPolicy({botId,chatId:"chat:one",expectedBotPolicyRevision:policy.revision,catalog:snapshot.catalog});
  const admit=createConnectorSourceAdmission({store,audienceId:"desktop",canonicalChat:async()=>({id:"chat:one"}),schedulesEnabled:async()=>true});
  const current=()=>{if(!live)throw new Error("approved iMCP session ended");};
  const host=createImcpMailHost({admit,isPaused:async()=>false,server:async()=>{current();return {id:serverId,presetId:"imcp",transport:"stdio",enabled:true}as McpServer;},
    assertConnection:async(held)=>{current();await held.revalidateBeforeEffect();if(held.selectedConnection?.connectionFingerprint&&held.selectedConnection.connectionFingerprint!==fingerprint)throw new Error("Mail source connection changed");},
    connection:async(held,_server,_raw,tools)=>{const connection=imcpSourceConnection(serverId,fingerprint,tools);if(held.selectedConnection&&!isDeepStrictEqual(held.selectedConnection,connection))throw new Error("Mail source grant changed");return connection;},
    withClient:async(_server,signal,action)=>{current();signal.throwIfAborted();return action({list:async()=>{current();signal.throwIfAborted();if(botConnectorInventoryServer()!==serverId||botConnectorInventoryCacheOnly())throw new Error("Mail metadata escaped its selected source renewal");lists++;return metadata;},call:async(name,args)=>{current();signal.throwIfAborted();reads++;if(name==="mail_mailboxes_list")return {"@context":"https://schema.org","@type":"ItemList",itemListElement:[{"@id":"mailbox-one",name:"Inbox",account:{"@id":"account-one",email:"owner@example.test"}}]};if(name!=="mail_messages_search"||args.mailbox!=="mailbox-one")throw new Error("Mail read escaped the accepted mailbox");return {"@context":"https://schema.org","@type":"ItemList",itemListElement:messages.map(id=>({"@id":id,mailbox:"mailbox-one",subject:`Project ${id}`,sender:{email:"sender@example.test"},dateReceived:"2026-11-03T14:00:00Z",isRead:false})),nextCursor:null,localIndex:{indexedMessageCount:messages.length,syncStatus:"unknown"}};}});},
  });
  return {host,store,grant,botId,serverId,setMessages:(ids:string[])=>{messages=ids;},close:()=>{live=false;},mutateSchema:()=>{metadata=metadata.map(tool=>tool.name==="mail_messages_search"?{...tool,annotations:{readOnlyHint:false,openWorldHint:false}}:tool);},counts:()=>({lists,reads})};
}
