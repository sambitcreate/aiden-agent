// The Needs-you slot (docs/plans/bot-ux-simplification.md §4.7): one place
// above a Bot chat's composer for everything waiting on the person, one item
// at a time. Take control comes first, then the ask cards (approvals, a folder
// or Mac request, a plan), then the Bot's A–E question, which is answered in
// the composer's place. With more than one item a quiet header reads
// "Needs you · 1 of 3" with Previous and Next. The slot only arranges: every
// item keeps its own card, answers and wire format.

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
 * Which item the slot shows, from the items and the key the person moved to
 * (`chosen`). It starts on the first; Previous and Next move through the rest.
 * When the item on show is answered, the slot moves to the first item again,
 * so take control and the oldest asks come back first. Pure, so a chat can
 * keep `chosen` in its own state above any early return.
 */
export function needsYouSlotState<Item extends NeedsYouItem>(
  items: readonly Item[],
  chosen: string | null,
  choose: (key: string) => void,
): NeedsYouSlotState<Item> {
  const ordered = orderNeedsYouItems(items);
  const found = chosen === null ? -1 : ordered.findIndex((item) => item.key === chosen);
  const index = found >= 0 ? found : 0;
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
 * The slot's header when more than one item waits: "Needs you · 2 of 3" with
 * Previous and Next. Each card announces itself; a polite live region adds
 * where it sits ("Needs you, 2 of 3") whenever that changes, so moving
 * through the slot, or an answer that brings the next item up, is heard.
 */
export function NeedsYouHeader<Item extends NeedsYouItem>({ slot }: { slot: NeedsYouSlotState<Item> }) {
  const announcement = slot.count > 1 ? `Needs you, ${slot.index + 1} of ${slot.count}` : "";
  return (
    <>
      <p className="sr-only" role="status" aria-live="polite" data-needs-you-announcement>
        {announcement}
      </p>
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
