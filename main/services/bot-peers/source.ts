/** Actual task/input provenance, never a request-name or caller-provided Bot ID. */
import { botExecutionScope } from "../bot-runtime/bot-execution.js";
import { BOT_PERSON_INPUT_KIND, BOT_ROUTINE_INPUT_KIND, BOT_PEER_INPUT_KIND, parseBotRoutineInputOrigin } from "../bot-runtime/bot-input-entry.js";
import type { BotToolCall } from "../bot-runtime/tool-adapter.js";
import { issueBotPeerSource, parseBotPeerInputOrigin, type BotPeerSourceToken } from "./authority.js";
export async function resolveBotPeerSource(botId: string, call: BotToolCall, routineQuiet?: (botId:string,routineId:string)=>Promise<boolean>): Promise<BotPeerSourceToken> {
  const current = botExecutionScope(botId);
  if (!current || current.taskId !== call.taskId || !current.scopeId || current.requestIds.length !== 1 || !current.claim.submissionId) throw new Error("Bot messaging requires one current host-bound input.");
  const claim = current.claim, requests = await call.runRequestIds?.();
  if (requests?.length !== 1 || requests[0] !== claim.requestId) throw new Error("This peer request has mixed or stale source inputs.");
  const [records, entries] = await Promise.all([call.submissions([claim.requestId]), call.entries()]), record = records[0], entry = entries.find((row) => row.id === record?.entry);
  if (record?.type !== "input" || record.status !== "placed" || String(record.id) !== claim.submissionId || !entry || entry.model?.[0]?.role !== "user" || entries.some((row) => row.kind === "aiden.bot-notice" && (row.data as {notice?:unknown;requestId?:unknown})?.notice === "hidden_input" && (row.data as {requestId?:unknown}).requestId === claim.requestId)) throw new Error("Bot messaging needs an actual accepted task input.");
  if (claim.peer) {
    const data = entry.data as {peerOrigin?:unknown;peerRequestId?:unknown} | undefined, origin = parseBotPeerInputOrigin(data?.peerOrigin);
    if (entry.kind !== BOT_PEER_INPUT_KIND || !origin || data?.peerRequestId !== claim.requestId || origin.exchangeId !== claim.peer.exchangeId || origin.deliveryId !== claim.peer.deliveryId || origin.kind !== claim.peer.kind) throw new Error("The peer source has no exact protected delivery.");
  } else if (claim.routineId) {
    const origin = parseBotRoutineInputOrigin((entry.data as {routineOrigin?:unknown}|undefined)?.routineOrigin);
    if (entry.kind !== BOT_ROUTINE_INPUT_KIND || !origin || origin.botId !== botId || origin.routineId !== claim.routineId || origin.runId !== claim.requestId) throw new Error("This routine has no accepted task provenance.");
  } else if (![BOT_PERSON_INPUT_KIND, "pi.user"].includes(entry.kind) || /^(?:intro:|routine:|wake:|peer:|memory:)/u.test(claim.requestId)) throw new Error("Self-generated, hidden and informational inputs cannot delegate tasks.");
  const signal = current.runtime.signal ? AbortSignal.any([call.signal, current.runtime.signal]) : call.signal;
  const assertCurrent = async () => { signal.throwIfAborted(); if (botExecutionScope(botId) !== current || current.active?.() === false) throw new Error("The source task finished."); await current.runtime.revalidate(); signal.throwIfAborted(); };
  await assertCurrent();
  let quiet: true | undefined = claim.deliveryQuiet;
  if (claim.routineId && !claim.peer && await routineQuiet?.(botId,claim.routineId)) quiet=true;
  return issueBotPeerSource({ signal, assertCurrent, facts: { botId, botIncarnation: claim.botIncarnation, claimId: claim.id, requestId: claim.requestId, scopeId: current.scopeId, taskId: current.taskId, callId: call.callId, submissionId: String(record.id), entryId: String(entry.id), root: structuredClone(claim.root), ...(quiet ? {quiet}:{}), ...(claim.peer ? {peer:structuredClone(claim.peer)} : {}), ...(claim.peer?.watch ? {watch:structuredClone(claim.peer.watch)} : claim.connectorRestriction ? {watch:{botId,restriction:structuredClone(claim.connectorRestriction)}} : {}) } });
}
