// `/bots/$botId?page=…` (plan §4.4). The Profile and Advanced pages are gone:
// a Bot's settings live in its side panel's Advanced tab, so an old link opens
// the Bot's chat with the panel on the right tab or dialog. Open work and What
// I've learned are still pages of their own.

import type { BotAdvancedSection } from "./bot-panel-context";

export type BotSubpage =
  | "profile"
  | "instructions"
  | "advanced"
  | "memory"
  | "interruptions"
  | "learning"
  | "open-work"
  | "allowed";

const SUBPAGES: ReadonlySet<string> = new Set<BotSubpage>([
  "profile",
  "instructions",
  "advanced",
  "memory",
  "interruptions",
  "learning",
  "open-work",
  "allowed",
]);

export function parseBotPageSearch(search: Record<string, unknown>): { page?: BotSubpage } {
  // The per-Bot Chat activity page is gone (Show tool activity in Settings →
  // Appearance replaced it); an old link opens Advanced, where it used to be.
  if (search.page === "chat-activity") return { page: "advanced" };
  return typeof search.page === "string" && SUBPAGES.has(search.page) ? { page: search.page as BotSubpage } : {};
}

/** Where a `/bots/$botId` link goes now. */
export type BotPageTarget =
  | { kind: "page"; page: "open-work" | "learning" }
  | { kind: "panel"; tab: "advanced" | "memory"; section?: BotAdvancedSection }
  | { kind: "settings"; section: "approvals" };

export function botPageTarget(page: BotSubpage | undefined): BotPageTarget {
  switch (page) {
    case "open-work":
    case "learning":
      return { kind: "page", page };
    case "memory":
      return { kind: "panel", tab: "memory" };
    case "instructions":
      return { kind: "panel", tab: "advanced", section: "instructions" };
    case "interruptions":
      return { kind: "panel", tab: "advanced", section: "quiet-hours" };
    // The old "Allowed without asking" page is Settings → Approvals.
    case "allowed":
      return { kind: "settings", section: "approvals" };
    // The Profile, Advanced and (through the parser) Chat activity.
    default:
      return { kind: "panel", tab: "advanced" };
  }
}
