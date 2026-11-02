
import {
  INBOX_RECENT_WINDOW_MS,
  INBOX_SECTIONS,
  inboxState,
  type InboxPlacement,
  type InboxSection,
  type InboxSignals,
} from "../shared/inbox-state";

/**
 * Pure Inbox ordering (docs/plans/inbox-sidebar-plan.md, "Status model"). One
 * row's placement lives in `renderer/shared/inbox-state.ts`, which the Dock
 * badge shares. Nothing here reads React state, storage or the clock: callers
 * pass `now`, so the same inputs always give the same sections.
 */

export {
  INBOX_RECENT_WINDOW_MS,
  INBOX_SECTIONS,
  INBOX_TIERS,
  inboxState,
  inboxTriageHold,
  type InboxPlacement,
  type InboxSection,
  type InboxShelf,
  type InboxSignals,
} from "../shared/inbox-state";

export const INBOX_EARLIER_LIMIT = 20;

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
  /** Search: list Done and snoozed chats too (see `inboxState`). */
  includeTriaged?: boolean;
}

export interface InboxOrganization<Row extends InboxRow> {
  needsYou: Row[];
  pinned: Row[];
  updates: Row[];
  earlier: Row[];
  working: Row[];
  /** Rows on no shelf (done, snoozed, or older than the recent window). */
  hiddenCount: number;
  /** Earlier rows beyond the cap, newest first, reached through Show more. */
  earlierOverflow: Row[];
  /** `earlierOverflow.length`. */
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
    const placement = inboxState(row.signals, now, recentWindowMs, options.includeTriaged);
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
  const { shown: earlier, overflow: earlierOverflow } = capEarlier(sorted("earlier"), options.showAllEarlier ? Infinity : earlierLimit);
  return {
    needsYou: sorted("needs_you"),
    pinned: sorted("pinned"),
    updates: sorted("updates"),
    earlier,
    working: sorted("working"),
    hiddenCount,
    earlierOverflow,
    earlierMoreCount: earlierOverflow.length,
    needsYouCount,
  };
}

/**
 * The first `limit` Earlier rows. An open chat that would fall past the cap
 * takes the last visible slot instead, so the list never hides the chat in the
 * main pane and never grows past the cap. It is the oldest row shown, so the
 * newest-first order holds.
 */
function capEarlier<Row extends InboxRow>(all: Row[], limit: number): { shown: Row[]; overflow: Row[] } {
  if (all.length <= limit) return { shown: all, overflow: [] };
  const openPastCap = limit > 0 ? all.slice(limit).filter((row) => row.signals.isOpen) : [];
  const kept = Math.max(0, limit - openPastCap.length);
  const shown = [...all.slice(0, kept), ...openPastCap];
  const listed = new Set(shown);
  return { shown, overflow: all.filter((row) => !listed.has(row)) };
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
  /**
   * Live Earlier rows past the cap (`earlierOverflow` keys). A held row that
   * merely fell past the cap is still in Earlier: it keeps its slot, not dimmed.
   */
  earlierOverflow?: readonly string[];
  /**
   * The cap `organizeInbox` used; omit when Show more lists every row. The
   * frozen Earlier stays within it by leaving new arrivals, then rows past the
   * cap, for Show more (see `heldEarlierMoreCount`).
   */
  earlierLimit?: number;
}

/**
 * The order to show while the list is frozen under the pointer or focus:
 * held rows keep their slots, new rows join the end of their section, rows the
 * person touched move to their live place, and deleted rows go at once.
 */
export function freezeInboxOrder(input: FreezeInboxInput): HeldInboxOrder {
  const overflow = new Set(input.earlierOverflow ?? []);
  const liveSection = new Map<string, InboxSection>();
  for (const key of overflow) liveSection.set(key, "earlier");
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
    if (section === "earlier" && input.earlierLimit !== undefined) {
      const limit = Math.max(0, input.earlierLimit);
      const arrived = new Set(appended.map((row) => row.key));
      dropFromEnd(list, limit, (row) => arrived.has(row.key));
      dropFromEnd(list, limit, (row) => overflow.has(row.key) && !input.touched.has(row.key));
    }
  }
  return lists;
}

function dropFromEnd(list: HeldInboxRow[], limit: number, droppable: (row: HeldInboxRow) => boolean): void {
  for (let index = list.length - 1; index >= 0 && list.length > limit; index -= 1) {
    if (droppable(list[index]!)) list.splice(index, 1);
  }
}

/**
 * Show more's count while frozen: live Earlier rows (shown and past the cap)
 * that the held order does not show anywhere. Without a freeze it equals
 * `earlierMoreCount`.
 */
export function heldEarlierMoreCount(
  held: HeldInboxOrder,
  live: { earlier: readonly string[]; earlierOverflow: readonly string[] },
): number {
  const shown = new Set<string>();
  for (const section of INBOX_SECTIONS) {
    for (const row of held[section]) if (!row.leaving) shown.add(row.key);
  }
  let count = 0;
  for (const key of [...live.earlier, ...live.earlierOverflow]) if (!shown.has(key)) count += 1;
  return count;
}
