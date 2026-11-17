import {
  parseBotPeerId, parseBotPeerMutation, parseBotPeerStopMutation,
  parseBotPeerSettings, parseBotPeerCatalog, parseBotPeerMutationResult,
  parseBotPeerExchangeList, parseBotPeerExchangeDetail, parseBotPeerStopResult, parseBotPeerEvidence,
  type BotPeerSettings, type BotPeerCatalog, type BotPeerMutation, type BotPeerMutationResult,
  type BotPeerExchangeList, type BotPeerExchangeDetail, type BotPeerStopMutation, type BotPeerStopResult, type BotPeerEvidence,
} from "../../renderer/shared/bot-peers.js";
import type { RendererDocumentOwner } from "../services/renderer-document-owner.js";

export interface BotPeerInvocation { signal: AbortSignal; assertCurrent(): void | Promise<void> }
export interface BotPeerOwnerPort {
  settings(botId: string): Promise<BotPeerSettings>;
  catalog(botId: string): Promise<BotPeerCatalog>;
  mutate(botId: string, input: BotPeerMutation, lifetime: BotPeerInvocation): Promise<BotPeerMutationResult>;
  exchanges(botId: string): Promise<BotPeerExchangeList>;
  exchange(botId: string, exchangeId: string): Promise<BotPeerExchangeDetail | undefined>;
  stop(botId: string, exchangeId: string, input: BotPeerStopMutation, lifetime: BotPeerInvocation): Promise<BotPeerStopResult>;
  evidence(botId: string, exchangeId: string, kind: "source" | "result"): Promise<BotPeerEvidence | undefined>;
}

export function assertBotPeerExchangeOwner(botId: string, id: string, value: BotPeerExchangeDetail): void {
  if (value.id !== id || (value.direction === "sent" ? value.sender : value.recipient).botId !== botId) throw new Error("The peer exchange belongs to another Bot.");
}

/** A renderer supplies an owner command, never delegation provenance. */
export function registerBotPeerHandlers<Event>(ports: {
  handle(channel: string, handler: (event: Event, input: unknown) => Promise<unknown>): void;
  owner(event: Event): Pick<RendererDocumentOwner, "isDestroyed" | "onInvalidated">;
  service(): Promise<BotPeerOwnerPort>;
}): void {
  for (const action of ["settings", "catalog", "mutate", "exchanges", "exchange", "stop", "evidence"] as const) ports.handle(`bots:peers:${action}`, async (event, raw) => {
    const owner = ports.owner(event), controller = new AbortController();
    const current = () => { controller.signal.throwIfAborted(); if (owner.isDestroyed()) throw new Error("The application document is no longer active."); };
    current(); const detach = owner.onInvalidated(() => controller.abort());
    try {
      let botId: string, exchangeId: string | undefined, kind: "source" | "result" | undefined;
      let mutation: BotPeerMutation | undefined, stop: BotPeerStopMutation | undefined;
      if (action === "mutate") { mutation = parseBotPeerMutation(raw); botId = mutation.botId; }
      else if (action === "stop") { stop = parseBotPeerStopMutation(raw); botId = stop.botId; exchangeId = stop.exchangeId; }
      else {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid Bot messaging request.");
        const input = raw as Record<string, unknown>, keys = action === "evidence" ? ["botId", "exchangeId", "kind"] : action === "exchange" ? ["botId", "exchangeId"] : ["botId"];
        if (Object.keys(input).length !== keys.length || Object.keys(input).some((key) => !keys.includes(key))) throw new Error("Invalid Bot messaging request.");
        botId = parseBotPeerId(input.botId);
        if (action === "exchange" || action === "evidence") exchangeId = parseBotPeerId(input.exchangeId);
        if (action === "evidence") { if (input.kind !== "source" && input.kind !== "result") throw new Error("Invalid exchange evidence."); kind = input.kind; }
      }
      const service = await ports.service(); current();
      let value: unknown;
      if (action === "settings") { const result = parseBotPeerSettings(await service.settings(botId)); if (result.botId !== botId) throw new Error("Bot messaging settings changed owner."); value = result; }
      else if (action === "catalog") { const result = parseBotPeerCatalog(await service.catalog(botId)); if (result.botId !== botId) throw new Error("The Bot catalog changed owner."); value = result; }
      else if (action === "mutate") {
        const result = parseBotPeerMutationResult(await service.mutate(botId, mutation!, { signal: controller.signal, assertCurrent: current }));
        if (result.ok && result.mutationId !== mutation!.mutationId || result.snapshot && result.snapshot.botId !== botId) throw new Error("The Bot pair receipt changed owner."); value = result;
      } else if (action === "exchanges") { const result = parseBotPeerExchangeList(await service.exchanges(botId)); if (result.botId !== botId) throw new Error("The exchange list changed owner."); value = result; }
      else if (action === "exchange") { const raw = await service.exchange(botId, exchangeId!); const result = raw === undefined ? null : parseBotPeerExchangeDetail(raw); if (result) assertBotPeerExchangeOwner(botId, exchangeId!, result); value = result; }
      else if (action === "stop") {
        const result = parseBotPeerStopResult(await service.stop(botId, exchangeId!, stop!, { signal: controller.signal, assertCurrent: current }));
        if (result.ok && result.mutationId !== stop!.mutationId) throw new Error("The exchange Stop receipt changed.");
        if (result.exchange) assertBotPeerExchangeOwner(botId, exchangeId!, result.exchange); value = result;
      } else {
        const raw = await service.evidence(botId, exchangeId!, kind!); const result = raw === undefined ? null : parseBotPeerEvidence(raw);
        if (result && (result.exchangeId !== exchangeId || result.kind !== kind)) throw new Error("The exchange evidence changed owner."); value = result;
      }
      current(); return value;
    } finally { detach(); controller.abort(); }
  });
}
