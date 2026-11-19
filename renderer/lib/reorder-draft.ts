// Reordering a list from the keyboard and with the pointer.
//
// Keyboard: Space or Enter on an item's handle picks it up, the arrow keys
// (Left and Right too in a horizontal list, swapped right to left) and Home and
// End move it in a draft, Space or Enter drops it and commits the new order
// once, and Escape or leaving the handle puts it back where it was. Each step
// is announced, so a screen reader hears where the item is.
//
// Pointer: a press becomes a drag only after it travels 3px, the list scrolls
// while the pointer is near its edges, Escape cancels, and letting go commits
// once.

import * as React from "react";
import { flushSync } from "react-dom";
import { isEscapeKey } from "./dismiss-key";

export type ReorderDraft = {
  id: string;
  /** The group's order when the item was picked up. */
  original: readonly string[];
  order: readonly string[];
};

export type ReorderStep = "previous" | "next" | "first" | "last";
export type ReorderKeyAction = "pick" | "drop" | "cancel" | ReorderStep;
export type ReorderMessageType = "pick" | "move" | "drop" | "cancel";

/** Picks `id` up from `order`; null when it isn't there. */
export function pickUp(order: readonly string[], id: string): ReorderDraft | null {
  return order.includes(id) ? { id, original: [...order], order: [...order] } : null;
}

/** Moves the held item to `index`, clamped to the list's ends. */
export function moveDraftTo(draft: ReorderDraft, index: number): ReorderDraft {
  const rest = draft.order.filter((entry) => entry !== draft.id);
  const at = Math.max(0, Math.min(rest.length, index));
  if (draft.order[at] === draft.id) return draft;
  return { ...draft, order: [...rest.slice(0, at), draft.id, ...rest.slice(at)] };
}

export function stepDraft(draft: ReorderDraft, step: ReorderStep): ReorderDraft {
  const index = draft.order.indexOf(draft.id);
  const to = step === "first" ? 0 : step === "last" ? draft.order.length - 1 : step === "previous" ? index - 1 : index + 1;
  return moveDraftTo(draft, to);
}

export function draftChanged(draft: ReorderDraft): boolean {
  return draft.order.some((entry, index) => entry !== draft.original[index]);
}

/** 1-based position of the held item in the draft, or in its original order. */
export function draftPosition(draft: ReorderDraft, original = false): number {
  return (original ? draft.original : draft.order).indexOf(draft.id) + 1;
}

export function reorderMessage(type: ReorderMessageType, label: string, position: number, total: number): string {
  const at = `position ${position} of ${total}`;
  if (type === "pick") return `Picked up ${label}, ${at}.`;
  if (type === "move") return `${label}, ${at}.`;
  if (type === "drop") return `Dropped ${label} at ${at}.`;
  return `Moved ${label} back to ${at}.`;
}

/** What a key on a handle does; null leaves the key alone. */
export function reorderKeyAction(
  event: { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; isComposing?: boolean; keyCode?: number; defaultPrevented: boolean },
  context: { held: boolean; orientation: "vertical" | "horizontal"; rtl: boolean },
): ReorderKeyAction | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  const { key } = event;
  if (!context.held) return key === " " || key === "Enter" ? "pick" : null;
  if (key === " " || key === "Enter") return "drop";
  if (isEscapeKey(event)) return "cancel";
  if (key === "Home") return "first";
  if (key === "End") return "last";
  const back = context.orientation === "vertical" ? "ArrowUp" : context.rtl ? "ArrowRight" : "ArrowLeft";
  const forward = context.orientation === "vertical" ? "ArrowDown" : context.rtl ? "ArrowLeft" : "ArrowRight";
  if (key === back) return "previous";
  if (key === forward) return "next";
  return null;
}

/** Lays `list` out in the draft's order where its members are; other entries keep their places. */
export function arrangeByDraft<T>(list: readonly T[], keyOf: (entry: T) => string, draft: ReorderDraft | null): readonly T[] {
  if (!draft || !list.some((entry) => keyOf(entry) === draft.id)) return list;
  const members = new Set(draft.order);
  const byKey = new Map(list.map((entry) => [keyOf(entry), entry]));
  const queue = draft.order.map((key) => byKey.get(key)).filter((entry): entry is T => entry !== undefined);
  return list.map((entry) => (members.has(keyOf(entry)) ? queue.shift()! : entry));
}

export interface ReorderDraftOptions {
  /** The ids that trade places with `id`, in list order. */
  groupOf(id: string): readonly string[];
  label(id: string): string;
  /** Called once per drop that changed the order. */
  onCommit(order: readonly string[], id: string): void;
  /** The handle to keep focus on while the item moves. */
  handle(id: string): HTMLElement | null | undefined;
  orientation?: "vertical" | "horizontal";
}

export function useReorderDraft(options: ReorderDraftOptions) {
  const [draft, setDraft] = React.useState<ReorderDraft | null>(null);
  const [announcement, setAnnouncement] = React.useState("");
  const latest = React.useRef({ options, draft });
  const refocus = React.useRef<string | null>(null);
  React.useLayoutEffect(() => {
    latest.current = { options, draft };
  });

  // Moving an item moves its DOM node, which can drop focus; put it back on the handle.
  React.useLayoutEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    const handle = options.handle(id);
    if (handle && document.activeElement !== handle) handle.focus();
  });

  // The group changed under the draft (an item came or went): drop the draft quietly.
  const groupKey = draft ? options.groupOf(draft.id).join("\n") : "";
  React.useEffect(() => {
    if (draft && groupKey !== draft.original.join("\n")) setDraft(null);
  }, [draft, groupKey]);

  const say = (type: ReorderMessageType, next: ReorderDraft, original = false) =>
    setAnnouncement(reorderMessage(type, options.label(next.id), draftPosition(next, original), next.order.length));

  const cancel = (current: ReorderDraft, restoreFocus: boolean) => {
    setDraft(null);
    say("cancel", current, true);
    if (restoreFocus) refocus.current = current.id;
  };

  const handleProps = (id: string) => ({
    "data-reorder-held": draft?.id === id ? "" : undefined,
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented) return;
      const held = draft?.id === id ? draft : null;
      const action = reorderKeyAction(event, {
        held: held !== null,
        orientation: options.orientation ?? "vertical",
        rtl: event.currentTarget.closest("[dir]")?.getAttribute("dir") === "rtl",
      });
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === "pick") {
        const next = pickUp(options.groupOf(id), id);
        if (!next) return;
        setDraft(next);
        say("pick", next);
      } else if (!held) {
        return;
      } else if (action === "cancel") {
        cancel(held, true);
      } else if (action === "drop") {
        setDraft(null);
        say("drop", held);
        refocus.current = id;
        if (draftChanged(held)) options.onCommit(held.order, id);
      } else {
        const next = stepDraft(held, action);
        if (next === held) return;
        setDraft(next);
        say("move", next);
        refocus.current = id;
      }
    },
    // A press on a held item's handle puts it back first, so a pointer drag measures the list as saved.
    onPointerDown: () => {
      if (draft?.id === id) flushSync(() => cancel(draft, false));
    },
    onBlur: () => {
      // A move can blur the handle for a moment; only a real departure cancels.
      window.setTimeout(() => {
        const { options: now, draft: current } = latest.current;
        if (current?.id === id && document.activeElement !== now.handle(id)) cancel(current, false);
      }, 0);
    },
  });

  return { draft, held: draft?.id ?? null, announcement, setAnnouncement, handleProps };
}

/** What `useReorderDraft` puts on a handle. */
export type ReorderHandleProps = ReturnType<ReturnType<typeof useReorderDraft>["handleProps"]>;

/** The one assertive live region a reorderable list announces through; render it outside the keyed items. */
export function ReorderAnnouncer({ message }: { message: string }): React.JSX.Element {
  return React.createElement("div", { role: "status", "aria-live": "assertive", "aria-atomic": true, className: "sr-only" }, message);
}

// ---- Pointer --------------------------------------------------------------

export type PointerDropTarget = { id: string; place: "before" | "after" };

const DRAG_THRESHOLD_PX = 3;
const EDGE_PX = 48;
const MAX_SCROLL_PX = 18;
/** How long the click after an Escape-cancelled drag is swallowed if its pointerup never arrives. */
const SWALLOW_FALLBACK_MS = 3000;

/** Scroll speed for a pointer at `at` between `start` and `end`: negative toward the start. */
export function edgeScrollVelocity(at: number, start: number, end: number): number {
  const band = Math.min(EDGE_PX, (end - start) / 3);
  if (band <= 0) return 0;
  if (at < start + band) return -MAX_SCROLL_PX * Math.min(1, (start + band - at) / band);
  if (at > end - band) return MAX_SCROLL_PX * Math.min(1, (at - (end - band)) / band);
  return 0;
}

/** The row nearest `y` and which half of it `y` is in; null over the dragged row `self` itself. */
export function pointerDropTarget(
  y: number,
  rows: readonly { id: string; top: number; bottom: number }[],
  self?: string,
): PointerDropTarget | null {
  let best: { id: string; top: number; bottom: number } | null = null;
  let distance = Infinity;
  for (const row of rows) {
    const gap = y < row.top ? row.top - y : y > row.bottom ? y - row.bottom : 0;
    if (gap < distance) [best, distance] = [row, gap];
  }
  if (!best || best.id === self) return null;
  return { id: best.id, place: y < (best.top + best.bottom) / 2 ? "before" : "after" };
}

/** The nearest ancestor that scrolls vertically. */
export function scrollParentOf(element: Element | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    if (/auto|scroll|overlay/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

export interface PointerReorderOptions {
  /** The rows `id` can land on, itself included (hovering it lands nowhere). */
  targets(id: string): readonly { id: string; element: Element }[];
  onDrop(id: string, target: PointerDropTarget): void;
  /** The list's scroller, scrolled while the pointer nears its edges. */
  scroller(): HTMLElement | null;
}

type PointerSession = { id: string; pointerId: number; startY: number; y: number; element: Element; active: boolean; frame: number; over: PointerDropTarget | null; scroller: HTMLElement | null };

export function usePointerReorder(options: PointerReorderOptions) {
  const [drag, setDrag] = React.useState<{ id: string; over: PointerDropTarget | null } | null>(null);
  const latest = React.useRef(options);
  const session = React.useRef<PointerSession | null>(null);
  const stopRef = React.useRef<(() => void) | null>(null);
  React.useLayoutEffect(() => {
    latest.current = options;
  });
  React.useEffect(() => () => stopRef.current?.(), []);

  const onPointerDown = (id: string, event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || session.current) return;
    const current: PointerSession = { id, pointerId: event.pointerId, startY: event.clientY, y: event.clientY, element: event.currentTarget, active: false, frame: 0, over: null, scroller: null };
    session.current = current;

    const measure = () => {
      const rows = latest.current.targets(id).map(({ id: target, element }) => {
        const rect = element.getBoundingClientRect();
        return { id: target, top: rect.top, bottom: rect.bottom };
      });
      const over = pointerDropTarget(current.y, rows, id);
      if (over?.id !== current.over?.id || over?.place !== current.over?.place) {
        current.over = over;
        setDrag({ id, over });
      }
    };
    const tick = () => {
      current.frame = 0;
      measure();
      const { scroller } = current;
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      const velocity = edgeScrollVelocity(current.y, rect.top, rect.bottom);
      if (velocity === 0) return;
      const before = scroller.scrollTop;
      scroller.scrollTop += velocity;
      if (scroller.scrollTop !== before) current.frame = requestAnimationFrame(tick);
    };
    const end = (commit: boolean, released = commit) => {
      stop();
      if (!current.active) return;
      setDrag(null);
      // The click that ends a drag is not a click on the row. After Escape the
      // button is still down, so keep swallowing until it comes up.
      const swallow = (click: Event) => {
        click.stopPropagation();
        click.preventDefault();
      };
      const unswallow = () => window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      window.addEventListener("click", swallow, { capture: true, once: true });
      if (released) unswallow();
      else {
        window.addEventListener("pointerup", unswallow, { capture: true, once: true });
        window.setTimeout(unswallow, SWALLOW_FALLBACK_MS);
      }
      if (commit && current.over) latest.current.onDrop(id, current.over);
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== current.pointerId) return;
      if (move.buttons === 0) return end(false, true);
      current.y = move.clientY;
      if (!current.active) {
        if (Math.abs(move.clientY - current.startY) < DRAG_THRESHOLD_PX) return;
        current.active = true;
        current.scroller = latest.current.scroller();
        setDrag({ id, over: null });
        try {
          current.element.setPointerCapture(current.pointerId);
        } catch {
          // The pointer may already be gone; window listeners still follow it.
        }
      }
      if (!current.frame) current.frame = requestAnimationFrame(tick);
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== current.pointerId) return;
      if (current.active) {
        current.y = up.clientY;
        measure();
      }
      end(true);
    };
    const onCancel = (cancel: PointerEvent) => {
      if (cancel.pointerId === current.pointerId) end(false, true);
    };
    const onKey = (key: KeyboardEvent) => {
      if (!current.active || !isEscapeKey(key)) return;
      key.preventDefault();
      key.stopPropagation();
      end(false);
    };
    const stop = () => {
      if (current.frame) cancelAnimationFrame(current.frame);
      current.frame = 0;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, { capture: true });
      try {
        if (current.element.hasPointerCapture?.(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
      } catch {
        // Already released.
      }
      if (session.current === current) session.current = null;
      stopRef.current = null;
    };
    stopRef.current = stop;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, { capture: true });
  };

  return { drag, onPointerDown };
}
