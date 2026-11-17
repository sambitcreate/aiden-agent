/** Model-facing allowance for the same closed read translation, never a generic dispatcher. */
import { isDeepStrictEqual } from "node:util";
import { buildComposioCalendarExecutorRequest, type ComposioCalendarRead } from "./connector-watch-composio.js";
import type { BotConnectorExecutionRestriction } from "../bot-connector-inventory-scope.js";
export function calendarWatchCallAllowed(restriction:BotConnectorExecutionRestriction,input:unknown,now=Date.now()):boolean{
  const binding=restriction.binding,condition=restriction.condition;if(binding.adapter!=="composio-calendar-v1"||condition?.kind!=="calendar")return false;
  if(!input||typeof input!=="object"||Array.isArray(input))return false;const call=input as Record<string,unknown>;
  if(call.action==="describe")return Object.keys(call).length===1;
  if(call.action!=="call"||call.tool!=="COMPOSIO_MULTI_EXECUTE_TOOL"||Object.keys(call).sort().join(",")!=="action,arguments,tool"||!call.arguments||typeof call.arguments!=="object"||Array.isArray(call.arguments))return false;
  const args=call.arguments as Record<string,unknown>,tools=args.tools;if(!Array.isArray(tools)||tools.length!==1||!tools[0]||typeof tools[0]!=="object"||Array.isArray(tools[0]))return false;const item=tools[0] as Record<string,unknown>,params=item.arguments as Record<string,unknown>|null;
  if(!params||typeof params!=="object"||Array.isArray(params)||item.account!==binding.accountId)return false;
  let read:ComposioCalendarRead;
  if(item.tool_slug==="GOOGLECALENDAR_EVENTS_LIST"){
    if(typeof params.timeMin!=="string"||typeof params.timeMax!=="string"||params.calendarId!==binding.calendarId||params.timeZone!==condition.timezone)return false;
    const from=Date.parse(params.timeMin),to=Date.parse(params.timeMax);if(!Number.isSafeInteger(now)||from<now-60_000||to>now+condition.lookAheadMinutes*60_000)return false;
    read={kind:"listEvents",accountId:binding.accountId,calendarId:binding.calendarId,timeMin:params.timeMin,timeMax:params.timeMax,timezone:condition.timezone,...(typeof params.pageToken==="string"?{pageToken:params.pageToken}:{})};
  }else if(item.tool_slug==="GOOGLECALENDAR_EVENTS_GET"){
    if(params.calendar_id!==binding.calendarId||params.time_zone!==condition.timezone||typeof params.event_id!=="string")return false;read={kind:"getEvent",accountId:binding.accountId,calendarId:binding.calendarId,eventId:params.event_id,timezone:condition.timezone};
  }else return false;
  try{const {session_id,...body}=args;if(session_id!==undefined&&(typeof session_id!=="string"||session_id.length>500||!/^[-A-Za-z0-9._:]+$/u.test(session_id)))return false;return isDeepStrictEqual(body,buildComposioCalendarExecutorRequest(read));}catch{return false;}
}
