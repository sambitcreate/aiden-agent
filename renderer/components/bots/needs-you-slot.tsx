// The Needs-you slot (docs/plans/bot-ux-simplification.md §4.7): one place
// above a Bot chat's composer for everything waiting on the person, one item
// at a time. Take control comes first, then the ask cards (approvals, a folder
// or Mac request, a plan), then the Bot's A–E question, which is answered in
// the composer's place. With more than one item a quiet header reads
// "Needs you · 1 of 3" with Previous and Next. The card on show stays on show
// while others arrive: an arrival only raises the count, so a half-answered
// question or an opened plan is never swapped away. The slot only arranges:
// every item keeps its own card, answers and wire format.

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button, Text } from "../ui";

/** What an item is, which fixes its place in the slot. */
export type NeedsYouKind = "take_control" | "approval" | "access" | "plan" | "question";

/** Take control, then the ask cards (approval, folder or Mac request, plan), then the question. */
const NEEDS_YOU_ORDER: Record<NeedsYouKind, number> = {
  take_control: 0,
  approval: 1,
  access: 2,
  plan: 3,
  question: 4,
};

export interface NeedsYouItem {
  /** Stable while the item waits: the slot stays on it as others come and go. */
  key: string;
  kind: NeedsYouKind;
}

/** The items in slot order; equal kinds keep the order they came in. */
export function orderNeedsYouItems<Item extends NeedsYouItem>(items: readonly Item[]): Item[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => NEEDS_YOU_ORDER[a.item.kind] - NEEDS_YOU_ORDER[b.item.kind] || a.index - b.index)
    .map(({ item }) => item);
}

export interface NeedsYouSlotState<Item extends NeedsYouItem> {
  /** The item on show, or null when nothing waits. */
  current: Item | null;
  /** Its place, from 0. */
  index: number;
  count: number;
  previous(): void;
  next(): void;
}

/**
 * Which item the slot shows, from the items and the key on show (`chosen`).
 * It starts on the first in order and then stays on whatever is on show, so an
 * item that arrives later only raises the count; Previous and Next move
 * through the rest. When the item on show is answered, the slot moves to the
 * first item still waiting, so take control and the oldest asks come first.
 *
 * Call it while rendering the component that owns `chosen` (a chat keeps it
 * in its own state, above any early return): when the item on show is not yet
 * the recorded one, it records it with `choose`, React's pattern for state
 * adjusted during render.
 */
export function needsYouSlotState<Item extends NeedsYouItem>(
  items: readonly Item[],
  chosen: string | null,
  choose: (key: string) => void,
): NeedsYouSlotState<Item> {
  const ordered = orderNeedsYouItems(items);
  const found = chosen === null ? -1 : ordered.findIndex((item) => item.key === chosen);
  const index = found >= 0 ? found : 0;
  const shown = ordered[index];
  if (shown && shown.key !== chosen) choose(shown.key);
  const move = (by: number) => {
    if (ordered.length === 0) return;
    choose(ordered[(index + by + ordered.length) % ordered.length]!.key);
  };
  return {
    current: ordered[index] ?? null,
    index,
    count: ordered.length,
    previous: () => move(-1),
    next: () => move(1),
  };
}

/** `needsYouSlotState` with its own choice. */
export function useNeedsYouSlot<Item extends NeedsYouItem>(items: readonly Item[]): NeedsYouSlotState<Item> {
  const [chosen, setChosen] = React.useState<string | null>(null);
  return needsYouSlotState(items, chosen, setChosen);
}

/**
 * Where the card on show sits ("Needs you, 2 of 3"), in a polite live region.
 * Render it from the chat's first paint, outside anything that mounts with
 * the slot, so the first announcement lands in a region that was already
 * there. It speaks only when the card on show changes (moving through the
 * slot, or an answer bringing the next one up), never because another item
 * arrived behind it.
 */
export function NeedsYouAnnouncer<Item extends NeedsYouItem>({ slot }: { slot: NeedsYouSlotState<Item> }) {
  const [announcement, setAnnouncement] = React.useState("");
  const spokenFor = React.useRef<string | undefined>(undefined);
  const key = slot.current?.key;
  React.useEffect(() => {
    if (key === spokenFor.current) return;
    spokenFor.current = key;
    setAnnouncement(key !== undefined && slot.count > 1 ? `Needs you, ${slot.index + 1} of ${slot.count}` : "");
  }, [key, slot.count, slot.index]);
  return (
    <p className="sr-only" role="status" aria-live="polite" data-needs-you-announcement>
      {announcement}
    </p>
  );
}

/**
 * Keeps keyboard focus in the slot when a card is answered here: if focus was
 * inside the slot when the card on show went away, focus moves to the card
 * that took its place (its named group, or a heading), or to the composer when
 * nothing is left. A card answered elsewhere (a phone, another window) while
 * focus was outside the slot, or on nothing at all, moves nothing. Wrap the
 * slot, the question and the composer in it, and mark each card's wrapper with
 * `data-needs-you-card` (the slot's own wrapper with `data-needs-you-slot`).
 */
export function NeedsYouFocusScope({
  currentKey,
  className,
  children,
}: {
  currentKey: string | undefined;
  className?: string;
  children: React.ReactNode;
}) {
  const scope = React.useRef<HTMLDivElement>(null);
  // Whether this window's focus is in the slot, as of the last focus change.
  const inSlot = React.useRef(false);
  React.useEffect(() => {
    const element = scope.current;
    if (!element) return;
    const document = element.ownerDocument;
    const enter = (event: FocusEvent) => {
      inSlot.current = withinSlot(event.target);
    };
    const leave = (event: FocusEvent) => {
      // Focus moving to another element is settled by its focusin.
      if (event.relatedTarget) return;
      const left = event.target;
      // Read once the change settles: a card removed with focus on it, or a
      // button disabled while its answer is sent, still counts as in the
      // slot; the person sending focus to nothing does not.
      queueMicrotask(() => {
        if (!(left instanceof Element) || !left.isConnected || left.matches(":disabled")) return;
        if (document.activeElement === left) return; // the window lost focus; it comes back here
        inSlot.current = withinSlot(document.activeElement);
      });
    };
    document.addEventListener("focusin", enter);
    document.addEventListener("focusout", leave);
    return () => {
      document.removeEventListener("focusin", enter);
      document.removeEventListener("focusout", leave);
    };
  }, []);
  React.useLayoutEffect(() => {
    const element = scope.current;
    if (!element || !inSlot.current) return;
    const active = element.ownerDocument.activeElement;
    // Focus still on something that stayed (Previous, Next, a card that only changed) is left alone.
    if (active && active !== element.ownerDocument.body && active.isConnected) return;
    const card = element.querySelector("[data-needs-you-card]");
    const target =
      card?.querySelector<HTMLElement>('[role="group"][aria-label], [role="region"][aria-label], h1, h2, h3, h4') ??
      (card ? null : element.querySelector<HTMLElement>("textarea:not(:disabled)"));
    if (!target) return;
    if (card && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus();
    inSlot.current = withinSlot(target);
  }, [currentKey]);
  return (
    <div ref={scope} className={className}>
      {children}
    </div>
  );
}

function withinSlot(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-needs-you-card], [data-needs-you-slot]") !== null;
}

/** The slot's header when more than one item waits: "Needs you · 2 of 3" with Previous and Next. */
export function NeedsYouHeader<Item extends NeedsYouItem>({ slot }: { slot: NeedsYouSlotState<Item> }) {
  return (
    <>
      {slot.count > 1 ? (
        <nav aria-label="Needs you" className="flex items-center justify-between gap-2 px-2" data-needs-you-header>
          <Text as="p" variant="small" color="secondary">
            <span className="font-semibold text-primary">Needs you</span>
            <span aria-hidden="true"> · </span>
            <span data-needs-you-position>{`${slot.index + 1} of ${slot.count}`}</span>
          </Text>
          <div className="flex items-center gap-1">
            <Button variant="transparent" size="small" iconOnly aria-label="Previous" onClick={slot.previous}>
              <ChevronLeft aria-hidden="true" />
            </Button>
            <Button variant="transparent" size="small" iconOnly aria-label="Next" onClick={slot.next}>
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        </nav>
      ) : null}
    </>
  );
}
