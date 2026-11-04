import type { BotConnectorWatchCondition, BotConnectorWatchSourceChoice, BotConnectorWatchView } from "../../../renderer/shared/bot-connector-watches.js";
import { copyBoundedJson, utf8Size } from "../bounded-json.js";
import type { BotRuntimeConnectionAuthority, BotRuntimeMcpToolAuthority } from "../bot-runtime-authority.js";
import type { ConnectorWatchBaseline } from "./connector-watch-imcp.js";
import { parseComposioCalendarBaseline, type ComposioCalendarBaseline } from "./connector-watch-composio.js";
import type { ComposioCalendarContract } from "./composio-calendar-host-port.js";
import { connectorTextIsWellFormed } from "./connector-text.js";

/** Private, persisted exact binding. No field in this type is accepted over IPC/Remote. */
interface ConnectorBindingBase {
  serverId: string;
  connection: BotRuntimeConnectionAuthority;
  tools: BotRuntimeMcpToolAuthority[];
  labels: Pick<BotConnectorWatchSourceChoice, "providerLabel" | "accountLabel" | "resourceLabel">;
}
export interface ImcpMailWatchBinding extends ConnectorBindingBase { adapter:"imcp-mail-v1";mailbox:string;account:string }
export interface ComposioCalendarWatchBinding extends ConnectorBindingBase { adapter:"composio-calendar-v1";accountId:string;calendarId:string;contract:ComposioCalendarContract }
export type BotConnectorWatchBinding=ImcpMailWatchBinding|ComposioCalendarWatchBinding;
export type BotConnectorWatchBaseline=ConnectorWatchBaseline|ComposioCalendarBaseline;
export class ConnectorWatchStorageError extends Error {constructor(){super("Saved connector watch history is invalid. Restore its valid backup before checking again.");this.name="ConnectorWatchStorageError";}}
const text=(value:unknown,limit=500)=>typeof value==="string"&&value.length>0&&value.length<=limit&&connectorTextIsWellFormed(value)&&!value.includes("\0");
export function validComposioCalendarContract(value:unknown):value is ComposioCalendarContract {const row=value as ComposioCalendarContract|null;return !!row&&Object.keys(row).sort().join(",")==="executorSchemaHash,readSchemaHashes,revision"&&row.revision==="composio-calendar-v1"&&/^[a-f0-9]{64}$/u.test(row.executorSchemaHash)&&!!row.readSchemaHashes&&Object.keys(row.readSchemaHashes).sort().join(",")==="getEvent,listCalendars,listEvents"&&Object.values(row.readSchemaHashes).every(hash=>typeof hash==="string"&&/^[a-f0-9]{64}$/u.test(hash));}
export function connectorBindingMatchesCondition(binding:BotConnectorWatchBinding,condition:BotConnectorWatchCondition):boolean{return binding.adapter==="imcp-mail-v1"?condition.kind==="email":condition.kind==="calendar";}
export interface BotConnectorWatchMutation {
  id: string;
  digest: string;
  at: number;
  result: BotConnectorWatchView | { id: string; revision: string; admitted: boolean };
}
export interface BotConnectorWatchPrivate {
  binding: BotConnectorWatchBinding;
  condition: BotConnectorWatchCondition;
  createDigest: string;
  mutations: BotConnectorWatchMutation[];
  deletedAt?: number;
}
export function parseConnectorPrivate(value: unknown): BotConnectorWatchPrivate | undefined {
  const clean = copyBoundedJson(value, { maxNodes: 20_000, maxDepth: 16, maxSize: 2 * 1024 * 1024, measure: utf8Size });
  if (!clean || typeof clean !== "object" || Array.isArray(clean)) return undefined;
  const record = clean as unknown as BotConnectorWatchPrivate;
  const binding=record.binding;
  if(!binding||!text(binding.serverId,200)||!binding.connection||binding.connection.sourceId!==binding.serverId||!Array.isArray(binding.connection.tools)||!Array.isArray(binding.tools)||!binding.labels||Object.keys(binding.labels).sort().join(",")!=="accountLabel,providerLabel,resourceLabel"||Object.values(binding.labels).some(label=>!text(label))||!text(record.createDigest,200)||!Array.isArray(record.mutations)||record.mutations.length>128)return undefined;
  const common=["adapter","serverId","connection","tools","labels"];
  if(binding.adapter==="imcp-mail-v1"){if(Object.keys(binding).some(key=>![...common,"account","mailbox"].includes(key))||binding.tools.length!==2||!text(binding.account)||!text(binding.mailbox,200)||record.condition?.kind!=="email"||Object.keys(record.condition).some(key=>!["kind","unreadOnly","sender","subject"].includes(key))||typeof record.condition.unreadOnly!=="boolean"||record.condition.sender!==undefined&&!text(record.condition.sender,200)||record.condition.subject!==undefined&&!text(record.condition.subject,200))return undefined;}
  else if(binding.adapter==="composio-calendar-v1"){if(Object.keys(binding).some(key=>![...common,"accountId","calendarId","contract"].includes(key))||binding.tools.length!==1||binding.tools[0]?.name!=="composio"||!text(binding.accountId,256)||!text(binding.calendarId)||binding.calendarId.toLowerCase()==="primary"||!validComposioCalendarContract(binding.contract)||record.condition?.kind!=="calendar"||Object.keys(record.condition).sort().join(",")!=="kind,lookAheadMinutes,timezone"||!Number.isSafeInteger(record.condition.lookAheadMinutes)||record.condition.lookAheadMinutes<15||record.condition.lookAheadMinutes>1440||!text(record.condition.timezone,100))return undefined;try{new Intl.DateTimeFormat("en",{timeZone:record.condition.timezone});}catch{return undefined;}}
  else return undefined;
  const viewKeys = new Set(["id", "botId", "revision", "name", "prompt", "templateId", "condition", "everyMinutes", "source", "enabled", "state", "lastCheckAt", "nextCheckAt", "lastRunAt", "lastError"]);
  for (const mutation of record.mutations) {
    if (!mutation || typeof mutation.id !== "string" || typeof mutation.digest !== "string" || !Number.isSafeInteger(mutation.at) || !mutation.result || typeof mutation.result !== "object") return undefined;
    const result = mutation.result;
    if ("admitted" in result) { if (Object.keys(result).some((key) => !["id", "revision", "admitted"].includes(key)) || typeof result.admitted !== "boolean") return undefined; }
    else if (Object.keys(result).some((key) => !viewKeys.has(key)) || typeof result.prompt !== "string" || result.prompt.length > 32_768 || !result.source || Object.keys(result.source).sort().join(",") !== "accountLabel,providerLabel,resourceLabel") return undefined;
    if (typeof result.id !== "string" || typeof result.revision !== "string") return undefined;
  }
  return record;
}
export function parseConnectorBaseline(value: unknown,binding?:BotConnectorWatchBinding):BotConnectorWatchBaseline|undefined {
  if(value===undefined)return undefined;
  try{
    if(binding?.adapter==="composio-calendar-v1"||value&&typeof value==="object"&&"version"in value){const baseline=parseComposioCalendarBaseline(value);if(!baseline||binding?.adapter==="imcp-mail-v1"||binding?.adapter==="composio-calendar-v1"&&(baseline.accountId!==binding.accountId||baseline.calendarId!==binding.calendarId))throw new ConnectorWatchStorageError();return baseline;}
    const clean=copyBoundedJson(value,{maxNodes:4000,maxDepth:6,maxSize:4*1024*1024,measure:utf8Size});if(!clean||typeof clean!=="object"||Array.isArray(clean))throw new ConnectorWatchStorageError();const row=clean as unknown as ConnectorWatchBaseline;
    if(Object.keys(row).sort().join(",")!=="items,kind"||row.kind!=="email"||!Array.isArray(row.items)||row.items.length>250||new Set(row.items.map(item=>item?.id)).size!==row.items.length||row.items.some(item=>!item||Object.keys(item).some(key=>!["id","title","signature"].includes(key))||!text(item.id)||!text(item.title)||!text(item.signature,10000)))throw new ConnectorWatchStorageError();return row;
  }catch{throw new ConnectorWatchStorageError();}
}
