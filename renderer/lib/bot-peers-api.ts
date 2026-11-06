import {
  parseBotPeerSettings, parseBotPeerCatalog, parseBotPeerMutation, parseBotPeerMutationResult,
  parseBotPeerExchangeList, parseBotPeerExchangeDetail, parseBotPeerStopMutation, parseBotPeerStopResult, parseBotPeerEvidence,
  type BotPeerMutation, type BotPeerStopMutation, type BotPeerExchangeDetail,
} from "../shared/bot-peers";

function exchangeOwner(botId: string, exchangeId: string, value: BotPeerExchangeDetail): void {
  if (value.id !== exchangeId || (value.direction === "sent" ? value.sender : value.recipient).botId !== botId) throw new Error("The exchange belongs to another Bot.");
}

/** Closed owner controls. Messages and delegation provenance have no IPC ingress. */
export function createBotPeerApi(invoke: (channel: string, input: unknown) => Promise<unknown>) {
  return {
    settings: async (botId: string) => {
      const result = parseBotPeerSettings(await invoke("bots:peers:settings", { botId }));
      if (result.botId !== botId) throw new Error("The pair settings belong to another Bot."); return result;
    },
    catalog: async (botId: string) => {
      const result = parseBotPeerCatalog(await invoke("bots:peers:catalog", { botId }));
      if (result.botId !== botId) throw new Error("The pair catalog belongs to another Bot."); return result;
    },
    mutate: async (input: BotPeerMutation) => {
      const command = parseBotPeerMutation(input), result = parseBotPeerMutationResult(await invoke("bots:peers:mutate", command));
      if (result.ok && result.mutationId !== command.mutationId || result.snapshot && result.snapshot.botId !== command.botId) throw new Error("The pair decision receipt changed."); return result;
    },
    exchanges: async (botId: string) => {
      const result = parseBotPeerExchangeList(await invoke("bots:peers:exchanges", { botId }));
      if (result.botId !== botId) throw new Error("The exchange list belongs to another Bot."); return result;
    },
    exchange: async (botId: string, exchangeId: string) => {
      const raw = await invoke("bots:peers:exchange", { botId, exchangeId });
      if (raw === null) return null;
      const result = parseBotPeerExchangeDetail(raw); exchangeOwner(botId, exchangeId, result); return result;
    },
    stop: async (input: BotPeerStopMutation) => {
      const command = parseBotPeerStopMutation(input), result = parseBotPeerStopResult(await invoke("bots:peers:stop", command));
      if (result.ok && result.mutationId !== command.mutationId) throw new Error("The Stop decision receipt changed.");
      if (result.exchange) exchangeOwner(command.botId, command.exchangeId, result.exchange); return result;
    },
    evidence: async (botId: string, exchangeId: string, kind: "source" | "result") => {
      const raw = await invoke("bots:peers:evidence", { botId, exchangeId, kind });
      if (raw === null) return null;
      const result = parseBotPeerEvidence(raw);
      if (result.exchangeId !== exchangeId || result.kind !== kind) throw new Error("The exchange evidence changed."); return result;
    },
  };
}
