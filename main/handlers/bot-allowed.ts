import type { BotAllowList } from "../services/bot-runtime/bot-allow-list.js";
import type { BotApprovals } from "../services/bot-runtime/bot-approvals.js";
import { parseBotAllowedList, parseBotAllowedRemove, parseBotApprovalDecision } from "./bot-params.js";

/** Main owns the entries and checks Bot identity before an individual read or removal. */
export function registerBotAllowedHandlers<Event = unknown>(deps: {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  allowed: Pick<BotAllowList, "list" | "remove">;
  onChange(listener: (botId: string) => void): () => void;
  botExists(botId: string): Promise<boolean>;
  broadcast(channel: "bots:allowed:changed", payload: { botId: string }): void;
}): () => void {
  const known = async (botId: string) => {
    if (!await deps.botExists(botId)) throw new Error("This Bot no longer exists.");
  };
  deps.handle("bots:allowed:list", async (_event, input) => {
    const botId = parseBotAllowedList(input);
    if (botId !== undefined) await known(botId);
    return deps.allowed.list(botId);
  });
  deps.handle("bots:allowed:remove", async (_event, input) => {
    const { botId, entryId } = parseBotAllowedRemove(input);
    await known(botId);
    return { removed: await deps.allowed.remove(botId, entryId) };
  });
  return deps.onChange(botId => deps.broadcast("bots:allowed:changed", { botId }));
}

/** This acknowledges a choice. Persistence happens later in the owning tool task. */
export function registerBotApprovalDecisionHandler<Event = unknown>(deps: {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  approvals: Pick<BotApprovals, "decide">;
}): void {
  deps.handle("bots:approve", async (_event, input) => {
    const { waitId, decision, scope } = parseBotApprovalDecision(input);
    return { decided: deps.approvals.decide(waitId, decision, scope) };
  });
}
