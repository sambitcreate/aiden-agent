/** A Bot page reached from its Profile; `/bots/$botId?page=advanced` opens Advanced directly. */
export type BotSubpage = "instructions" | "advanced";

export function parseBotPageSearch(search: Record<string, unknown>): { page?: BotSubpage } {
  return search.page === "instructions" || search.page === "advanced" ? { page: search.page } : {};
}
