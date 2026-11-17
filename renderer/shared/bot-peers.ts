/** Owner-only peer controls; host-private delegation authority never crosses this contract. */
export const BOT_PEER_LIMITS = { pairs: 128, catalog: 128, exchanges: 128, receipts: 512, hops: 3, requests: 8, inbound: 8, pendingMs: 86_400_000, mutationBytes: 16 * 1024, publicBytes: 900 * 1024, messageBytes: 8 * 1024, resultBytes: 16 * 1024, evidenceBytes: 32 * 1024, descriptionBytes: 2048 } as const;
export interface BotPeerIdentity { botId: string; name: string }
export interface BotPeerPair { id: string; revision: string; peer: BotPeerIdentity; approvedAt: number }
export interface BotPeerSettings { botId: string; revision: string; routingDescription: string; pairs: BotPeerPair[]; updatedAt: number; lastMutationId?: string }
export interface BotPeerCatalog { botId: string; revision: string; bots: (BotPeerIdentity & { available: boolean })[] }
export type BotPeerMutation =
  | { action: "describe"; botId: string; mutationId: string; expectedRevision: string; routingDescription: string }
  | { action: "approve"; botId: string; mutationId: string; expectedRevision: string; catalogRevision: string; peerBotId: string }
  | { action: "revoke"; botId: string; mutationId: string; expectedRevision: string; pairId: string; pairRevision: string };
export type BotPeerErrorCode = "invalid" | "conflict" | "unavailable" | "history_full" | "access_changed" | "not_found";
export type BotPeerMutationResult = { ok: true; mutationId: string; replayed: boolean; snapshot: BotPeerSettings } | { ok: false; code: BotPeerErrorCode; error: string; snapshot?: BotPeerSettings };
export type BotPeerExchangeKind = "request" | "question" | "status" | "fyi";
export type BotPeerExchangeState = "waiting" | "queued" | "running" | "interrupted" | "stopping" | "completed" | "failed" | "cancelled" | "expired" | "uncertain";
export type BotPeerStopState = "requested" | "uncertain" | "stopped" | "not_running" | "blocked";
export interface BotPeerStopReceipt { mutationId: string; state: BotPeerStopState; at: number; reason?: "mixed_inputs" | "host_unavailable" | "stale_source" }
export interface BotPeerExchangeSummary {
  id: string; revision: string; pairId: string; sender: BotPeerIdentity; recipient: BotPeerIdentity;
  direction: "sent" | "received"; kind: BotPeerExchangeKind; title: string; state: BotPeerExchangeState;
  createdAt: number; updatedAt: number; expiresAt: number; canStop: boolean;
  returnState: "reserved" | "waiting" | "queued" | "delivered" | "not_applicable";
  parentExchangeId?: string; rootExchangeId?: string; blockedReason?: string; lastStop?: BotPeerStopReceipt;
}
export interface BotPeerExchangeDetail extends BotPeerExchangeSummary {
  request: { text: string };
  result?: { outcome: "completed" | "failed" | "cancelled" | "expired"; text: string; truncated: boolean; createdAt: number };
}
export interface BotPeerExchangeList { botId: string; revision: string; exchanges: BotPeerExchangeSummary[] }
export interface BotPeerStopMutation { botId: string; exchangeId: string; mutationId: string; expectedRevision: string }
export type BotPeerStopResult = { ok: true; mutationId: string; replayed: boolean; exchange: BotPeerExchangeDetail } | { ok: false; code: BotPeerErrorCode; error: string; exchange?: BotPeerExchangeDetail };
export interface BotPeerEvidence { exchangeId: string; kind: "source" | "result"; botId: string; submissionId: string; entryId: string; title: string; text: string; truncated: boolean; createdAt?: number }
const encoder = new TextEncoder();
function object(raw: unknown): Record<string, unknown> { if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw new Error("Invalid peer record."); return raw as Record<string, unknown>; }
function fields(row: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void { if (required.some((key) => row[key] === undefined) || Object.keys(row).some((key) => !required.includes(key) && !optional.includes(key))) throw new Error("Invalid peer fields."); }
export function parseBotPeerId(raw: unknown): string { if (typeof raw !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/u.test(raw)) throw new Error("Invalid peer identity."); return raw; }
function uuid(raw: unknown): string { if (typeof raw !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(raw)) throw new Error("Invalid peer action identity."); return raw; }
function text(raw: unknown, scalars: number, bytes: number, empty = false): string { if (typeof raw !== "string" || !empty && !raw.trim() || raw.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(raw) || [...raw].length > scalars || encoder.encode(raw).length > bytes) throw new Error("Invalid peer text."); return raw; }
function label(raw: unknown): string { return text(raw, 160, 640); }
function time(raw: unknown): number { if (!Number.isSafeInteger(raw) || (raw as number) < 0) throw new Error("Invalid peer timestamp."); return raw as number; }
function bool(raw: unknown): boolean { if (typeof raw !== "boolean") throw new Error("Invalid peer state."); return raw; }
function choice<T extends string>(raw: unknown, values: readonly T[]): T { if (!values.includes(raw as T)) throw new Error("Invalid peer choice."); return raw as T; }
function bounded(raw: unknown, bytes = BOT_PEER_LIMITS.publicBytes): void { const encoded = JSON.stringify(raw); if (!encoded || encoder.encode(encoded).length > bytes) throw new Error("Peer data is too large."); }
function array(raw: unknown, limit: number): unknown[] { if (!Array.isArray(raw) || raw.length > limit) throw new Error("Too many peer records."); return raw; }
function unique(values: readonly string[]): void { if (new Set(values).size !== values.length) throw new Error("Duplicate peer records."); }
function identity(raw: unknown): BotPeerIdentity { const row = object(raw); fields(row, ["botId", "name"]); return { botId: parseBotPeerId(row.botId), name: label(row.name) }; }
export function parseBotPeerSettings(raw: unknown): BotPeerSettings {
  bounded(raw); const row = object(raw); fields(row, ["botId", "revision", "routingDescription", "pairs", "updatedAt"], ["lastMutationId"]);
  const botId = parseBotPeerId(row.botId), pairs = array(row.pairs, BOT_PEER_LIMITS.pairs).map((raw) => { const pair = object(raw); fields(pair, ["id", "revision", "peer", "approvedAt"]); const peer = identity(pair.peer); if (peer.botId === botId) throw new Error("A Bot cannot approve itself."); return { id: parseBotPeerId(pair.id), revision: parseBotPeerId(pair.revision), peer, approvedAt: time(pair.approvedAt) }; }); unique(pairs.map((pair) => pair.id)); unique(pairs.map((pair) => pair.peer.botId));
  return { botId, revision: parseBotPeerId(row.revision), routingDescription: text(row.routingDescription, 1000, BOT_PEER_LIMITS.descriptionBytes, true), pairs, updatedAt: time(row.updatedAt), ...(row.lastMutationId === undefined ? {} : { lastMutationId: uuid(row.lastMutationId) }) };
}
export function parseBotPeerCatalog(raw: unknown): BotPeerCatalog {
  bounded(raw); const row = object(raw); fields(row, ["botId", "revision", "bots"]); const botId = parseBotPeerId(row.botId), bots = array(row.bots, BOT_PEER_LIMITS.catalog).map((raw) => { const bot = object(raw); fields(bot, ["botId", "name", "available"]); const id = parseBotPeerId(bot.botId); if (id === botId) throw new Error("A Bot cannot approve itself."); return { botId: id, name: label(bot.name), available: bool(bot.available) }; }); unique(bots.map((bot) => bot.botId)); return { botId, revision: parseBotPeerId(row.revision), bots };
}
export function parseBotPeerMutation(raw: unknown): BotPeerMutation {
  bounded(raw, BOT_PEER_LIMITS.mutationBytes); const row = object(raw), action = choice(row.action, ["describe", "approve", "revoke"] as const), common = { botId: parseBotPeerId(row.botId), mutationId: uuid(row.mutationId), expectedRevision: parseBotPeerId(row.expectedRevision) };
  if (action === "describe") { fields(row, ["action", "botId", "mutationId", "expectedRevision", "routingDescription"]); return { action, ...common, routingDescription: text(row.routingDescription, 1000, BOT_PEER_LIMITS.descriptionBytes, true).trim() }; }
  if (action === "approve") { fields(row, ["action", "botId", "mutationId", "expectedRevision", "catalogRevision", "peerBotId"]); return { action, ...common, catalogRevision: parseBotPeerId(row.catalogRevision), peerBotId: parseBotPeerId(row.peerBotId) }; }
  fields(row, ["action", "botId", "mutationId", "expectedRevision", "pairId", "pairRevision"]); return { action, ...common, pairId: parseBotPeerId(row.pairId), pairRevision: parseBotPeerId(row.pairRevision) };
}
function stopReceipt(raw: unknown): BotPeerStopReceipt { const row = object(raw); fields(row, ["mutationId", "state", "at"], ["reason"]); return { mutationId: uuid(row.mutationId), state: choice(row.state, ["requested", "uncertain", "stopped", "not_running", "blocked"] as const), at: time(row.at), ...(row.reason === undefined ? {} : { reason: choice(row.reason, ["mixed_inputs", "host_unavailable", "stale_source"] as const) }) }; }
function summary(raw: unknown, detail = false): BotPeerExchangeSummary {
  const row = object(raw); fields(row, ["id", "revision", "pairId", "sender", "recipient", "direction", "kind", "title", "state", "createdAt", "updatedAt", "expiresAt", "canStop", "returnState", ...(detail ? ["request"] : [])], ["parentExchangeId", "rootExchangeId", "blockedReason", "lastStop", ...(detail ? ["result"] : [])]);
  const sender = identity(row.sender), recipient = identity(row.recipient); if (sender.botId === recipient.botId) throw new Error("A Bot cannot message itself.");
  return { id: parseBotPeerId(row.id), revision: parseBotPeerId(row.revision), pairId: parseBotPeerId(row.pairId), sender, recipient, direction: choice(row.direction, ["sent", "received"] as const), kind: choice(row.kind, ["request", "question", "status", "fyi"] as const), title: label(row.title), state: choice(row.state, ["waiting", "queued", "running", "interrupted", "stopping", "completed", "failed", "cancelled", "expired", "uncertain"] as const), createdAt: time(row.createdAt), updatedAt: time(row.updatedAt), expiresAt: time(row.expiresAt), canStop: bool(row.canStop), returnState: choice(row.returnState, ["reserved", "waiting", "queued", "delivered", "not_applicable"] as const), ...(row.parentExchangeId === undefined ? {} : { parentExchangeId: parseBotPeerId(row.parentExchangeId) }), ...(row.rootExchangeId === undefined ? {} : { rootExchangeId: parseBotPeerId(row.rootExchangeId) }), ...(row.blockedReason === undefined ? {} : { blockedReason: text(row.blockedReason, 1000, 2048) }), ...(row.lastStop === undefined ? {} : { lastStop: stopReceipt(row.lastStop) }) };
}
export function parseBotPeerExchangeDetail(raw: unknown): BotPeerExchangeDetail {
  bounded(raw); const base = summary(raw, true), row = object(raw), request = object(row.request); fields(request, ["text"]);
  let result: BotPeerExchangeDetail["result"]; if (row.result !== undefined) { const value = object(row.result); fields(value, ["outcome", "text", "truncated", "createdAt"]); result = { outcome: choice(value.outcome, ["completed", "failed", "cancelled", "expired"] as const), text: text(value.text, BOT_PEER_LIMITS.resultBytes, BOT_PEER_LIMITS.resultBytes, true), truncated: bool(value.truncated), createdAt: time(value.createdAt) }; }
  return { ...base, request: { text: text(request.text, BOT_PEER_LIMITS.messageBytes, BOT_PEER_LIMITS.messageBytes) }, ...(result ? { result } : {}) };
}
export function parseBotPeerExchangeList(raw: unknown): BotPeerExchangeList {
  bounded(raw); const row = object(raw); fields(row, ["botId", "revision", "exchanges"]); const botId = parseBotPeerId(row.botId), exchanges = array(row.exchanges, BOT_PEER_LIMITS.exchanges).map((raw) => summary(raw)); unique(exchanges.map((exchange) => exchange.id)); for (const exchange of exchanges) if ((exchange.direction === "sent" ? exchange.sender : exchange.recipient).botId !== botId) throw new Error("Peer exchange belongs to another Bot."); return { botId, revision: parseBotPeerId(row.revision), exchanges };
}
export function parseBotPeerStopMutation(raw: unknown): BotPeerStopMutation { bounded(raw, BOT_PEER_LIMITS.mutationBytes); const row = object(raw); fields(row, ["botId", "exchangeId", "mutationId", "expectedRevision"]); return { botId: parseBotPeerId(row.botId), exchangeId: parseBotPeerId(row.exchangeId), mutationId: uuid(row.mutationId), expectedRevision: parseBotPeerId(row.expectedRevision) }; }
function error(row: Record<string, unknown>): { code: BotPeerErrorCode; error: string } { return { code: choice(row.code, ["invalid", "conflict", "unavailable", "history_full", "access_changed", "not_found"] as const), error: text(row.error, 1000, 2048) }; }
export function parseBotPeerMutationResult(raw: unknown): BotPeerMutationResult { bounded(raw); const row = object(raw); if (row.ok === true) { fields(row, ["ok", "mutationId", "replayed", "snapshot"]); return { ok: true, mutationId: uuid(row.mutationId), replayed: bool(row.replayed), snapshot: parseBotPeerSettings(row.snapshot) }; } if (row.ok !== false) throw new Error("Invalid peer mutation result."); fields(row, ["ok", "code", "error"], ["snapshot"]); return { ok: false, ...error(row), ...(row.snapshot === undefined ? {} : { snapshot: parseBotPeerSettings(row.snapshot) }) }; }
export function parseBotPeerStopResult(raw: unknown): BotPeerStopResult { bounded(raw); const row = object(raw); if (row.ok === true) { fields(row, ["ok", "mutationId", "replayed", "exchange"]); return { ok: true, mutationId: uuid(row.mutationId), replayed: bool(row.replayed), exchange: parseBotPeerExchangeDetail(row.exchange) }; } if (row.ok !== false) throw new Error("Invalid peer Stop result."); fields(row, ["ok", "code", "error"], ["exchange"]); return { ok: false, ...error(row), ...(row.exchange === undefined ? {} : { exchange: parseBotPeerExchangeDetail(row.exchange) }) }; }
export function parseBotPeerEvidence(raw: unknown): BotPeerEvidence { bounded(raw, 256 * 1024); const row = object(raw); fields(row, ["exchangeId", "kind", "botId", "submissionId", "entryId", "title", "text", "truncated"], ["createdAt"]); const decimal = (value: unknown) => { if (typeof value !== "string" || !/^[1-9][0-9]{0,31}$/u.test(value)) throw new Error("Invalid peer evidence source."); return value; }; return { exchangeId: parseBotPeerId(row.exchangeId), kind: choice(row.kind, ["source", "result"] as const), botId: parseBotPeerId(row.botId), submissionId: decimal(row.submissionId), entryId: decimal(row.entryId), title: label(row.title), text: text(row.text, BOT_PEER_LIMITS.evidenceBytes, BOT_PEER_LIMITS.evidenceBytes, true), truncated: bool(row.truncated), ...(row.createdAt === undefined ? {} : { createdAt: time(row.createdAt) }) }; }

export const BOT_PEER_MESSAGE_ENTRY_KIND = "aiden.peer-message";
export interface BotPeerTranscriptData { exchangeId: string; direction: "sent" | "received"; peerBotId: string; peerName: string; messageKind: "request" | "question" | "status" | "fyi" | "result"; final?: true; at?: number }
export function parseBotPeerTranscriptData(raw: unknown): BotPeerTranscriptData { const row = object(raw); fields(row, ["exchangeId", "direction", "peerBotId", "peerName", "messageKind"], ["at", "final"]); if (row.final !== undefined && (row.final !== true || row.messageKind !== "result")) throw new Error("Invalid final peer marker."); return { exchangeId: parseBotPeerId(row.exchangeId), direction: choice(row.direction, ["sent", "received"] as const), peerBotId: parseBotPeerId(row.peerBotId), peerName: label(row.peerName), messageKind: choice(row.messageKind, ["request", "question", "status", "fyi", "result"] as const), ...(row.final === true ? { final: true as const } : {}), ...(row.at === undefined ? {} : { at: time(row.at) }) }; }
