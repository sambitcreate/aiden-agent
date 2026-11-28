// Pure helpers for the Bot bubble overlay windows: the window options, which
// displays need an overlay, and the coordinate mapping for the shrink and grow
// animations. Dependency-free so they are checked without Electron.

import type { BotBubbleRect, BotBubbleState } from "../../renderer/shared/bot-bubbles.js";

export interface OverlayDisplay {
  id: number;
  workArea: BotBubbleRect;
}

export interface BotBubbleOverlayOptionsInput {
  preload: string;
  workArea: BotBubbleRect;
}

/**
 * A see-through, click-through panel over one display's work area. It never
 * shows in the Dock, Mission Control or the window list, and can't be moved,
 * resized or made full screen; heads move inside it.
 */
export function botBubbleOverlayWindowOptions(input: BotBubbleOverlayOptionsInput) {
  return {
    x: Math.round(input.workArea.x),
    y: Math.round(input.workArea.y),
    width: Math.max(1, Math.round(input.workArea.width)),
    height: Math.max(1, Math.round(input.workArea.height)),
    type: "panel" as const,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    alwaysOnTop: true,
    // Heads never take keyboard focus from the app the person is in: the panel
    // is made focusable only while a mini chat is open (see setFocusable).
    focusable: false,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    fullscreenable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    webPreferences: {
      preload: input.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Live chats keep streaming while the overlay is not focused.
      backgroundThrottling: false,
    },
  };
}

/** Displays that hold at least one head; a missing or null display id means the primary. */
export function displaysNeedingOverlay(
  state: Pick<BotBubbleState, "bubbles" | "host">,
  displays: readonly OverlayDisplay[],
  primaryDisplayId: number,
): Set<number> {
  const needed = new Set<number>();
  if (state.host !== "overlay") return needed;
  const live = new Set(displays.map((display) => display.id));
  for (const bubble of state.bubbles) {
    const { displayId } = bubble.placement;
    needed.add(displayId !== null && live.has(displayId) ? displayId : primaryDisplayId);
  }
  return needed;
}

/** The display a head sits on now (a missing display falls back to the primary). */
export function bubbleDisplayId(
  displayId: number | null,
  displays: readonly OverlayDisplay[],
  primaryDisplayId: number,
): number {
  return displayId !== null && displays.some((display) => display.id === displayId)
    ? displayId
    : primaryDisplayId;
}

/**
 * A rect in a window's CSS pixels, in an overlay's own CSS pixels: through the
 * window's content bounds (screen) and back from the overlay's work-area origin.
 */
export function windowRectToOverlay(
  rect: BotBubbleRect,
  contentBounds: BotBubbleRect,
  overlayWorkArea: BotBubbleRect,
  zoomFactor = 1,
): BotBubbleRect {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return {
    x: contentBounds.x + rect.x * zoom - overlayWorkArea.x,
    y: contentBounds.y + rect.y * zoom - overlayWorkArea.y,
    width: rect.width * zoom,
    height: rect.height * zoom,
  };
}

/** The main window's content area in an overlay's coordinates: where a grow animation ends. */
export function growTargetRect(
  contentBounds: BotBubbleRect,
  overlayWorkArea: BotBubbleRect,
): BotBubbleRect {
  return {
    x: contentBounds.x - overlayWorkArea.x,
    y: contentBounds.y - overlayWorkArea.y,
    width: contentBounds.width,
    height: contentBounds.height,
  };
}

/** A screen rect clamped to a window's content, for `capturePage`; null when nothing is left. */
export function captureRect(
  rect: BotBubbleRect,
  contentSize: { width: number; height: number },
): BotBubbleRect | null {
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const right = Math.min(contentSize.width, Math.round(rect.x + rect.width));
  const bottom = Math.min(contentSize.height, Math.round(rect.y + rect.height));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** Whether pointer events should pass through: only when nothing under it is ours and no head is dragging. */
export function overlayIgnoresMouse(flags: { interactive: boolean; dragging: boolean }): boolean {
  return !flags.interactive && !flags.dragging;
}

/** At most this many overlay rebuilds per display in `windowMs`, so a crashing page can't loop. */
export const OVERLAY_REBUILD_LIMIT = 3;
export const OVERLAY_REBUILD_WINDOW_MS = 60_000;

/** Record a rebuild at `now`; refused once the display rebuilt too often recently. */
export function allowOverlayRebuild(
  previous: readonly number[],
  now: number,
  limit = OVERLAY_REBUILD_LIMIT,
  windowMs = OVERLAY_REBUILD_WINDOW_MS,
): { allowed: boolean; times: number[] } {
  const recent = previous.filter((time) => now - time < windowMs);
  if (recent.length >= limit) return { allowed: false, times: recent };
  return { allowed: true, times: [...recent, now] };
}

/** A transition older than this is dropped instead of played late. */
export const TRANSITION_STALE_MS = 2_000;

/**
 * Transitions wait until the overlay's page says it is listening (its first
 * `overlayInfo`); then the fresh ones play and stale ones are dropped.
 */
export class PendingTransitions<T> {
  private queue: Array<{ value: T; at: number }> = [];
  private ready = false;

  /** Whether the page listens now (a transition offered now is sent at once). */
  get listening(): boolean {
    return this.ready;
  }

  /** Returns the value when it may be sent now, or null when it was queued. */
  offer(value: T, now: number): T | null {
    if (this.ready) return value;
    this.queue.push({ value, at: now });
    return null;
  }

  /** The page is listening: everything still fresh, in order. */
  markReady(now: number): T[] {
    this.ready = true;
    const fresh = this.queue
      .filter((entry) => now - entry.at <= TRANSITION_STALE_MS)
      .map((entry) => entry.value);
    this.queue = [];
    return fresh;
  }

  /** The page reloaded or crashed: wait for it to listen again. */
  reset(): void {
    this.ready = false;
    this.queue = [];
  }
}

/** Overlay geometry in its page's CSS pixels (the page zooms with every Aiden page of its origin). */
export function overlayCssSize(
  workArea: BotBubbleRect,
  zoomFactor: number,
): { width: number; height: number } {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return { width: workArea.width / zoom, height: workArea.height / zoom };
}

export function scaleRect(rect: BotBubbleRect, zoomFactor: number): BotBubbleRect {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return {
    x: rect.x / zoom,
    y: rect.y / zoom,
    width: rect.width / zoom,
    height: rect.height / zoom,
  };
}

/** ⌘/Ctrl with +, -, = or 0: the zoom shortcuts the overlay ignores. */
export function isZoomShortcut(input: {
  type: string;
  key: string;
  meta: boolean;
  control: boolean;
}): boolean {
  return (
    input.type === "keyDown" &&
    (input.meta || input.control) &&
    ["+", "=", "-", "_", "0"].includes(input.key)
  );
}

/** How an overlay gives up the keyboard. */
export interface OverlayFocusPort {
  isFocused(): boolean;
  setFocusable(focusable: boolean): void;
  /** Move key-window status off the overlay while it stays on screen; may do nothing. */
  passKeyOn(): void;
  /** Electron's `blur()`: on macOS it orders the window out and back in, which blinks everything it draws. */
  blur(): void;
}

/**
 * The open mini chat closed: the overlay stops taking the keyboard. It is made
 * unfocusable first, so nothing hands the key window back to it, then key
 * status is passed on without taking the overlay off screen. `blur()` is the
 * last resort, used only when the overlay is still the key window after that.
 */
export function releaseOverlayFocus(port: OverlayFocusPort): "idle" | "passed" | "blurred" {
  port.setFocusable(false);
  if (!port.isFocused()) return "idle";
  try {
    port.passKeyOn();
  } catch {
    // Fall through to the blur.
  }
  if (!port.isFocused()) return "passed";
  port.blur();
  return "blurred";
}

/** Main waits this long for an overlay to show a shrink's still picture before bubbling anyway. */
export const COVER_WAIT_MS = 250;

/**
 * Shrinks waiting for their overlay to say the still picture is on screen.
 * Each wait ends when that overlay answers or after `waitMs`, whichever is
 * first; an answer from any other page is ignored.
 */
export class CoverWaits {
  private next = 0;
  private readonly waiting = new Map<number, { owner: number; done(): void }>();

  /** A new wait for the overlay page `owner`: the number to send with the transition and the promise that ends the wait. */
  start(owner: number, waitMs = COVER_WAIT_MS): { cover: number; shown: Promise<void> } {
    const cover = ++this.next;
    const shown = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(cover);
        resolve();
      }, waitMs);
      this.waiting.set(cover, {
        owner,
        done: () => {
          clearTimeout(timer);
          this.waiting.delete(cover);
          resolve();
        },
      });
    });
    return { cover, shown };
  }

  /** The page `owner` says `cover` is on screen. */
  settle(cover: number, owner: number): void {
    const wait = this.waiting.get(cover);
    if (wait && wait.owner === owner) wait.done();
  }
}
