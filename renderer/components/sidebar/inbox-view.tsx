import * as React from "react";
import { EmptyState, SidebarListItem } from "../ui";
import { SectionHeader } from "./section-header";
import { prefersReducedMotion } from "../../lib/appearance-runtime";
import { useWorkingShelfCollapsed } from "../../lib/use-sidebar-view";
import {
  freezeInboxOrder,
  heldEarlierMoreCount,
  inboxDisplayOrder,
  inboxState,
  INBOX_EARLIER_LIMIT,
  organizeInbox,
  releasedInboxOrder,
  type HeldInboxOrder,
  type HeldInboxRow,
  type InboxSection,
} from "../../lib/sidebar-inbox";
import {
  debounceNeedsYouLeave,
  inboxRowDescription,
  inboxRowStatus,
  inboxShortcutOrder,
  type InboxEntry,
  type InboxRowStatus,
} from "../../lib/sidebar-inbox-view";

/**
 * The Inbox sidebar view (docs/plans/inbox-sidebar-plan.md, Phase 1b): Needs
 * you, Updates and Earlier, then the collapsible Working shelf. The list holds
 * still while the person uses it (see `useListInUse`), and rows slide when they
 * move outside a freeze.
 */

export interface InboxRowContext {
  /** The section showing the row. */
  section: InboxSection;
  /** Line 1's status, from the row's live state. */
  status: InboxRowStatus;
  /** The tooltip and `aria-description`. */
  description?: string;
  /** Held in place after it left, or its host isn't online. */
  dimmed: boolean;
  /** Places the row live at once, even while the list is frozen. */
  touch: () => void;
}

export interface InboxViewProps {
  /** Rows already narrowed by search and the machine filter. */
  entries: readonly InboxEntry[];
  /**
   * Every row key that still exists, listed or not. A held row missing from it
   * was deleted and goes at once. Defaults to the entries' keys.
   */
  present?: ReadonlySet<string>;
  /** Search reaches past the recent window and the Earlier cap, and never freezes. */
  searching?: boolean;
  /** A change (search, machine filter) re-lays the list at once, without animation. */
  resetKey?: string;
  /** The open chat's key. Opening a row places it live. */
  activeKey?: string | null;
  /** Beside the Inbox label: the Beta pill and the machine filter chip. */
  headerAccessory?: React.ReactNode;
  /** The header's trailing controls: the Organize menu. */
  headerActions?: React.ReactNode;
  renderRow: (entry: InboxEntry, context: InboxRowContext) => React.ReactNode;
  /** ⌘1–9 and previous/next: the visible rows' keys in on-screen order. */
  onShortcutOrderChange?: (keys: readonly string[]) => void;
  /** The clock, for tests. */
  now?: () => number;
}

/** Durations on line 1 tick at this pace. */
const CLOCK_TICK_MS = 30_000;
const FLIP_DURATION_MS = 150;
const FLIP_MAX_OFFSET_PX = 40;
const FLIP_MAX_ROWS = 40;
const OVERLAY_SELECTOR = '[role="menu"], [role="dialog"], [role="alertdialog"]';

const MAIN_SECTIONS = [
  { id: "needs_you", label: "Needs you" },
  { id: "updates", label: "Updates" },
  { id: "earlier", label: "Earlier" },
] as const satisfies readonly { id: InboxSection; label: string }[];

function matchesFocusVisible(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (document.documentElement.dataset.inputModality === "pointer") return false;
  try {
    return target.matches(":focus-visible");
  } catch {
    return false;
  }
}

function overlayOpen(): boolean {
  return typeof document !== "undefined" && document.querySelector(OVERLAY_SELECTOR) !== null;
}

function windowIsActive(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/**
 * The list is in use while the pointer is over it, keyboard focus is inside
 * it, or a menu or dialog is open. Window blur or a hidden window releases it.
 */
function useListInUse(ref: React.RefObject<HTMLElement | null>) {
  const [pointerInside, setPointerInside] = React.useState(false);
  const [focusInside, setFocusInside] = React.useState(false);
  const [overlay, setOverlay] = React.useState(overlayOpen);
  const [windowActive, setWindowActive] = React.useState(windowIsActive);

  React.useEffect(() => {
    const onBlur = () => setWindowActive(false);
    const onFocus = () => setWindowActive(windowIsActive());
    const onVisibility = () => setWindowActive(windowIsActive() && (document.hasFocus?.() ?? true));
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    // Menus and dialogs mount in portals directly under <body>.
    const observer = typeof MutationObserver === "function"
      ? new MutationObserver(() => setOverlay(overlayOpen()))
      : null;
    observer?.observe(document.body, { childList: true });
    // The menu that switched the sidebar to the Inbox can close between the
    // first render and this effect, with no mutation left to report it.
    setOverlay(overlayOpen());
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      observer?.disconnect();
    };
  }, []);

  const handlers = {
    onPointerEnter: () => setPointerInside(true),
    onPointerLeave: () => setPointerInside(false),
    onFocus: (event: React.FocusEvent) => setFocusInside(matchesFocusVisible(event.target)),
    onBlur: (event: React.FocusEvent) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !ref.current?.contains(next)) setFocusInside(false);
    },
  };
  return { inUse: windowActive && (pointerInside || focusInside || overlay), handlers };
}

/** The `[data-sidebar]` height, for the Working shelf's 40% cap. */
function useSidebarHeight(ref: React.RefObject<HTMLElement | null>): number | null {
  const [height, setHeight] = React.useState<number | null>(null);
  React.useEffect(() => {
    const sidebar = ref.current?.closest<HTMLElement>("[data-sidebar]");
    if (!sidebar || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => setHeight(sidebar.clientHeight || null));
    observer.observe(sidebar);
    setHeight(sidebar.clientHeight || null);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}

/** The section a row's status reads from: where its live state places it. */
function liveStatusSection(entry: InboxEntry, now: number): InboxSection {
  const { shelf } = inboxState(entry.signals, now, Number.POSITIVE_INFINITY);
  return shelf === "hidden" || shelf === "pinned" ? "earlier" : shelf;
}

export function InboxView({
  entries,
  present: presentProp,
  searching = false,
  resetKey = "",
  activeKey = null,
  headerAccessory,
  headerActions,
  renderRow,
  onShortcutOrderChange,
  now: clock = Date.now,
}: InboxViewProps) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const shelfRef = React.useRef<HTMLDivElement>(null);
  const [, tick] = React.useReducer((count: number) => count + 1, 0);
  const [showAllEarlier, setShowAllEarlier] = React.useState(false);
  const [touched, setTouched] = React.useState<ReadonlySet<string>>(() => new Set());
  const { collapsed: workingCollapsed, setCollapsed: setWorkingCollapsed } = useWorkingShelfCollapsed();
  const { inUse, handlers } = useListInUse(rootRef);
  const sidebarHeight = useSidebarHeight(rootRef);
  const frozen = inUse && !searching;

  React.useEffect(() => {
    const interval = window.setInterval(tick, CLOCK_TICK_MS);
    return () => window.clearInterval(interval);
  }, []);

  // Opening a row (click, Enter, ⌘1–9 or any other route) places it live.
  React.useEffect(() => {
    if (activeKey) setTouched((current) => (current.has(activeKey) ? current : new Set(current).add(activeKey)));
  }, [activeKey]);

  const heldRef = React.useRef<HeldInboxOrder | null>(null);
  const shownNeedsYouRef = React.useRef<readonly string[]>([]);
  const leftAtRef = React.useRef<ReadonlyMap<string, number>>(new Map());
  const resetRef = React.useRef<string | null>(null);
  const lastEntriesRef = React.useRef<ReadonlyMap<string, InboxEntry>>(new Map());
  const offlineSinceRef = React.useRef(new Map<string, number>());
  const wasFrozenRef = React.useRef(false);

  const now = clock();
  const fullResetKey = `${resetKey}\u0000${showAllEarlier ? "all" : "capped"}\u0000${searching ? "search" : ""}`;
  const reset = resetRef.current !== fullResetKey;
  const entryByKey = new Map(entries.map((entry) => [entry.key, entry] as const));
  const present = presentProp ?? new Set(entryByKey.keys());
  const organization = organizeInbox(
    entries,
    now,
    searching ? { recentWindowMs: Number.POSITIVE_INFINITY, showAllEarlier: true } : { showAllEarlier },
  );
  const live = inboxDisplayOrder(organization);
  const earlierOverflow = organization.earlierOverflow.map((row) => row.key);
  const debounced = debounceNeedsYouLeave({
    previous: reset ? [] : shownNeedsYouRef.current,
    next: live,
    leftAt: reset ? new Map() : leftAtRef.current,
    present,
    touched,
    now,
  });
  const held: HeldInboxOrder = frozen && !reset && heldRef.current
    ? freezeInboxOrder({
        previous: heldRef.current,
        next: debounced.order,
        touched,
        present,
        earlierOverflow,
        ...(showAllEarlier || searching ? {} : { earlierLimit: INBOX_EARLIER_LIMIT }),
      })
    : releasedInboxOrder(debounced.order);
  const releasing = wasFrozenRef.current && !frozen;
  const moreCount = searching || showAllEarlier
    ? 0
    : heldEarlierMoreCount(held, { earlier: live.earlier, earlierOverflow });

  // A host that isn't online stops its rows' clocks where it dropped.
  const offlineSince = offlineSinceRef.current;
  const offlineHosts = new Set(entries.filter((entry) => !entry.signals.hostOnline).map((entry) => entry.hostId));
  for (const hostId of [...offlineSince.keys()]) if (!offlineHosts.has(hostId)) offlineSince.delete(hostId);
  for (const hostId of offlineHosts) if (!offlineSince.has(hostId)) offlineSince.set(hostId, now);

  const entryFor = (key: string) => entryByKey.get(key) ?? lastEntriesRef.current.get(key);
  const shownRows = (section: InboxSection) =>
    held[section].flatMap((row) => {
      const entry = entryFor(row.key);
      return entry ? [{ row, entry }] : [];
    });
  const sectionRows = {
    needs_you: shownRows("needs_you"),
    updates: shownRows("updates"),
    earlier: shownRows("earlier"),
    working: shownRows("working"),
  };
  const shortcutKeys = inboxShortcutOrder(held, { workingExpanded: !workingCollapsed }).filter((key) =>
    entryFor(key) !== undefined);
  const shortcutSignature = shortcutKeys.join("\u0000");

  // Commit what this render showed; the next render builds on it.
  React.useLayoutEffect(() => {
    heldRef.current = held;
    shownNeedsYouRef.current = debounced.order.needs_you;
    leftAtRef.current = debounced.leftAt;
    resetRef.current = fullResetKey;
    wasFrozenRef.current = frozen;
    const kept = new Map<string, InboxEntry>();
    for (const section of Object.values(sectionRows)) for (const { entry } of section) kept.set(entry.key, entry);
    lastEntriesRef.current = kept;
  });

  // Touched rows only matter until the freeze that held them releases.
  React.useEffect(() => {
    if (!frozen && touched.size > 0) setTouched(new Set());
  }, [frozen, touched]);

  // A row that left Needs you lingers 400 ms, then goes.
  React.useEffect(() => {
    if (debounced.nextCheckAt === null) return;
    const timer = window.setTimeout(tick, Math.max(0, debounced.nextCheckAt - clock()));
    return () => window.clearTimeout(timer);
  }, [clock, debounced.nextCheckAt]);

  const onShortcutOrderChangeRef = React.useRef(onShortcutOrderChange);
  onShortcutOrderChangeRef.current = onShortcutOrderChange;
  React.useEffect(() => {
    onShortcutOrderChangeRef.current?.(shortcutSignature ? shortcutSignature.split("\u0000") : []);
  }, [shortcutSignature]);

  useFlip(rootRef, { skip: reset || releasing });
  useFocusFollowsRemoval(rootRef);

  const focusAfterShowMoreRef = React.useRef<number | null>(null);
  React.useLayoutEffect(() => {
    const index = focusAfterShowMoreRef.current;
    if (index === null || !showAllEarlier) return;
    focusAfterShowMoreRef.current = null;
    const rows = rootRef.current?.querySelectorAll<HTMLElement>('[data-inbox-section="earlier"] [data-roving-item]');
    rows?.[Math.min(index, rows.length - 1)]?.focus();
  }, [showAllEarlier]);

  const renderEntry = (section: InboxSection, { row, entry }: { row: HeldInboxRow; entry: InboxEntry }) => {
    const rowNow = entry.signals.hostOnline ? now : (offlineSince.get(entry.hostId) ?? now);
    const status = inboxRowStatus(entry, liveStatusSection(entry, rowNow), rowNow);
    const description = inboxRowDescription(entry, status);
    return (
      <div key={row.key} data-inbox-row={row.key}>
        {renderRow(entry, {
          section,
          status,
          ...(description ? { description } : {}),
          dimmed: row.leaving || !entry.signals.hostOnline,
          touch: () => setTouched((current) => (current.has(row.key) ? current : new Set(current).add(row.key))),
        })}
      </div>
    );
  };

  const mainEmpty = MAIN_SECTIONS.every(({ id }) => sectionRows[id].length === 0);
  const workingRows = sectionRows.working;
  const shelfMaxHeight = sidebarHeight ? `${Math.round(sidebarHeight * 0.4)}px` : "40vh";

  return (
    <div
      ref={rootRef}
      data-inbox-view=""
      data-inbox-frozen={frozen ? "true" : undefined}
      data-inbox-flip-root=""
      className="flex flex-col"
      {...handlers}
    >
      <div className="flex h-6 items-center px-2.5 text-small-strong font-medium text-tertiary">
        <div className="min-w-0 flex-1">
          <SectionHeader label="Inbox" accessory={headerAccessory} actions={headerActions} />
        </div>
      </div>
      {mainEmpty ? (
        <EmptyState
          placement="inline"
          role="status"
          title={searching ? "No matches" : "Nothing needs you"}
          description={
            searching ? "Try a different search." : "Chats that wait on you or have news show up here."
          }
        />
      ) : (
        MAIN_SECTIONS.map(({ id, label }) =>
          sectionRows[id].length === 0 && !(id === "earlier" && moreCount > 0) ? null : (
            <section key={id} role="group" aria-label={label} data-inbox-section={id} className="mt-2 first:mt-0">
              <div className="flex h-6 items-center px-2.5 text-small-strong font-medium text-tertiary">
                <div className="min-w-0 flex-1">
                  <SectionHeader
                    label={label}
                    {...(id === "needs_you" ? { count: organization.needsYouCount } : {})}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-0.5">
                {sectionRows[id].map((shown) => renderEntry(id, shown))}
                {id === "earlier" && moreCount > 0 ? (
                  <SidebarListItem
                    data-roving-item
                    data-inbox-show-more=""
                    className="min-h-7 py-1 text-small text-tertiary"
                    title={`Show ${moreCount} more`}
                    onClick={() => {
                      focusAfterShowMoreRef.current = sectionRows.earlier.length;
                      setShowAllEarlier(true);
                    }}
                  />
                ) : null}
              </div>
            </section>
          ),
        )
      )}
      {workingRows.length > 0 ? (
        <section
          ref={shelfRef}
          role="group"
          aria-label="Working"
          data-inbox-section="working"
          className="sticky bottom-0 z-1 mt-2 flex min-h-0 flex-col bg-sidebar pt-1"
          style={{ maxHeight: shelfMaxHeight }}
        >
          <div className="flex h-6 shrink-0 items-center px-2.5 text-small-strong font-medium text-tertiary">
            <div className="min-w-0 flex-1">
              <SectionHeader
                label="Working"
                count={workingRows.length}
                collapse={{ expanded: !workingCollapsed, onToggle: () => setWorkingCollapsed(!workingCollapsed) }}
              />
            </div>
          </div>
          {workingCollapsed ? null : (
            <div data-inbox-flip-root="" className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
              {workingRows.map((shown) => renderEntry("working", shown))}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

/**
 * FLIP: a row that moved slides from its old place for 150 ms, at most 40 px.
 * Skipped under Reduce Motion, when more than 40 rows move at once, and right
 * after a reset or a freeze releases.
 */
function useFlip(rootRef: React.RefObject<HTMLElement | null>, { skip }: { skip: boolean }) {
  const positionsRef = React.useRef(new Map<string, { frame: Element; top: number }>());
  React.useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const next = new Map<string, { frame: Element; top: number }>();
    const rows = [...root.querySelectorAll<HTMLElement>("[data-inbox-row]")];
    for (const row of rows) {
      const frame = row.parentElement?.closest("[data-inbox-flip-root]") ?? root;
      next.set(row.dataset.inboxRow!, {
        frame,
        top: row.getBoundingClientRect().top - frame.getBoundingClientRect().top + frame.scrollTop,
      });
    }
    const previous = positionsRef.current;
    positionsRef.current = next;
    if (skip || previous.size === 0 || prefersReducedMotion()) return;
    const moves: { row: HTMLElement; delta: number }[] = [];
    for (const row of rows) {
      const before = previous.get(row.dataset.inboxRow!);
      const after = next.get(row.dataset.inboxRow!)!;
      if (!before || before.frame !== after.frame) continue;
      const delta = before.top - after.top;
      if (Math.abs(delta) >= 1) moves.push({ row, delta });
    }
    if (moves.length === 0 || moves.length > FLIP_MAX_ROWS) return;
    for (const { row, delta } of moves) {
      if (typeof row.animate !== "function") continue;
      const offset = Math.max(-FLIP_MAX_OFFSET_PX, Math.min(FLIP_MAX_OFFSET_PX, delta));
      row.animate(
        [{ transform: `translateY(${offset}px)` }, { transform: "translateY(0)" }],
        { duration: FLIP_DURATION_MS, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      );
    }
  });
}

/** When the focused row goes (a delete), focus moves to the row now in its place. */
function useFocusFollowsRemoval(rootRef: React.RefObject<HTMLElement | null>) {
  const focusedRef = React.useRef<{ key: string; index: number } | null>(null);
  React.useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const rows = [...root.querySelectorAll<HTMLElement>("[data-inbox-row]")];
    const remembered = focusedRef.current;
    const active = document.activeElement;
    if (remembered && (active === document.body || active === null)) {
      const stillThere = rows.some((row) => row.dataset.inboxRow === remembered.key);
      if (!stillThere && rows.length > 0) {
        rows[Math.min(remembered.index, rows.length - 1)]?.querySelector<HTMLElement>("[data-roving-item]")?.focus();
      }
    }
    const focusedIndex = rows.findIndex((row) => row.contains(document.activeElement));
    focusedRef.current = focusedIndex >= 0 ? { key: rows[focusedIndex]!.dataset.inboxRow!, index: focusedIndex } : null;
  });
}
