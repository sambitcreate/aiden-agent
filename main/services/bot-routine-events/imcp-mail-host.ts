/** Existing approved iMCP Mail reads, independent of any inference/default model. */
import { isDeepStrictEqual } from "node:util";
import { withBotConnectorCachedInventoryScope, withBotConnectorForegroundLifetime, withBotConnectorInventoryScope, withBotConnectorMetadataRenewal } from "../bot-connector-inventory-scope.js";
import { botMcpLiveToolGrantFacts, botMcpLiveToolMatchesGrant } from "../bot-tool-authority.js";
import type { BotRuntimeConnectionAuthority } from "../bot-runtime-authority.js";
import type { BotConnectorMcpClientPort } from "../mcp.js";
import type { McpServer } from "../types.js";
import type { SubagentMcpRemoteTool } from "../subagents/subagent-mcp-read.js";
import { imcpMailToolSchemaEligible } from "./connector-bindings.js";
import { BotConnectorWatchError } from "./connector-service.js";
import type { BotConnectorSourceAdmission } from "./connector-source-admission.js";
import type { ImcpMailWatchBinding } from "./connector-types.js";
import { boundedConnectorText } from "./connector-text.js";
import { connectorWatchJson, type ImcpWatchPort, type ImcpWatchTool } from "./connector-watch-imcp.js";

const REQUIRED=["mail_mailboxes_list","mail_messages_search"] as const;
const fail=(message:string):never=>{throw new BotConnectorWatchError("unavailable",message);};
export function inspectImcpMailSourceTools(grant:BotRuntimeConnectionAuthority,tools:readonly SubagentMcpRemoteTool[],expected?:ImcpMailWatchBinding){
  return REQUIRED.map(name=>{
    const matches=tools.filter(tool=>tool.name===name),live=matches.length===1?matches[0]:undefined,allowed=grant.tools.find(tool=>tool.name===name);
    if(!live||!imcpMailToolSchemaEligible(live)||!allowed||allowed.effect!=="read"||!botMcpLiveToolMatchesGrant(allowed,live))return fail("This iMCP version does not provide the verified read-only Mail tools. Review its setup in Settings → Connectors.");
    const exact=botMcpLiveToolGrantFacts(live)!;
    if(expected&&!expected.tools.some(tool=>isDeepStrictEqual(tool,exact)))return fail("This connector's read tools changed. Choose its source again.");
    return exact;
  });
}
export function createImcpMailHost(ports:{
  server(serverId:string):Promise<McpServer>;
  admit(botId:string,serverId:string):Promise<BotConnectorSourceAdmission>;
  assertConnection(held:BotConnectorSourceAdmission,server:McpServer,raw:BotConnectorMcpClientPort,foreground:boolean):Promise<void>;
  connection(held:BotConnectorSourceAdmission,server:McpServer,raw:BotConnectorMcpClientPort,metadata:readonly SubagentMcpRemoteTool[],foreground:boolean):Promise<BotRuntimeConnectionAuthority>;
  withClient<T>(server:McpServer,signal:AbortSignal,action:(raw:BotConnectorMcpClientPort)=>Promise<T>):Promise<T>;
  isPaused(botId:string):Promise<boolean>;
}){
  async function operation<T>(botId:string,serverId:string,binding:ImcpMailWatchBinding|undefined,signal:AbortSignal,action:(port:ImcpWatchPort,grant:BotRuntimeConnectionAuthority)=>Promise<T>,foreground?:()=>Promise<void>,existing?:BotConnectorSourceAdmission,capture?:(current:()=>void)=>void):Promise<T>{
    const whole=AbortSignal.any([signal,AbortSignal.timeout(15_000)]);let held:BotConnectorSourceAdmission|undefined,released=false;
    const release=()=>{if(held&&!existing&&!released){released=true;held.release();}};
    const active=async()=>{whole.throwIfAborted();if(await ports.isPaused(botId))return fail("This Bot is paused.");await foreground?.();whole.throwIfAborted();};
    const run=async()=>{
      await active();const server=await ports.server(serverId);await active();held=existing??await ports.admit(botId,serverId);
      try{
        const admitted=held,combined=AbortSignal.any([whole,admitted.signal]);
        const current=async()=>{combined.throwIfAborted();await active();await ports.server(serverId);await admitted.revalidateBeforeEffect();await active();combined.throwIfAborted();};
        await current();
        // A Custom/Chat source ceiling without either verified read refuses
        // before even its selected metadata request.
        if(admitted.selectedConnection&&REQUIRED.some(name=>!admitted.selectedConnection!.tools.some(tool=>tool.name===name&&tool.effect==="read")))return fail("Allow the verified Mail read tools and Schedules in this Bot's current Access settings.");
        return await ports.withClient(server,combined,async raw=>{
          let eligible:ImcpWatchTool|undefined;let grant:BotRuntimeConnectionAuthority|undefined;
          const inspect=async()=>{
            await current();await ports.assertConnection(admitted,server,raw,!!foreground);await current();const tools=await withBotConnectorMetadataRenewal({serverId,signal:combined,assertCurrent:current},()=>raw.list());await current();
            const connection=await ports.connection(admitted,server,raw,tools,!!foreground);await current();
            if(binding&&!isDeepStrictEqual(connection,binding.connection))return fail("This Mail connector's account or access changed. Choose its source again.");
            inspectImcpMailSourceTools(connection,tools,binding);grant=connection;
          };
          await inspect();capture?.(()=>{combined.throwIfAborted();admitted.assertCurrent?.();raw.assertCurrent?.();});
          const port:ImcpWatchPort={assertEligible:async(tool,callSignal)=>{await current();callSignal.throwIfAborted();if(!REQUIRED.includes(tool as typeof REQUIRED[number]))return fail("This Mail watch requested an unsupported operation.");await inspect();callSignal.throwIfAborted();eligible=tool;},
            call:async(tool,args,callSignal)=>{if(eligible!==tool)return fail("This Mail read has no current one-operation admission.");eligible=undefined;await current();callSignal.throwIfAborted();const result=await raw.call(tool,args);await current();callSignal.throwIfAborted();return result;}};
          return action(port,grant!);
        });
      }finally{release();}
    };
    const scoped=()=>foreground?withBotConnectorForegroundLifetime({signal:whole,assertCurrent:active},()=>withBotConnectorInventoryScope(serverId,run)):withBotConnectorCachedInventoryScope(serverId,run);
    let onAbort!:()=>void;const cancelled=new Promise<never>((_resolve,reject)=>{onAbort=()=>{release();reject(whole.reason);};whole.addEventListener("abort",onAbort,{once:true});if(whole.aborted)onAbort();});
    try{return await Promise.race([scoped(),cancelled]);}finally{whole.removeEventListener("abort",onAbort);release();}
  }
  return {
    withPort:<T>(botId:string,binding:ImcpMailWatchBinding,signal:AbortSignal,action:(port:ImcpWatchPort)=>Promise<T>)=>operation(botId,binding.serverId,binding,signal,port=>action(port)),
    authorize:async(botId:string,binding:ImcpMailWatchBinding,signal:AbortSignal)=>{
      const held=await ports.admit(botId,binding.serverId);let current:(()=>void)|undefined;
      const validate=async()=>{await operation(botId,binding.serverId,binding,signal,async()=>{},undefined,held,guard=>{current=guard;});held.signal.throwIfAborted();};
      try{await validate();return {...held,assertCurrent:()=>{held.signal.throwIfAborted();held.assertCurrent?.();current?.();},revalidateBeforeEffect:validate};}catch(error){held.release();throw error;}
    },
    discover:(botId:string,serverId:string,signal:AbortSignal,assertActive:()=>Promise<void>)=>operation(botId,serverId,undefined,signal,async(port,grant)=>{
      await port.assertEligible("mail_mailboxes_list",signal);const result=connectorWatchJson(await port.call("mail_mailboxes_list",{},signal)) as {itemListElement?:unknown};
      if(!result||!Array.isArray(result.itemListElement)||result.itemListElement.length>500)return fail("The Mail mailbox list was incomplete.");
      const tools=REQUIRED.map(name=>structuredClone(grant.tools.find(tool=>tool.name===name)!));const bindings:ImcpMailWatchBinding[]=[];
      for(const item of result.itemListElement as Array<{"@id"?:unknown;name?:unknown;account?:{"@id"?:unknown;email?:unknown}}>){
        if(!item||typeof item["@id"]!=="string"||item["@id"].length>200||!item.account||typeof item.account["@id"]!=="string"||item.account["@id"].length>500)continue;
        bindings.push({adapter:"imcp-mail-v1",serverId,connection:structuredClone(grant),tools,mailbox:item["@id"],account:item.account["@id"],labels:{providerLabel:"iMCP Mail",accountLabel:typeof item.account.email==="string"?boundedConnectorText(item.account.email,500):"Selected Mail account",resourceLabel:typeof item.name==="string"&&item.name?boundedConnectorText(item.name,500):"Mail mailbox"}});
      }
      return bindings;
    },assertActive),
  };
}
