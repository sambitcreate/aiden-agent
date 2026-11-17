import { parseSpendingStatusView, parseSpendingLimitUsd, type SpendingStatusView } from "../../renderer/shared/spending.js";

function owner(kind: unknown, id: unknown): { kind: "chat" | "bot"; id: string } {
  if ((kind !== "chat" && kind !== "bot") || typeof id !== "string" || !id || id.length > 200) {
    throw new Error("Invalid spending request.");
  }
  return { kind, id };
}

/** A chat's or Bot's spending, "Allow more", and a Bot's own monthly limit. */
export function registerSpendingHandlers<Event>(dependencies: {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  spending: {
    status(kind: "chat" | "bot", id: string): Promise<SpendingStatusView | undefined>;
    allowMoreIf(kind: "chat" | "bot", id: string, current: (view: SpendingStatusView) => boolean): Promise<{ view: SpendingStatusView | undefined }>;
    ownBotLimit(botId: string): Promise<number | null | undefined>;
    setBotLimit(botId: string, limit: number | null | undefined): Promise<SpendingStatusView | undefined>;
  };
}): void {
  dependencies.handle("spending:status", async (_event, kind, id) => {
    const target = owner(kind, id);
    return (await dependencies.spending.status(target.kind, target.id)) ?? null;
  });
  dependencies.handle("spending:allowMore", async (_event, kind, id, notice) => {
    const target = owner(kind, id);
    const shown = parseSpendingStatusView(notice);
    if (!shown || shown.ownerKind !== target.kind || shown.ownerId !== target.id) throw new Error("Invalid spending notice.");
    const { view } = await dependencies.spending.allowMoreIf(target.kind, target.id, (current) =>
      current.period === shown.period && current.periodStart === shown.periodStart &&
      current.limitUsd === shown.limitUsd && current.extraUsd === shown.extraUsd,
    );
    return view ?? null;
  });
  dependencies.handle("spending:botLimit", async (_event, botId) => {
    const target = owner("bot", botId);
    const limit = await dependencies.spending.ownBotLimit(target.id);
    return limit === undefined ? { kind: "default" } : limit === null ? { kind: "none" } : { kind: "amount", usd: limit };
  });
  dependencies.handle("spending:setBotLimit", async (_event, botId, choice) => {
    const target = owner("bot", botId);
    let limit: number | null | undefined;
    if (choice === "default") limit = undefined;
    else if (choice === null) limit = null;
    else {
      limit = parseSpendingLimitUsd(choice);
      if (limit === undefined) throw new Error("Invalid spending limit.");
    }
    await dependencies.spending.setBotLimit(target.id, limit);
    return limit === undefined ? { kind: "default" } : limit === null ? { kind: "none" } : { kind: "amount", usd: limit };
  });
}
