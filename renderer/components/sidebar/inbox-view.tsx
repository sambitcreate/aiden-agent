import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/ui-utils";
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
 * The Inbox sidebar view (docs/plans/inbox-sidebar-plan.md, Phases 1b and 2a):
 * Needs you, Pinned, Updates and Earlier, then the collapsible Working shelf. The list holds
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
   * was deleted and goes at once. Defaults to the keys of `entries` and `unlisted`.
   */
  present?: ReadonlySet<string>;
  /**
   * Rows that exist but aren't listed now (a read Bot), by key. A row the list
   * holds in place after it stopped qualifying shows its live state from here.
   */
  unlisted?: ReadonlyMap<string, InboxEntry>;
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
  /**
   * Where the Working shelf goes: a region pinned under the scrolling list
   * (the sidebar's `belowList`). Without one it follows Earlier in the list.
   */
  shelfHost?: HTMLElement | null;
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
  { id: "pinned", label: "Pinned" },
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

type Regions = () => readonly (HTMLElement | null)[];

function insideRegions(regions: Regions, node: unknown): boolean {
  return node instanceof Node && regions().some((region) => region?.contains(node) ?? false);
}

/** Every Inbox row in screen order: the list's, then the shelf's when it sits apart. */
function inboxRows(regions: Regions): HTMLElement[] {
  const rows = new Set<HTMLElement>();
  for (const region of regions()) {
    for (const row of region?.querySelectorAll<HTMLElement>("[data-inbox-row]") ?? []) rows.add(row);
  }
  return [...rows];
}

/**
 * The list is in use while the pointer is over it, keyboard focus is inside
 * it, or a menu or dialog is open. Window blur or a hidden window releases it.
 *
 * Both are read from the DOM, not React's synthetic events: React bubbles
 * those through portals, so a row's menu would count as the list. The list
 * can span two regions (the rows and the Working shelf under them).
 */
function useListInUse(regions: Regions) {
  const [pointerInside, setPointerInside] = React.useState(false);
  const [focusInside, setFocusInside] = React.useState(false);
  const [overlay, setOverlay] = React.useState(overlayOpen);
  const [windowActive, setWindowActive] = React.useState(windowIsActive);
  const regionsRef = React.useRef(regions);
  regionsRef.current = regions;
  const lastPointerRef = React.useRef<{ x: number; y: number } | null>(null);

  const checkFocus = React.useCallback(() => {
    const active = document.activeElement;
    setFocusInside(insideRegions(regionsRef.current, active) && matchesFocusVisible(active));
  }, []);

  React.useEffect(() => {
    const inside = (node: unknown) => insideRegions(regionsRef.current, node);
    // A menu that closes leaves no pointer event behind: look at what is
    // under the pointer now, and again once the closing menu's styles go.
    let frame = 0;
    const checkPointer = () => {
      const at = lastPointerRef.current;
      if (!at || typeof document.elementFromPoint !== "function") return;
      setPointerInside(inside(document.elementFromPoint(at.x, at.y)));
    };
    const onPointerOver = (event: PointerEvent) => {
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      setPointerInside(inside(event.target));
    };
    const onPointerMove = (event: PointerEvent) => {
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
    };
    const onPointerOut = (event: PointerEvent) => {
      // No related target: the pointer left the window.
      if (event.relatedTarget === null) setPointerInside(false);
    };
    const onFocusIn = () => checkFocus();
    const onFocusOut = (event: FocusEvent) => {
      if (!inside(event.relatedTarget)) setFocusInside(false);
    };
    const onBlur = () => setWindowActive(false);
    const onFocus = () => setWindowActive(windowIsActive());
    const onVisibility = () => setWindowActive(windowIsActive() && (document.hasFocus?.() ?? true));
    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    // Menus and dialogs mount in portals directly under <body>.
    let wasOpen = overlayOpen();
    const observer = typeof MutationObserver === "function"
      ? new MutationObserver(() => {
          const open = overlayOpen();
          setOverlay(open);
          if (wasOpen && !open) {
            checkPointer();
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(checkPointer);
          }
          wasOpen = open;
        })
      : null;
    observer?.observe(document.body, { childList: true });
    // The menu that switched the sidebar to the Inbox can close between the
    // first render and this effect, with no mutation left to report it.
    setOverlay(wasOpen);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      observer?.disconnect();
    };
  }, [checkFocus]);

  // A focused row that goes (deleted, or moved out by a filter) fires no
  // focusout, so read focus again after every render.
  React.useLayoutEffect(checkFocus);

  return windowActive && (pointerInside || focusInside || overlay);
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

/**
 * The section a row's status reads from: where its live state places it. A
 * pinned row reads as Updates while it has unseen output, else as Earlier.
 */
function liveStatusSection(entry: InboxEntry, now: number): InboxSection {
  const { shelf } = inboxState(entry.signals, now, Number.POSITIVE_INFINITY);
  if (shelf === "pinned") return entry.signals.unread && !entry.signals.isOpen ? "updates" : "earlier";
  return shelf === "hidden" ? "earlier" : shelf;
}

export function InboxView({
  entries,
  present: presentProp,
  unlisted,
  searching = false,
  resetKey = "",
  activeKey = null,
  headerAccessory,
  headerActions,
  renderRow,
  onShortcutOrderChange,
  shelfHost = null,
  now: clock = Date.now,
}: InboxViewProps) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const shelfRef = React.useRef<HTMLElement>(null);
  const regions = React.useCallback(() => [rootRef.current, shelfRef.current], []);
  const [, tick] = React.useReducer((count: number) => count + 1, 0);
  const [showAllEarlier, setShowAllEarlier] = React.useState(false);
  const [touched, setTouched] = React.useState<ReadonlySet<string>>(() => new Set());
  const { collapsed: workingCollapsed, setCollapsed: setWorkingCollapsed } = useWorkingShelfCollapsed();
  const inUse = useListInUse(regions);
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
  const present = presentProp ?? new Set([...entryByKey.keys(), ...(unlisted?.keys() ?? [])]);
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

  // A held row shows its live state when it has one, else the last it showed.
  const entryFor = (key: string) =>
    entryByKey.get(key) ?? unlisted?.get(key) ?? lastEntriesRef.current.get(key);
  const shownRows = (section: InboxSection) =>
    held[section].flatMap((row) => {
      const entry = entryFor(row.key);
      return entry ? [{ row, entry }] : [];
    });
  const sectionRows = {
    needs_you: shownRows("needs_you"),
    pinned: shownRows("pinned"),
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

  useFlip(rootRef, regions, { skip: reset || releasing });
  useFocusFollowsRemoval(regions);

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
  // A search that only matches working chats shows them on the shelf, not "No matches".
  const showEmpty = mainEmpty && (!searching || workingRows.length === 0);
  const shelfMaxHeight = sidebarHeight ? `${Math.round(sidebarHeight * 0.4)}px` : "40vh";
  const apart = shelfHost !== null;

  const shelf = workingRows.length > 0 ? (
    <section
      ref={shelfRef}
      role="group"
      aria-label="Working"
      data-inbox-section="working"
      className={cn("flex min-h-0 flex-col pt-1", !apart && "mt-2")}
      style={{ maxHeight: shelfMaxHeight }}
    >
      {/* Apart from the list, the shelf pads itself like the list and keeps
          the same scrollbar gutter, so its rows' edges line up with the list's.
          The header's clip box and the rows' scroller each leave 4px above and
          below for the 2px + 2px focus ring; the negative margins keep the
          header and the first row where they were. */}
      <div className={cn("shrink-0", apart && "-mt-1 overflow-hidden px-2.5 py-1 [scrollbar-gutter:stable]")}>
        <div className="flex h-6 items-center px-2.5 text-small-strong font-medium text-tertiary">
          <div className="min-w-0 flex-1">
            <SectionHeader
              label="Working"
              count={workingRows.length}
              collapse={{ expanded: !workingCollapsed, onToggle: () => setWorkingCollapsed(!workingCollapsed) }}
            />
          </div>
        </div>
      </div>
      {workingCollapsed ? null : (
        <div
          data-inbox-flip-root=""
          className={cn("flex min-h-0 flex-col gap-0.5 overflow-y-auto", apart && "-mt-1 px-2.5 py-1")}
        >
          {workingRows.map((shown) => renderEntry("working", shown))}
        </div>
      )}
    </section>
  ) : null;

  return (
    <div
      ref={rootRef}
      data-inbox-view=""
      data-inbox-frozen={frozen ? "true" : undefined}
      data-inbox-flip-root=""
      className="flex flex-col"
    >
      <div className="flex h-6 items-center px-2.5 text-small-strong font-medium text-tertiary">
        <div className="min-w-0 flex-1">
          <SectionHeader label="Inbox" accessory={headerAccessory} actions={headerActions} />
        </div>
      </div>
      {showEmpty ? (
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
      {shelf && shelfHost ? createPortal(shelf, shelfHost) : shelf}
    </div>
  );
}

/**
 * FLIP: a row that moved slides from its old place for 150 ms, at most 40 px.
 * Skipped under Reduce Motion, when more than 40 rows move at once, and right
 * after a reset or a freeze releases.
 *
 * Runs after every render but only touches rows whose layout place changed, so
 * a re-render that moves nothing (a streaming update, the parent taking the
 * new shortcut order) leaves running slides alone. Places are measured without
 * the slide's own transform; a row that moves again mid-slide restarts from
 * where it is on screen.
 */
function useFlip(
  rootRef: React.RefObject<HTMLElement | null>,
  regions: Regions,
  { skip }: { skip: boolean },
) {
  const positionsRef = React.useRef(new Map<string, { frame: Element; top: number }>());
  React.useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const next = new Map<string, { frame: Element; top: number }>();
    const shifts = new Map<HTMLElement, number>();
    const rows = inboxRows(regions);
    for (const row of rows) {
      const frame = row.parentElement?.closest("[data-inbox-flip-root]") ?? root;
      const shift = translateY(row);
      shifts.set(row, shift);
      next.set(row.dataset.inboxRow!, {
        frame,
        top: row.getBoundingClientRect().top - shift - frame.getBoundingClientRect().top + frame.scrollTop,
      });
    }
    const previous = positionsRef.current;
    positionsRef.current = next;
    const moves: { row: HTMLElement; offset: number }[] = [];
    for (const row of rows) {
      const before = previous.get(row.dataset.inboxRow!);
      const after = next.get(row.dataset.inboxRow!)!;
      if (!before) continue;
      if (before.frame !== after.frame) {
        moves.push({ row, offset: Number.NaN });
        continue;
      }
      // Where the row shows now, relative to its new place.
      if (Math.abs(before.top - after.top) >= 1) moves.push({ row, offset: before.top + shifts.get(row)! - after.top });
    }
    if (moves.length === 0) return;
    const animate = !skip && moves.length <= FLIP_MAX_ROWS && !prefersReducedMotion();
    for (const { row, offset } of moves) {
      for (const animation of row.getAnimations?.() ?? []) animation.cancel();
      if (!animate || !Number.isFinite(offset) || Math.abs(offset) < 1 || typeof row.animate !== "function") continue;
      const from = Math.max(-FLIP_MAX_OFFSET_PX, Math.min(FLIP_MAX_OFFSET_PX, offset));
      row.animate(
        [{ transform: `translateY(${from}px)` }, { transform: "translateY(0)" }],
        { duration: FLIP_DURATION_MS, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      );
    }
  });
}

/** The vertical offset a running slide has the row at, from its computed transform. */
function translateY(element: HTMLElement): number {
  const transform = typeof getComputedStyle === "function" ? getComputedStyle(element).transform : "";
  const values = /^matrix(3d)?\(([^)]*)\)$/u.exec(transform ?? "");
  if (!values) return 0;
  const parts = values[2]!.split(",").map(Number);
  const y = values[1] ? parts[13] : parts[5];
  return y !== undefined && Number.isFinite(y) ? y : 0;
}

/** When the focused row goes (a delete), focus moves to the row now in its place. */
function useFocusFollowsRemoval(regions: Regions) {
  const focusedRef = React.useRef<{ key: string; index: number } | null>(null);
  React.useLayoutEffect(() => {
    const rows = inboxRows(regions);
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
