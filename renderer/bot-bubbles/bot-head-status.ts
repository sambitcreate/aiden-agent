// What a closed head shows about its Bot: the photo or face, whether it is
// working, whether it needs the person, how many replies they haven't seen, and
// the latest line for the hover peek. The rules are the Bots sidebar's: the
// live summary decides working and Needs you, and a reply newer than the
// seen-reply watermark (shared across windows through localStorage) is unread.

import { useBot } from "../lib/queries";
import { useBotLive } from "../lib/use-bot-live";
import { botLastReplyAt, botTranscriptPreview, type BotLiveSnapshot, type BotTranscriptEntry } from "../shared/bot-live";
import type { BotDefinition } from "../shared/bots";
import { botRowLine, useBotLiveSummary } from "../main/bots/bot-sidebar-rows";
import { useBotSidebarPreferences } from "../main/bots/use-bot-sidebar-preferences";

export interface BotHeadStatus {
  bot: BotDefinition | null;
  name: string;
  working: boolean;
  needsYou: boolean;
  /** Replies newer than the seen watermark; null when unread is known but not how many (an older summary without reply times). */
  unreadCount: number | null;
  unread: boolean;
  /** One line for the peek: waiting, working, a status, or the latest message. */
  line: string | null;
}

/**
 * How many replies the person hasn't seen: the replies after the newest one
 * they saw, counted only when the sidebar would call the Bot unread (its newest
 * person-facing reply is newer than the watermark), so the count and the dot agree.
 */
export function botUnreadReplyCount(entries: readonly BotTranscriptEntry[], seenAt: number): number {
  const newest = botLastReplyAt(entries);
  if (newest === null || newest <= seenAt) return 0;
  const count = entries.filter(
    (entry) => entry.type === "assistant" && entry.text.trim() !== "" && entry.at !== undefined && entry.at > seenAt,
  ).length;
  return Math.max(1, count);
}

/** Needs you, from what the live feed itself shows (the summary adds tool approvals and issues). */
function snapshotNeedsYou(snapshot: BotLiveSnapshot): boolean {
  return Boolean(
    snapshot.question ||
      snapshot.handoff ||
      snapshot.accessRequest ||
      snapshot.plan?.status === "pending" ||
      snapshot.entries.some((entry) => entry.type === "issue" && entry.status === "open"),
  );
}

/**
 * One head's status. `live` subscribes to the Bot's feed; leave it off where a
 * subscription would make main think the chat is on screen (the Aiden window,
 * whose focus counts for every Bot it subscribes to). Without it the unread
 * count comes from the summary's recent reply times.
 * `viewing` is set while this Bot's mini chat is open: it has nothing unread.
 */
export function useBotHeadStatus(botId: string, { live, viewing }: { live: boolean; viewing: boolean }): BotHeadStatus {
  const bot = useBot(botId);
  const summary = useBotLiveSummary(botId);
  const feed = useBotLive(live ? botId : undefined);
  const { preferences } = useBotSidebarPreferences();
  const snapshot = feed.snapshot;
  const state = snapshot?.state ?? summary.data?.state;
  const needsYou = (summary.data?.needsYou ?? false) || (snapshot ? snapshotNeedsYou(snapshot) : false);
  const seenAt = preferences.seenReplyAt[botId] ?? preferences.since;
  let unreadCount: number | null = 0;
  if (!viewing) {
    if (snapshot) unreadCount = botUnreadReplyCount(snapshot.entries, seenAt);
    else {
      // No feed (heads in the Aiden window): count from the summary's reply times.
      const lastReplyAt = summary.data?.lastReplyAt ?? null;
      const recent = summary.data?.recentReplyAt;
      unreadCount =
        lastReplyAt === null || lastReplyAt <= seenAt
          ? 0
          : recent
            ? Math.max(1, recent.filter((at) => at > seenAt).length)
            : null;
    }
  }
  const preview = snapshot ? (botTranscriptPreview(snapshot.entries)?.text ?? null) : (summary.data?.preview ?? null);
  const definition = bot.data ?? null;
  const line = definition
    ? botRowLine({
        bot: definition,
        ...(state ? { state } : {}),
        ...(preview ? { preview } : {}),
        activityAt: 0,
        needsYou,
        lastReplyAt: null,
      })?.text ?? null
    : null;
  return {
    bot: definition,
    name: definition?.name ?? "Bot",
    working: state?.kind === "running",
    needsYou,
    unreadCount,
    unread: unreadCount === null || unreadCount > 0,
    line,
  };
}

/** The head's accessible name, e.g. "Penny, 2 unread, needs you. Enter opens, Delete closes." */
export function botHeadLabel(status: Pick<BotHeadStatus, "name" | "unread" | "unreadCount" | "needsYou" | "working">): string {
  const parts = [status.name];
  if (status.unread) parts.push(status.unreadCount === null ? "unread" : `${status.unreadCount} unread`);
  if (status.needsYou) parts.push("needs you");
  if (status.working) parts.push("working");
  return `${parts.join(", ")}. Enter opens, Delete closes.`;
}
