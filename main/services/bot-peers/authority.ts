/** Host-only peer provenance. Parsing stored data is not admission authority. */
import type { BotConnectorExecutionRestriction } from "../bot-connector-inventory-scope.js";
import { parseBotPeerId } from "../../../renderer/shared/bot-peers.js";
export interface BotPeerRootBudget { botId: string; requestId: string; routineRunId?: string }
export interface BotPeerExecutionBinding {
  version: 1; exchangeId: string; deliveryId: string; rootId: string;
  pairId: string; pairGeneration: number; kind: "request" | "question" | "return";
  senderBotId: string; recipientBotId: string; depth: number; expiresAt: number;
  sourceClaimId: string; sourceRequestId: string;
  /** Logical receiving branch; absent for the initiating person's/routine's branch. */
  branchId?: string;
  root: BotPeerRootBudget;
  /** Exact original watch owner; recipient access is independently intersected. */
  watch?: { botId: string; restriction: BotConnectorExecutionRestriction };
}
export interface BotPeerInputOrigin { version: 1; exchangeId: string; deliveryId: string; kind: "request" | "question" | "return" }
export interface BotPeerDeliveryAuthority {
  origin: BotPeerInputOrigin; botId: string; requestId: string; binding: BotPeerExecutionBinding; peerName: string;
  /** Return continuation restores this exact frozen source model, never a later default. */
  modelFrom?: { botId: string; claimId: string; requestId: string };
  assertCurrent(): Promise<void>;
}
const issued = new WeakMap<object, BotPeerDeliveryAuthority>();
export function parseBotPeerInputOrigin(raw: unknown): BotPeerInputOrigin | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "deliveryId,exchangeId,kind,version" || row.version !== 1 || !["request", "question", "return"].includes(String(row.kind))) return undefined;
  try { return { version: 1, exchangeId: parseBotPeerId(row.exchangeId), deliveryId: parseBotPeerId(row.deliveryId), kind: row.kind as BotPeerInputOrigin["kind"] }; } catch { return undefined; }
}
export function parseBotPeerExecutionBinding(raw: unknown): BotPeerExecutionBinding {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid protected peer execution provenance.");
  const row = raw as BotPeerExecutionBinding;
  if (Object.keys(row).some((key) => !["version", "exchangeId", "deliveryId", "rootId", "pairId", "pairGeneration", "kind", "senderBotId", "recipientBotId", "depth", "expiresAt", "sourceClaimId", "sourceRequestId", "branchId", "root", "watch"].includes(key)) || row.version !== 1 || !Number.isSafeInteger(row.pairGeneration) || row.pairGeneration < 1 || !Number.isSafeInteger(row.depth) || row.depth < 0 || row.depth > 3 || !Number.isSafeInteger(row.expiresAt) || row.expiresAt < 0 || !["request", "question", "return"].includes(row.kind)) throw new Error("Invalid protected peer execution provenance.");
  for (const id of [row.exchangeId, row.deliveryId, row.rootId, row.pairId, row.senderBotId, row.recipientBotId, row.sourceClaimId, row.sourceRequestId]) parseBotPeerId(id);
  if (row.branchId !== undefined) parseBotPeerId(row.branchId);
  if (row.senderBotId === row.recipientBotId || !row.root || Object.keys(row.root).some((key) => !["botId", "requestId", "routineRunId"].includes(key))) throw new Error("Invalid protected peer root.");
  parseBotPeerId(row.root.botId); parseBotPeerId(row.root.requestId); if (row.root.routineRunId !== undefined) parseBotPeerId(row.root.routineRunId);
  if (row.watch) { if (Object.keys(row.watch).sort().join(",") !== "botId,restriction") throw new Error("Invalid protected watch origin."); parseBotPeerId(row.watch.botId); const restriction = row.watch.restriction; if (!restriction || Object.keys(restriction).sort().join(",") !== "binding,revision,routineId" || !Number.isSafeInteger(restriction.revision) || restriction.revision < 0 || !restriction.binding?.serverId) throw new Error("Invalid protected watch restriction."); parseBotPeerId(restriction.routineId); }
  return structuredClone(row);
}
export interface BotPeerSourceFacts {
  botId: string; botIncarnation: string; claimId: string; requestId: string;
  scopeId: string; taskId: string; callId: string; submissionId: string; entryId: string;
  quiet?: true; root: BotPeerRootBudget; peer?: BotPeerExecutionBinding;
  watch?: { botId: string; restriction: BotConnectorExecutionRestriction };
}
export interface BotPeerSourceAuthority { facts: BotPeerSourceFacts; signal: AbortSignal; assertCurrent(): Promise<void> }
export interface BotPeerSourceToken { readonly source: "host" }
const sources = new WeakMap<object, BotPeerSourceAuthority>();
export function issueBotPeerSource(proof: BotPeerSourceAuthority): BotPeerSourceToken {
  const token = Object.freeze({ source: "host" as const }); sources.set(token, { ...proof, facts: structuredClone(proof.facts) }); return token;
}
export function inspectBotPeerSource(value: BotPeerSourceToken): BotPeerSourceAuthority {
  const proof = value && typeof value === "object" ? sources.get(value) : undefined;
  if (!proof) throw new Error("Peer source authority was not issued by the host."); return { ...proof, facts: structuredClone(proof.facts) };
}
/** The peer host calls this only after protected delivery/root/pair checks. */
export function issueBotPeerInputOrigin(proof: BotPeerDeliveryAuthority): BotPeerInputOrigin {
  const origin = parseBotPeerInputOrigin(proof.origin), binding = parseBotPeerExecutionBinding(proof.binding);
  if (!origin || origin.exchangeId !== binding.exchangeId || origin.deliveryId !== binding.deliveryId || origin.kind !== binding.kind || proof.botId !== binding.recipientBotId) throw new Error("This peer delivery has no exact host authority.");
  parseBotPeerId(proof.requestId); if (!proof.peerName || [...proof.peerName].length > 160 || Buffer.byteLength(proof.peerName) > 640) throw new Error("Invalid peer display name."); const token = Object.freeze(origin); issued.set(token, { ...proof, origin: token, binding, ...(proof.modelFrom ? { modelFrom: { ...proof.modelFrom } } : {}) }); return token;
}
export function inspectBotPeerInputOrigin(raw: unknown): BotPeerDeliveryAuthority {
  const proof = raw && typeof raw === "object" ? issued.get(raw) : undefined;
  if (!proof) throw new Error("Peer input authority was not issued by the host."); return { ...proof, binding: structuredClone(proof.binding), ...(proof.modelFrom ? { modelFrom: { ...proof.modelFrom } } : {}) };
}
