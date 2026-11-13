/** A Bot page reached from its Profile; `/bots/$botId?page=advanced` opens Advanced directly. */
export type BotSubpage = "instructions" | "advanced" | "memory" | "interruptions" | "learning" | "open-work" | "allowed";

const SUBPAGES: ReadonlySet<string> = new Set<BotSubpage>(["instructions", "advanced", "memory", "interruptions", "learning", "open-work", "allowed"]);

export function parseBotPageSearch(search: Record<string, unknown>): { page?: BotSubpage } {
  // The per-Bot Chat activity page is gone (Show tool activity in Settings →
  // Appearance replaced it); an old link opens Advanced, where it used to be.
  if (search.page === "chat-activity") return { page: "advanced" };
  return typeof search.page === "string" && SUBPAGES.has(search.page) ? { page: search.page as BotSubpage } : {};
}
