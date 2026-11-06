/** Electron host composition. Construction is offline and never opens a Bot/model. */
import { app, ipcMain, logger } from "../../platform.js";
import { createBotPeerService } from "./service.js";
import type { BotPeerHostIdentity } from "./service.js";
import { botExecutionScope } from "../bot-runtime/bot-execution.js";
import { botSessionDeletionPending } from "../bot-runtime/bot-session-service.js";
import { inspectBotPeerSource } from "./authority.js";
import { resolveBotPeerSource } from "./source.js";
import type { BotToolCall } from "../bot-runtime/tool-adapter.js";
let active = false, timer: ReturnType<typeof setTimeout> | undefined;
async function identity(botId: string): Promise<BotPeerHostIdentity | undefined> {
  const { initializeBotApplicationService } = await import("../bot-application-service-main.js"); await initializeBotApplicationService();
  const bot = await (await import("../bot-store.js")).botStore.get(botId);
  if (!bot) return undefined;
  return {botId:bot.id,name:bot.name,incarnation:String(bot.createdAt),active:!await botSessionDeletionPending(app.getPath("userData"),botId)};
}
const session = async () => (await import("../bot-runtime/bot-session-main.js")).botSessionRuntime();
const work = async () => (await import("../bot-open-work/service-main.js")).botOpenWork;
export const botPeerHost = createBotPeerService({
  persistence: {
    read: async () => { await (await import("../bot-application-service-main.js")).initializeBotApplicationService(); return (await import("../bot-capability-services-main.js")).botCapabilityStore.getPeerMessagingState(); },
    write: async (...args) => (await import("../bot-capability-services-main.js")).botCapabilityStore.savePeerMessagingState(...args),
  },
  identity,
  directory: async () => { const bots = await (await import("../bot-store.js")).botStore.list(); return (await Promise.all(bots.map(({id})=>identity(id)))).filter((row):row is BotPeerHostIdentity=>row!==undefined); },
  verifiedReply: async (...args) => (await import("../bot-routine-models-main.js")).botRoutineModels.observedResponse(...args),
  root: async (source) => (await import("../bot-routine-models-main.js")).botRoutineModels.reservePeerRoot(source.botId,source.claimId,source.requestId),
  runtime: {
    state: async (botId) => {const state=await (await session()).routineState(botId); return state.kind === "unavailable" ? "unavailable" : state.kind === "needs_model" || state.kind === "model_error" ? "unavailable" : state.kind;},
    admit: async (botId,input) => {const result=await (await session()).send(botId,{...input,whenBusy:"followUp",ifNotInterrupted:true}); if (!result.submissionId) throw new Error("The peer input has no durable receipt."); return {submissionId:result.submissionId};},
    receipt: async (botId,requestId,publication) => {if(!publication)return undefined;const runtime=await session();await publication.assertCurrent();return runtime.peerReceipt(botId,requestId,publication);},
    stop: async (botId,submissionId,intentId,publication) => {if(!publication)return "not_running";const runtime=await session();await publication.assertCurrent();return runtime.stopLinkedWork(botId,submissionId,intentId,publication);},
    row: async (botId,eventId,row,publication) => {if(!publication)return;const runtime=await session();await publication.assertCurrent();await runtime.appendPeerRow(botId,eventId,row,publication);},
    evidence: async (botId,submissionId,kind,publication) => {if(!publication)return undefined;const runtime=await session();await publication.assertCurrent();return runtime.readLinkedWorkEvidence(botId,submissionId,kind,publication);},
  },
  links: {
    cleanup: async (liveIds) => { const live=new Set(liveIds), service=await work(); for (const bot of await (await import("../bot-store.js")).botStore.list()) for (const reservation of await service.peerReservations(bot.id)) if (!live.has(reservation.exchangeId)) await service.releasePeerReservation(bot.id,reservation.exchangeId,reservation.expiresAt); },
    reserve: async (exchangeId,source,recipient,title,expiresAt,publication) => {if(!publication.sender||!publication.recipient)throw new Error("The peer reservation has no current owners.");const service=await work(); await service.reservePeer(source.botId,{exchangeId,role:"outgoing",peerBotId:recipient.botId,title,expiresAt,submissionId:source.submissionId,entryId:source.entryId},publication.sender); try {await service.reservePeer(recipient.botId,{exchangeId,role:"incoming",peerBotId:source.botId,title,expiresAt},publication.recipient);} catch(error) {await service.discardPeerReservation(source.botId,exchangeId);throw error;}},
    activate: async (exchangeId,senderBotId,recipientBotId,input,publication) => {const service=await work(); if(publication.sender)await service.activatePeer(senderBotId,exchangeId,undefined,publication.sender); if(publication.recipient)await service.activatePeer(recipientBotId,exchangeId,input?.entryId?{submissionId:input.submissionId,entryId:input.entryId}:undefined,publication.recipient);},
    outcome: async (exchangeId,senderBotId,recipientBotId,publication) => {const service=await work(), guard=publication.sender??publication.recipient;if(!guard)return;await guard.assertCurrent();const current=await botPeerHost.exchange(guard.botId,exchangeId); if (!current?.result) return; if(publication.sender)await service.completePeer(senderBotId,exchangeId,current.result.outcome,current.result.createdAt,publication.sender);if(publication.recipient)await service.completePeer(recipientBotId,exchangeId,current.result.outcome,current.result.createdAt,publication.recipient);},
  },
  final: async (input,publication) => {if(!publication)return;await publication.assertCurrent();const {botDeliveryFunnel}=await import("../bot-delivery/funnel-main.js");await publication.assertCurrent(); await botDeliveryFunnel().deliver({publication,botId:input.botId,class:"peer_result",dedupeKey:`peer-root:${input.rootId}`,title:input.title,body:input.text,status:input.status,requestId:input.rootId,...(input.quiet?{quiet:true}:{})});},
  available: () => active,
  changed: (botIds) => {for(const botId of botIds){ipcMain.broadcast("bots:peers:changed",{botId});ipcMain.broadcast("bots:openWork:changed",{botId});ipcMain.broadcast("bots:changed",{botId});} wakeBotPeers();},
});
export function wakeBotPeers():void { if(!active||timer)return; timer=setTimeout(()=>{timer=undefined; void botPeerHost.reconcile().catch(error=>logger.warn("bots","Bot messaging reconciliation failed.",error)).finally(()=>{if(active){timer=setTimeout(()=>{timer=undefined;wakeBotPeers();},2000);timer.unref?.();}});},0);timer.unref?.(); }
export function startBotPeers():void {active=true;wakeBotPeers();}
export function stopBotPeers():void {active=false;if(timer)clearTimeout(timer);timer=undefined;}
export async function observeBotPeerReply(botId:string,message:import("@earendil-works/pi-ai").AssistantMessage,taskId:string):Promise<void>{ const current=botExecutionScope(botId);if(!current||current.taskId!==taskId)return;await botPeerHost.observeReply({botId,claimId:current.claim.id,requestId:current.claim.requestId,taskId,message});wakeBotPeers(); }
export async function botPeerToolSource(botId:string,call:BotToolCall){return resolveBotPeerSource(botId,call,async(botId,routineId)=>{const task=await(await import("../schedule-store.js")).scheduleStore.get(routineId);return task?.botId===botId&&task.notify===false;});}

export async function botPeerOpenWorkOrigin(botId:string,call:BotToolCall):Promise<import("../bot-open-work/store.js").BotOpenWorkOrigin>{
  const source=inspectBotPeerSource(await botPeerToolSource(botId,call)), peer=source.facts.peer;
  if(!peer)throw new Error("This input is not protected peer work.");
  const lease=await botPeerHost.executionLease(peer);
  try{await lease.revalidate();const id=peer.kind==="return"?peer.branchId??peer.exchangeId:peer.exchangeId;
    const exchange=await botPeerHost.exchange(botId,id);if(!exchange)throw new Error("This peer work has no owned exchange.");
    return {requestId:source.facts.requestId,source:{kind:"peer",exchangeId:id,role:exchange.direction==="sent"?"outgoing":"incoming",peerBotId:(exchange.direction==="sent"?exchange.recipient:exchange.sender).botId,submissionId:source.facts.submissionId,entryId:source.facts.entryId}};
  }finally{lease.release();}
}
