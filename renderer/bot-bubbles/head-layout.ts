// Bot bubbles: the layout math for heads, the × target, the peek and the mini
// chat. Pure functions over CSS pixels of one area (the overlay's display work
// area, or the Aiden window's content), so both hosts and the tests share them.

import {
  BOT_BUBBLE_HEAD_SIZE,
  clampBubbleShare,
  type BotBubbleRect,
  type BotBubbleSide,
} from "../shared/bot-bubbles";

/** A head's diameter. */
export const HEAD_SIZE = BOT_BUBBLE_HEAD_SIZE;
/** The gap between a head and its area's side, top and bottom. */
export const EDGE_MARGIN = 14;
/** The gap between two heads stacked on one side. */
export const STACK_GAP = 12;
/** How far ahead a flick is projected when choosing the side (ms of travel). */
export const FLICK_SIDE_MS = 160;
/** How far a flick carries the head up or down (ms of travel). */
export const FLICK_Y_MS = 120;
/** The × target's centre height above the bottom, and its pull radius. */
export const CLOSE_TARGET_BOTTOM = 92;
export const CLOSE_TARGET_PULL = 84;
/** One arrow press moves a head this far up or down. */
export const KEYBOARD_STEP = 40;
/** The mini chat's width bounds, its height cap, and its distance from the head. */
export const MINI_CHAT_MIN_WIDTH = 230;
export const MINI_CHAT_MAX_WIDTH = 340;
export const MINI_CHAT_MAX_HEIGHT = 440;
export const MINI_CHAT_HEAD_GAP = 14;
/** The mini chat sits this far above the head's top, so the pointer meets the head near the chat's top. */
export const MINI_CHAT_RISE = 28;
/** The pointer stays this far from the chat's top and bottom corners. */
export const MINI_CHAT_CARET_INSET = 22;
/** The peek's width cap and its distance from the head. */
export const PEEK_MAX_WIDTH = 230;
export const PEEK_GAP = 10;

export interface BubbleArea {
  width: number;
  height: number;
}

export interface HeadPosition {
  /** The head's left edge. */
  x: number;
  /** The head's top edge. */
  y: number;
}

export interface HeadSpot {
  side: BotBubbleSide;
  /** The head's top edge in pixels. */
  y: number;
}

export interface StackInput {
  id: string;
  side: BotBubbleSide;
  /** Where the head would like its top edge, in pixels. */
  y: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** The lowest top edge a head may have in this area. */
function maxHeadY(area: BubbleArea): number {
  return Math.max(EDGE_MARGIN, area.height - EDGE_MARGIN - HEAD_SIZE);
}

/** A head's top edge, kept inside the area's margins. */
export function clampHeadY(y: number, area: BubbleArea): number {
  return clamp(y, EDGE_MARGIN, maxHeadY(area));
}

/** A head's left edge on a side. */
export function headX(side: BotBubbleSide, area: BubbleArea): number {
  return side === "left" ? EDGE_MARGIN : Math.max(EDGE_MARGIN, area.width - EDGE_MARGIN - HEAD_SIZE);
}

/**
 * Where a head wants its top edge, kept inside the area but not the margins.
 * The stack applies the margins when it draws, so a head asked for above (or
 * below) a neighbour sitting on the margin keeps that order once saved.
 */
export function wantedHeadY(y: number, area: BubbleArea): number {
  return clamp(y, 0, Math.max(0, area.height - HEAD_SIZE));
}

/** A saved share (0..1 of the area height less one head) as the head's wanted top edge. */
export function shareToY(share: number, area: BubbleArea): number {
  return clampBubbleShare(share) * Math.max(0, area.height - HEAD_SIZE);
}

/** A head's top edge as the share that is saved, so it survives display and window resizes. */
export function yToShare(y: number, area: BubbleArea): number {
  const free = area.height - HEAD_SIZE;
  return free <= 0 ? 0 : clampBubbleShare(y / free);
}

/**
 * Where each head draws: heads on one side keep their order by wanted height
 * and never overlap (a `STACK_GAP` between them). A head is pushed down below
 * the one above it; if the stack then runs past the bottom it is pushed back
 * up. A side with more heads than fit keeps the order and lets the top ones
 * sit at the top margin.
 */
export function stackHeads(heads: readonly StackInput[], area: BubbleArea): Map<string, HeadPosition> {
  const placed = new Map<string, HeadPosition>();
  const step = HEAD_SIZE + STACK_GAP;
  for (const side of ["left", "right"] as const) {
    const column = heads
      .map((head, index) => ({ head, index }))
      .filter(({ head }) => head.side === side)
      .sort((left, right) => left.head.y - right.head.y || left.index - right.index);
    const ys = column.map(({ head }) => clampHeadY(head.y, area));
    for (let index = 1; index < ys.length; index += 1) ys[index] = Math.max(ys[index]!, ys[index - 1]! + step);
    const bottom = maxHeadY(area);
    for (let index = ys.length - 1; index >= 0; index -= 1) {
      const limit = index === ys.length - 1 ? bottom : ys[index + 1]! - step;
      ys[index] = Math.max(EDGE_MARGIN, Math.min(ys[index]!, limit));
    }
    column.forEach(({ head }, index) => placed.set(head.id, { x: headX(side, area), y: ys[index]! }));
  }
  return placed;
}

/**
 * Where a released head lands. `position` is its top-left at release and
 * `velocity` its pointer speed in px/ms: the centre projected a short way
 * ahead picks the side (a flick throws it to the far side), and the head
 * carries on up or down a little before it settles inside the margins.
 */
export function releaseHead(
  position: HeadPosition,
  velocity: { x: number; y: number },
  area: BubbleArea,
): HeadSpot {
  const projectedCentre = position.x + HEAD_SIZE / 2 + velocity.x * FLICK_SIDE_MS;
  return {
    side: projectedCentre < area.width / 2 ? "left" : "right",
    y: wantedHeadY(position.y + velocity.y * FLICK_Y_MS, area),
  };
}

/** The × target's centre while a head is dragged. */
export function closeTargetCentre(area: BubbleArea): { x: number; y: number } {
  return { x: area.width / 2, y: area.height - CLOSE_TARGET_BOTTOM };
}

/** Whether a dragged head (its top-left) is close enough to the × target to be pulled in. */
export function isOverCloseTarget(position: HeadPosition, area: BubbleArea): boolean {
  const target = closeTargetCentre(area);
  const dx = position.x + HEAD_SIZE / 2 - target.x;
  const dy = position.y + HEAD_SIZE / 2 - target.y;
  return Math.hypot(dx, dy) <= CLOSE_TARGET_PULL;
}

export type HeadMoveKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

export function isHeadMoveKey(key: string): key is HeadMoveKey {
  return key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown";
}

/** An arrow key on a focused head: left and right switch sides, up and down move it a step. */
export function moveHeadWithKey(spot: HeadSpot, key: HeadMoveKey, area: BubbleArea): HeadSpot {
  switch (key) {
    case "ArrowLeft":
      return { side: "left", y: clampHeadY(spot.y, area) };
    case "ArrowRight":
      return { side: "right", y: clampHeadY(spot.y, area) };
    case "ArrowUp":
      return { side: spot.side, y: clampHeadY(spot.y - KEYBOARD_STEP, area) };
    case "ArrowDown":
      return { side: spot.side, y: clampHeadY(spot.y + KEYBOARD_STEP, area) };
  }
}

/**
 * The wanted spot to save for a head put at `spot` (its top edge as dropped or
 * stepped to, outside the area if it was pushed past an edge). It keeps the
 * order the person chose: the saved height sorts strictly between the heads
 * that show above and below where it was put, even when they sit on a margin.
 * Inside a margin, where every wanted height draws the same, it picks one
 * strictly between its neighbours so there is always room for the next head.
 */
export function placeHeadInStack(
  heads: readonly StackInput[],
  id: string,
  spot: HeadSpot,
  area: BubbleArea,
): HeadSpot {
  const free = Math.max(0, area.height - HEAD_SIZE);
  const others = heads.filter((head) => head.id !== id && head.side === spot.side);
  const shown = stackHeads(others, area);
  // In the order they draw; it goes below every neighbour showing at or above where it was put.
  const column = [...others].sort((a, b) => shown.get(a.id)!.y - shown.get(b.id)!.y);
  const rank = column.filter((head) => shown.get(head.id)!.y <= spot.y).length;
  const low = rank > 0 ? wantedHeadY(column[rank - 1]!.y, area) : 0;
  const high = rank < column.length ? wantedHeadY(column[rank]!.y, area) : free;
  // The wanted heights that draw where it was put.
  const drawn = clampHeadY(spot.y, area);
  const zoneLow = drawn <= EDGE_MARGIN ? 0 : drawn;
  const zoneHigh = drawn <= EDGE_MARGIN ? Math.min(EDGE_MARGIN, free) : drawn >= maxHeadY(area) ? free : drawn;
  const from = Math.max(low, zoneLow);
  const to = Math.min(high, zoneHigh);
  const wanted = wantedHeadY(spot.y, area);
  const inside = (y: number) => y > low && y < high;
  if (wanted >= from && wanted <= to && inside(wanted)) return { side: spot.side, y: wanted };
  // Somewhere in the zone that keeps the order, else between the neighbours.
  const middle = from <= to && inside((from + to) / 2) ? (from + to) / 2 : (low + high) / 2;
  return { side: spot.side, y: middle };
}

/**
 * An arrow key on a head in its stack. Up and Down move it a step from where
 * it shows; a step that would land on a neighbour jumps past it instead, so a
 * head can always change places with the one above or below it.
 */
export function moveStackedHeadWithKey(
  heads: readonly StackInput[],
  id: string,
  key: HeadMoveKey,
  area: BubbleArea,
): HeadSpot | null {
  const shown = stackHeads(heads, area);
  const me = heads.find((head) => head.id === id);
  const at = shown.get(id);
  if (!me || !at) return null;
  if (key === "ArrowLeft" || key === "ArrowRight")
    return placeHeadInStack(heads, id, moveHeadWithKey({ side: me.side, y: at.y }, key, area), area);
  const step = HEAD_SIZE + STACK_GAP;
  const neighbours = heads
    .filter((head) => head.id !== id && head.side === me.side)
    .map((head) => shown.get(head.id)!.y);
  let y: number;
  if (key === "ArrowUp") {
    y = at.y - KEYBOARD_STEP;
    const above = neighbours.filter((other) => other < at.y).sort((a, b) => b - a)[0];
    if (above !== undefined && y < above + step) y = above - step;
  } else {
    y = at.y + KEYBOARD_STEP;
    const below = neighbours.filter((other) => other > at.y).sort((a, b) => a - b)[0];
    if (below !== undefined && y + step > below) y = below + step;
  }
  return placeHeadInStack(heads, id, { side: me.side, y }, area);
}

export interface MiniChatPlacement extends BotBubbleRect {
  /** Which side of the chat its pointer is on: the head's side. */
  caretSide: BotBubbleSide;
  /** The pointer's centre, from the chat's top edge. */
  caretY: number;
}

/**
 * The mini chat beside its head, on the side away from the edge, kept inside
 * the area, with its pointer aimed at the head's centre.
 */
export function miniChatPlacement(head: HeadPosition, side: BotBubbleSide, area: BubbleArea): MiniChatPlacement {
  const width = clamp(area.width - HEAD_SIZE - 3 * EDGE_MARGIN, MINI_CHAT_MIN_WIDTH, MINI_CHAT_MAX_WIDTH);
  const height = Math.max(0, Math.min(MINI_CHAT_MAX_HEIGHT, area.height - 2 * EDGE_MARGIN));
  const wantedX = side === "right" ? head.x - MINI_CHAT_HEAD_GAP - width : head.x + HEAD_SIZE + MINI_CHAT_HEAD_GAP;
  const x = clamp(wantedX, EDGE_MARGIN, area.width - EDGE_MARGIN - width);
  const y = clamp(head.y - MINI_CHAT_RISE, EDGE_MARGIN, area.height - EDGE_MARGIN - height);
  const caretY = clamp(head.y + HEAD_SIZE / 2 - y, MINI_CHAT_CARET_INSET, height - MINI_CHAT_CARET_INSET);
  return { x, y, width, height, caretSide: side, caretY };
}

/**
 * The hover peek beside a head, on the inner side: `x` is its left edge for a
 * left head and its right edge for a right head (it grows away from the head),
 * `y` is the head's centre, which the peek is centred on.
 */
export function peekPlacement(
  head: HeadPosition,
  side: BotBubbleSide,
  area: BubbleArea,
): { side: BotBubbleSide; x: number; y: number; maxWidth: number } {
  const room = side === "right" ? head.x - PEEK_GAP - EDGE_MARGIN : area.width - (head.x + HEAD_SIZE + PEEK_GAP) - EDGE_MARGIN;
  return {
    side,
    x: side === "right" ? head.x - PEEK_GAP : head.x + HEAD_SIZE + PEEK_GAP,
    y: head.y + HEAD_SIZE / 2,
    maxWidth: Math.max(0, Math.min(PEEK_MAX_WIDTH, room)),
  };
}
