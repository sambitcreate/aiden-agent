/** A Bot page reached from its Profile; `/bots/$botId?page=advanced` opens Advanced directly. */
export type BotSubpage = "instructions" | "advanced" | "memory" | "chat-activity" | "interruptions" | "learning";

const SUBPAGES: ReadonlySet<string> = new Set<BotSubpage>(["instructions", "advanced", "memory", "chat-activity", "interruptions", "learning"]);

export function parseBotPageSearch(search: Record<string, unknown>): { page?: BotSubpage } {
  return typeof search.page === "string" && SUBPAGES.has(search.page) ? { page: search.page as BotSubpage } : {};
}
