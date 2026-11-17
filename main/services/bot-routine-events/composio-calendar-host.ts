/** Existing-live-client host boundary. No transport is installed by this module. */
import { copyBoundedJson,utf8Size } from "../bounded-json.js";
import { isDeepStrictEqual } from "node:util";
import { withBotConnectorCachedInventoryScope, withBotConnectorForegroundLifetime, withBotConnectorInventoryScope, withBotConnectorMetadataRenewal } from "../bot-connector-inventory-scope.js";
import { composioServiceToolDescriptor, COMPOSIO_SERVICE_TOOL_NAME } from "../composio-service-tool.js";
import { botMcpLiveToolMatchesGrant } from "../bot-tool-authority.js";
import type { BotRuntimeAuthorityAdmission, BotRuntimeConnectionAuthority } from "../bot-runtime-authority.js";
import type { BotConnectorMcpClientPort } from "../mcp.js";
import type { McpServer } from "../types.js";
import { BotConnectorWatchError } from "./connector-service.js";
import { validComposioCalendarContract, type ComposioCalendarWatchBinding } from "./connector-types.js";
import { buildComposioCalendarExecutorRequest, discoverComposioCalendarSources, type ComposioCalendarRead, type ComposioCalendarReadPort } from "./connector-watch-composio.js";
import type { ComposioCalendarHostTransport, ComposioCalendarTransportContext } from "./composio-calendar-host-port.js";

import { buildCalendarSchemasRequest, buildCalendarSearchRequest, verifyCalendarContract } from "./composio-calendar-contract.js";
import type { BotConnectorSourceAdmission } from "./connector-source-admission.js";
const fail=(message:string):never=>{throw new BotConnectorWatchError("unavailable",message);};
export function createComposioCalendarHost(ports:{
  transport():ComposioCalendarHostTransport|undefined;
  server(serverId:string):Promise<McpServer>;
  preflight(botId:string,server:McpServer,signal:AbortSignal):Promise<void>;
  admit(botId:string,serverId:string):Promise<BotConnectorSourceAdmission>;
  connection(admission:BotConnectorSourceAdmission,serverId:string,raw:BotConnectorMcpClientPort,foreground:boolean):Promise<BotRuntimeConnectionAuthority>;
  withClient<T>(server:McpServer,signal:AbortSignal,foreground:boolean,action:(raw:BotConnectorMcpClientPort)=>Promise<T>):Promise<T>;
  isPaused(botId:string):Promise<boolean>;
  now():number;
}){
  async function operation<T>(botId:string,serverId:string,binding:ComposioCalendarWatchBinding|undefined,signal:AbortSignal,action:(port:ComposioCalendarReadPort,context:ComposioCalendarTransportContext,grant:BotRuntimeConnectionAuthority,contract:ComposioCalendarWatchBinding["contract"])=>Promise<T>,foreground?:()=>Promise<void>,existing?:BotRuntimeAuthorityAdmission|BotConnectorSourceAdmission,capture?:(current:()=>void)=>void):Promise<T>{
    const transport=ports.transport();if(!transport)return fail("Calendar watches await the verified exact-account Composio read transport.");
    const deadline=AbortSignal.timeout(15_000),operationSignal=AbortSignal.any([signal,deadline]);let admission:BotConnectorSourceAdmission|undefined,released=false;const release=()=>{if(admission&&!released){released=true;admission.release();}};
    const active=async()=>{operationSignal.throwIfAborted();if(await ports.isPaused(botId))return fail("This Bot is paused.");await foreground?.();operationSignal.throwIfAborted();};
    const run=async()=>{
      await active();const server=await ports.server(serverId);await active();await ports.preflight(botId,server,operationSignal);await active();
      const held:BotConnectorSourceAdmission=existing?("authority" in existing?{selectedConnection:existing.authority.connections.find(row=>row.sourceId===serverId),signal:existing.signal,revalidateBeforeEffect:()=>existing.revalidateBeforeEffect(),release:()=>{}}:existing):await ports.admit(botId,serverId);
      if(existing&&"authority"in existing&&!held.selectedConnection)return fail("This task has no current allowance for its accepted Calendar connection.");if(!existing)admission=held;const combined=AbortSignal.any([operationSignal,held.signal]);
      try{
        const current=async()=>{combined.throwIfAborted();await active();await ports.server(serverId);await ports.preflight(botId,server,combined);await held.revalidateBeforeEffect();await active();combined.throwIfAborted();};
        await current();return await ports.withClient(server,combined,!!foreground,async raw=>{
          await current();const grant=await ports.connection(held,serverId,raw,!!foreground),service=grant.tools.find(tool=>tool.name===COMPOSIO_SERVICE_TOOL_NAME);
          if(!service||!botMcpLiveToolMatchesGrant(service,composioServiceToolDescriptor())||binding&&!isDeepStrictEqual(grant,binding.connection))return fail("This Calendar source's Composio allowance changed. Choose its source again.");
          const metadata=structuredClone(await withBotConnectorMetadataRenewal({serverId,signal:combined,assertCurrent:current},()=>raw.list()));await current();let activeRead:ComposioCalendarRead|undefined,consumed=false,accounts:Promise<unknown>|undefined,totalBytes=0;let verified:ReturnType<typeof verifyCalendarContract>|undefined;
          const call=async(name:string,args:Record<string,unknown>)=>{await current();const result=await raw.call(name,args);await current();const safe=copyBoundedJson(result,{maxNodes:20000,maxDepth:20,maxSize:256*1024,measure:utf8Size});if(safe===undefined)return fail("The Calendar response exceeded its supported bound.");totalBytes+=Buffer.byteLength(JSON.stringify(safe));if(totalBytes>1024*1024)return fail("The Calendar check exceeded its response budget.");return safe;};
          const context:ComposioCalendarTransportContext={phase:foreground?"foreground":"background",metadata,signal:combined,assertCurrent:current,
            getSchemas:async id=>{const result=await call("COMPOSIO_GET_TOOL_SCHEMAS",buildCalendarSchemasRequest(metadata,id));verified=verifyCalendarContract(metadata,result,binding?.contract);return result;},
            currentAccounts:async()=>{if(!foreground)return fail("Calendar account discovery is foreground-only.");accounts??=call("COMPOSIO_SEARCH_TOOLS",buildCalendarSearchRequest(metadata));return accounts;},
            execute:async(read,id)=>{if(!activeRead||consumed||!isDeepStrictEqual(activeRead,read))return fail("This Calendar operation has no current one-read admission.");if(!verified)return fail("This Calendar read has no current compiled schema contract.");const args=verified.request(read,id);consumed=true;return call("COMPOSIO_MULTI_EXECUTE_TOOL",args);},
          };
          const prepared=await transport.prepare(context,binding?.contract);await current();
          if(!validComposioCalendarContract(prepared.contract)||binding&&!isDeepStrictEqual(prepared.contract,binding.contract))return fail("The verified Calendar schemas changed. Choose its source again.");
          capture?.(()=>{combined.throwIfAborted();held.assertCurrent?.();raw.assertCurrent?.();});
          const allowed=(read:ComposioCalendarRead)=>{buildComposioCalendarExecutorRequest(read);if(binding&&(read.accountId!==binding.accountId||read.kind==="listCalendars"||read.calendarId!==binding.calendarId))return fail("This Calendar watch cannot change its accepted account or calendar.");};
          const port:ComposioCalendarReadPort={assertCurrent:async(read,callSignal)=>{allowed(read);callSignal.throwIfAborted();await current();await prepared.port.assertCurrent(read,callSignal);await current();},read:async(read,callSignal)=>{allowed(read);callSignal.throwIfAborted();await current();if(activeRead)return fail("Concurrent Calendar operations are unavailable.");activeRead=structuredClone(read);consumed=false;try{const result=await prepared.port.read(read,callSignal);if(!consumed)return fail("The Calendar transport did not perform its admitted read.");await current();return result;}finally{activeRead=undefined;consumed=false;}}};
          return action(port,context,grant,structuredClone(prepared.contract));
        });
      }finally{release();}
    };
    const scoped=()=>foreground?withBotConnectorForegroundLifetime({signal:operationSignal,assertCurrent:active},()=>withBotConnectorInventoryScope(serverId,run)):withBotConnectorCachedInventoryScope(serverId,run);
    let onAbort!:()=>void;const cancelled=new Promise<never>((_resolve,reject)=>{onAbort=()=>{release();reject(operationSignal.reason);};operationSignal.addEventListener("abort",onAbort,{once:true});if(operationSignal.aborted)onAbort();});
    try{return await Promise.race([scoped(),cancelled]);}finally{operationSignal.removeEventListener("abort",onAbort);release();}
  }
  return {
    available:()=>ports.transport()!==undefined,
    discover:(botId:string,serverId:string,signal:AbortSignal,assertActive:()=>Promise<void>)=>operation(botId,serverId,undefined,signal,async(port,context,grant,contract)=>{
      const sources=await discoverComposioCalendarSources({...port,assertDiscoveryCurrent:context.assertCurrent,currentAccounts:context.currentAccounts},context.signal);
      const service=grant.tools.find(tool=>tool.name===COMPOSIO_SERVICE_TOOL_NAME)!;
      return sources.map(source=>({adapter:"composio-calendar-v1"as const,serverId,connection:structuredClone(grant),tools:[structuredClone(service)],accountId:source.accountId,calendarId:source.calendarId,labels:source.labels,contract}));
    },assertActive),
    authorize:async(botId:string,binding:ComposioCalendarWatchBinding,signal:AbortSignal)=>{
      const held=await ports.admit(botId,binding.serverId);let current:(()=>void)|undefined;
      const validate=async()=>{await operation(botId,binding.serverId,binding,signal,async()=>{},undefined,held,guard=>{current=guard;});held.signal.throwIfAborted();};
      try {await validate();return {...held,assertCurrent:()=>{held.signal.throwIfAborted();held.assertCurrent?.();current?.();},revalidateBeforeEffect:validate};}
      catch(error){held.release();throw error;}
    },
    withPort:<T>(botId:string,binding:ComposioCalendarWatchBinding,signal:AbortSignal,action:(port:ComposioCalendarReadPort)=>Promise<T>)=>operation(botId,binding.serverId,binding,signal,port=>action(port)),
    validate:(botId:string,binding:ComposioCalendarWatchBinding,signal:AbortSignal,existing?:BotRuntimeAuthorityAdmission)=>operation(botId,binding.serverId,binding,signal,async port=>{const now=ports.now();await port.assertCurrent({kind:"listEvents",accountId:binding.accountId,calendarId:binding.calendarId,timeMin:new Date(now).toISOString(),timeMax:new Date(now+15*60_000).toISOString(),timezone:"UTC"},signal);},undefined,existing),
  };
}
