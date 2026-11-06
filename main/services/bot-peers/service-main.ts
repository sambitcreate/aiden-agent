import type { BotPeerSettings, BotPeerCatalog, BotPeerMutation, BotPeerMutationResult, BotPeerExchangeList, BotPeerExchangeDetail, BotPeerStopMutation, BotPeerStopResult, BotPeerEvidence } from "../../../renderer/shared/bot-peers.js";
export interface BotPeerLifetime { signal: AbortSignal; assertCurrent(): void | Promise<void> }
export interface BotPeerOwnerService {
  isReady?(): boolean;
  settings(botId: string): Promise<BotPeerSettings>;
  catalog(botId: string): Promise<BotPeerCatalog>;
  mutate(botId: string, command: BotPeerMutation, lifetime: BotPeerLifetime): Promise<BotPeerMutationResult>;
  exchanges(botId: string): Promise<BotPeerExchangeList>;
  exchange(botId: string, exchangeId: string): Promise<BotPeerExchangeDetail | undefined>;
  stop(botId: string, exchangeId: string, command: BotPeerStopMutation, lifetime: BotPeerLifetime): Promise<BotPeerStopResult>;
  evidence(botId: string, exchangeId: string, kind: "source" | "result"): Promise<BotPeerEvidence | undefined>;
}
let host: BotPeerOwnerService | undefined;
/** Installed by the owning host after its protected stores and runtime ports are ready. */
export function installBotPeerHost(service: BotPeerOwnerService): void { if (host && host !== service) throw new Error("The peer host is already installed."); host = service; }
function current(): BotPeerOwnerService { if (!host) throw new Error("Bot messaging is not ready on this host."); return host; }
/** Public owner ports stay closed until the complete host is installed. */
export const botPeers: BotPeerOwnerService = {
  isReady: () => host !== undefined,
  settings: (botId) => current().settings(botId), catalog: (botId) => current().catalog(botId),
  mutate: (botId, command, lifetime) => current().mutate(botId, command, lifetime),
  exchanges: (botId) => current().exchanges(botId), exchange: (botId, id) => current().exchange(botId, id),
  stop: (botId, id, command, lifetime) => current().stop(botId, id, command, lifetime),
  evidence: (botId, id, kind) => current().evidence(botId, id, kind),
};

// Pure composition installs all ports; initialization and any reconciliation stay lazy.
import { botPeerHost } from "./host-main.js";
installBotPeerHost(botPeerHost);
