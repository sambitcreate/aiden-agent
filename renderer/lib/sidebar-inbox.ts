import type { ChatRowState } from "../shared/chat-row-state";

/**
 * Pure Inbox placement and ordering (docs/plans/inbox-sidebar-plan.md, "Status
 * model"). Nothing here reads React state, storage or the clock: callers pass
 * `now`, so the same inputs always give the same sections.
 */

export const INBOX_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const INBOX_EARLIER_LIMIT = 20;

export const INBOX_SECTIONS = ["needs_you", "pinned", "updates", "earlier", "working"] as const;
export type InboxSection = (typeof INBOX_SECTIONS)[number];
export type InboxShelf = InboxSection | "hidden";

/** Needs you tiers, most urgent first. */
export const INBOX_TIERS = {
  approval: 0,
  input: 1,
  failed: 2,
  /** A detached or interrupted local prompt. */
  unavailable: 3,
} as const;

export interface InboxSignals {
  rowState: ChatRowState;
  unread: boolean;
  /** The newest run failed (`lastAssistantFailed` / `lastRunFailed`). */
  failed: boolean;
  /** Local only, from `chats:pendingAttention`. */
  attention?: "detached" | "interrupted";
  /** The chat shown in the main pane. It never counts as unread. */
  isOpen: boolean;
  /** Always true for local chats. */
  hostOnline: boolean;
  updatedAt: number;
  lastAssistantAt?: number;
  attentionSince?: number;
  runStartedAt?: number;
  /** Phase 2. */
  pinnedAt?: number;
  /** Phase 2. */
  doneAt?: number;
  /** Phase 2. */
  snoozedUntil?: number;
}

export interface InboxPlacement {
  shelf: InboxShelf;
  /** The Needs you tier (see `INBOX_TIERS`); 0 on every other shelf. */
  tier: number;
  /** The time the row orders by within its shelf. */
  sortAt: number;
}

/** Where one chat belongs. The placement rules apply in the plan's order. */
export function inboxState(
  signals: Readonly<InboxSignals>,
  now: number,
  recentWindowMs: number = INBOX_RECENT_WINDOW_MS,
): InboxPlacement {
  const unread = signals.unread && !signals.isOpen;
  const needsYou = (tier: number): InboxPlacement => ({
    shelf: "needs_you",
    tier,
    sortAt: signals.attentionSince ?? signals.updatedAt,
  });
  // 1. A live prompt overrides Done and Snooze.
  if (signals.rowState === "needs_approval") return needsYou(INBOX_TIERS.approval);
  if (signals.rowState === "needs_input") return needsYou(INBOX_TIERS.input);
  // 2. Unseen output from a failed run (an idle chat, as in `sidebarAttention`).
  if (signals.rowState === "idle" && signals.failed && unread) return needsYou(INBOX_TIERS.failed);
  // 3. A local prompt that can no longer be answered where it was raised.
  if (signals.attention) return needsYou(INBOX_TIERS.unavailable);
  // 4. Running.
  if (signals.rowState === "working") {
    return { shelf: "working", tier: 0, sortAt: signals.runStartedAt ?? signals.updatedAt };
  }
  // 5. Done with no newer output, or snoozed.
  const hidden: InboxPlacement = { shelf: "hidden", tier: 0, sortAt: signals.updatedAt };
  if (signals.doneAt !== undefined && (signals.lastAssistantAt ?? Number.NEGATIVE_INFINITY) <= signals.doneAt) {
    return hidden;
  }
  if (signals.snoozedUntil !== undefined && signals.snoozedUntil > now) return hidden;
  // 6–8.
  if (signals.pinnedAt !== undefined) return { shelf: "pinned", tier: 0, sortAt: signals.pinnedAt };
  if (unread) return { shelf: "updates", tier: 0, sortAt: signals.lastAssistantAt ?? signals.updatedAt };
  // The open chat stays listed however old it is.
  if (signals.isOpen || now - signals.updatedAt <= recentWindowMs) {
    return { shelf: "earlier", tier: 0, sortAt: signals.updatedAt };
  }
  return hidden;
}

export interface InboxRow {
  /** `projectOrderKey(hostId, chatId)`: unique across hosts, and the tie-break. */
  key: string;
  signals: InboxSignals;
}

export interface InboxOptions {
  recentWindowMs?: number;
  earlierLimit?: number;
  /** Show more: list every Earlier row. */
  showAllEarlier?: boolean;
}

export interface InboxOrganization<Row extends InboxRow> {
  needsYou: Row[];
  pinned: Row[];
  updates: Row[];
  earlier: Row[];
  working: Row[];
  /** Rows on no shelf (done, snoozed, or older than the recent window). */
  hiddenCount: number;
  /** Earlier rows beyond the cap, reached through Show more. */
  earlierMoreCount: number;
  /** Needs you rows from online hosts: the count and badge total. */
  needsYouCount: number;
}

type Direction = "oldest" | "newest";

const SECTION_DIRECTION: Readonly<Record<InboxSection, Direction>> = {
  needs_you: "oldest",
  pinned: "newest",
  updates: "newest",
  earlier: "newest",
  working: "oldest",
};

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort each shelf by its rule, ties by key, and cap Earlier. Linear plus one sort per shelf. */
export function organizeInbox<Row extends InboxRow>(
  rows: readonly Row[],
  now: number,
  options: InboxOptions = {},
): InboxOrganization<Row> {
  const recentWindowMs = options.recentWindowMs ?? INBOX_RECENT_WINDOW_MS;
  const earlierLimit = Math.max(0, options.earlierLimit ?? INBOX_EARLIER_LIMIT);
  const buckets: Record<InboxSection, { row: Row; placement: InboxPlacement }[]> = {
    needs_you: [],
    pinned: [],
    updates: [],
    earlier: [],
    working: [],
  };
  let hiddenCount = 0;
  let needsYouCount = 0;
  for (const row of rows) {
    const placement = inboxState(row.signals, now, recentWindowMs);
    if (placement.shelf === "hidden") {
      hiddenCount += 1;
      continue;
    }
    if (placement.shelf === "needs_you" && row.signals.hostOnline) needsYouCount += 1;
    buckets[placement.shelf].push({ row, placement });
  }
  const sorted = (section: InboxSection): Row[] => {
    const sign = SECTION_DIRECTION[section] === "oldest" ? 1 : -1;
    return buckets[section]
      .sort((a, b) =>
        a.placement.tier - b.placement.tier ||
        sign * (a.placement.sortAt - b.placement.sortAt) ||
        compareKeys(a.row.key, b.row.key))
      .map((entry) => entry.row);
  };
  const earlierAll = sorted("earlier");
  const earlier = options.showAllEarlier ? earlierAll : earlierAll.slice(0, earlierLimit);
  return {
    needsYou: sorted("needs_you"),
    pinned: sorted("pinned"),
    updates: sorted("updates"),
    earlier,
    working: sorted("working"),
    hiddenCount,
    earlierMoreCount: earlierAll.length - earlier.length,
    needsYouCount,
  };
}

/** Row keys per section, in display order. */
export type InboxDisplayOrder = Readonly<Record<InboxSection, readonly string[]>>;

export interface HeldInboxRow {
  key: string;
  /** The row left the list during the freeze; it holds its slot, dimmed. */
  leaving: boolean;
  /** Set when the row now belongs to a different section than the one holding it. */
  liveSection?: InboxSection;
}

export type HeldInboxOrder = Readonly<Record<InboxSection, readonly HeldInboxRow[]>>;

export function inboxDisplayOrder(organization: InboxOrganization<InboxRow>): InboxDisplayOrder {
  const keys = (rows: readonly InboxRow[]) => rows.map((row) => row.key);
  return {
    needs_you: keys(organization.needsYou),
    pinned: keys(organization.pinned),
    updates: keys(organization.updates),
    earlier: keys(organization.earlier),
    working: keys(organization.working),
  };
}

/** The live order with nothing held: the state right after a freeze releases. */
export function releasedInboxOrder(next: InboxDisplayOrder): HeldInboxOrder {
  const held = (keys: readonly string[]) => keys.map((key) => ({ key, leaving: false }));
  return {
    needs_you: held(next.needs_you),
    pinned: held(next.pinned),
    updates: held(next.updates),
    earlier: held(next.earlier),
    working: held(next.working),
  };
}

export interface FreezeInboxInput {
  /** What is on screen now. */
  previous: HeldInboxOrder;
  /** The live order just computed. */
  next: InboxDisplayOrder;
  /** Rows the person just acted on (opened, Mark read): placed live. */
  touched: ReadonlySet<string>;
  /**
   * Every row key that still exists, listed or not. A held row missing from it
   * was deleted (or its workspace removed) and goes at once.
   */
  present: ReadonlySet<string>;
}

/**
 * The order to show while the list is frozen under the pointer or focus:
 * held rows keep their slots, new rows join the end of their section, rows the
 * person touched move to their live place, and deleted rows go at once.
 */
export function freezeInboxOrder(input: FreezeInboxInput): HeldInboxOrder {
  const liveSection = new Map<string, InboxSection>();
  for (const section of INBOX_SECTIONS) {
    for (const key of input.next[section]) liveSection.set(key, section);
  }
  const lists = {} as Record<InboxSection, HeldInboxRow[]>;
  const held = new Set<string>();
  for (const section of INBOX_SECTIONS) {
    lists[section] = [];
    for (const row of input.previous[section]) {
      if (!input.present.has(row.key) || input.touched.has(row.key) || held.has(row.key)) continue;
      const live = liveSection.get(row.key);
      held.add(row.key);
      lists[section].push(live === undefined
        ? { key: row.key, leaving: true }
        : live === section
          ? { key: row.key, leaving: false }
          : { key: row.key, leaving: false, liveSection: live });
    }
  }
  for (const section of INBOX_SECTIONS) {
    const list = lists[section];
    const appended: HeldInboxRow[] = [];
    const order = input.next[section];
    order.forEach((key, index) => {
      if (held.has(key)) return;
      if (!input.touched.has(key)) {
        appended.push({ key, leaving: false });
        return;
      }
      // Place after the nearest row that precedes it in the live order and is on screen.
      let at = 0;
      for (let previous = index - 1; previous >= 0; previous -= 1) {
        const found = list.findIndex((row) => row.key === order[previous]);
        if (found >= 0) {
          at = found + 1;
          break;
        }
      }
      list.splice(at, 0, { key, leaving: false });
      held.add(key);
    });
    list.push(...appended);
  }
  return lists;
}
