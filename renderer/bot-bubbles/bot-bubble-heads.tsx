// The bubble layer for one area: every head, the × target while one is
// dragged, the hover peek, the right-click menu and the open mini chat. Both
// hosts use it: the see-through overlay window (one per display) and the
// Aiden window when heads stay inside it.
//
// Heads stack per side without overlapping; drag one anywhere and it snaps to
// the nearest side on release (a flick throws it across), or closes over the ×.
// Keyboard: Tab reaches each head, Enter opens, Delete or Backspace closes,
// Left and Right switch sides, Up and Down move it, Escape tucks the chat away.

import * as React from "react";
import { AlertTriangle, X } from "lucide-react";
import { AvatarFace } from "../components/bot-avatar";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Text,
  toast,
} from "../components/ui";
import { applyBotBubbleChange, botBubblesApi } from "../lib/bot-bubbles-api";
import { useBotCanonicalPhoto } from "../lib/bot-canonical-photo-cache";
import { userFacingErrorMessage } from "../lib/ipc-error";
import { DEFAULT_BOT_AVATAR } from "../shared/bots";
import type { BotBubble, BotBubbleState } from "../shared/bot-bubbles";
import {
  BOT_BUBBLE_HIT_SELECTOR,
  BotBubbleMiniChat,
} from "./bot-bubble-mini-chat";
import { botHeadLabel, botUnreadBadge, useBotHeadStatus } from "./bot-head-status";
import {
  closeTargetCentre,
  isHeadMoveKey,
  isOverCloseTarget,
  miniChatPlacement,
  moveStackedHeadWithKey,
  peekPlacement,
  placeHeadInStack,
  releaseHead,
  shareToY,
  stackHeads,
  yToShare,
  type BubbleArea,
  type HeadPosition,
  type HeadSpot,
  type MiniChatPlacement,
} from "./head-layout";

/** A press that moves less than this is a click, not a drag. */
const DRAG_THRESHOLD = 4;
/** Pointer samples this recent set a flick's speed. */
const FLICK_WINDOW_MS = 90;
/** Hovering this long shows the peek. */
const PEEK_DELAY_MS = 450;

export interface BotBubbleHeadsProps {
  bubbles: readonly BotBubble[];
  openBotId: string | null;
  area: BubbleArea;
  host: Exclude<BotBubbleState["host"], "off">;
  /** The pointer moved onto or off the layer's own surfaces (heads, peek, ×, menus, chat). */
  onInteractiveChange?(interactive: boolean): void;
  /** A head drag started or ended. */
  onDraggingChange?(dragging: boolean): void;
}

interface DragState {
  botId: string;
  x: number;
  y: number;
  hot: boolean;
}

interface Gesture {
  botId: string;
  pointerId: number;
  startX: number;
  startY: number;
  origin: HeadPosition;
  moved: boolean;
  samples: { t: number; x: number; y: number }[];
}

function report(change: Promise<unknown>, fallback: string) {
  void change.catch((error: unknown) =>
    toast.error(userFacingErrorMessage(error, fallback)),
  );
}

const toggleOpen = (botId: string, openBotId: string | null) =>
  report(
    applyBotBubbleChange(
      botBubblesApi.open(openBotId === botId ? null : botId),
    ),
    "Aiden couldn’t open that chat.",
  );
const closeBubble = (botId: string) =>
  report(
    applyBotBubbleChange(botBubblesApi.close(botId)),
    "Aiden couldn’t close that bubble.",
  );

function velocityOf(samples: Gesture["samples"]): { x: number; y: number } {
  const last = samples[samples.length - 1];
  const first = samples.find(
    (sample) => last !== undefined && last.t - sample.t <= FLICK_WINDOW_MS,
  );
  if (!last || !first || last.t - first.t < 8) return { x: 0, y: 0 };
  const dt = last.t - first.t;
  return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
}

export function BotBubbleHeads({
  bubbles,
  openBotId,
  area,
  host,
  onInteractiveChange,
  onDraggingChange,
}: BotBubbleHeadsProps) {
  const layerRef = React.useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = React.useState<DragState | null>(null);
  const [peekBotId, setPeekBotId] = React.useState<string | null>(null);
  // Where a head was just put, until main's state says so.
  const [pending, setPending] = React.useState<
    Readonly<Record<string, HeadSpot>>
  >({});
  const gesture = React.useRef<Gesture | null>(null);
  const suppressClick = React.useRef(false);
  const peekTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const interactive = React.useRef(false);
  /** Where the pointer last was, to ask again what is under it when a surface goes away. */
  const pointer = React.useRef<{ x: number; y: number } | null>(null);
  const callbacks = React.useRef({ onInteractiveChange, onDraggingChange });
  callbacks.current = { onInteractiveChange, onDraggingChange };

  // Drop a held spot once main's state shows it (or the head is gone); keep the others.
  React.useEffect(() => {
    setPending((current) => {
      let changed = false;
      const next: Record<string, HeadSpot> = {};
      for (const [botId, spot] of Object.entries(current)) {
        const bubble = bubbles.find((item) => item.botId === botId);
        const confirmed =
          !bubble ||
          (bubble.placement.side === spot.side &&
            Math.abs(bubble.placement.y - yToShare(spot.y, area)) < 1e-6);
        if (confirmed) changed = true;
        else next[botId] = spot;
      }
      return changed ? next : current;
    });
  }, [bubbles, area]);
  React.useEffect(() => () => clearTimeout(peekTimer.current), []);

  const spots = bubbles.map((bubble) => ({
    bubble,
    spot: pending[bubble.botId] ?? {
      side: bubble.placement.side,
      y: shareToY(bubble.placement.y, area),
    },
  }));
  const wantedSpots = spots.map(({ bubble, spot }) => ({
    id: bubble.botId,
    ...spot,
  }));
  const positions = stackHeads(
    spots
      .filter(({ bubble }) => bubble.botId !== drag?.botId)
      .map(({ bubble, spot }) => ({ id: bubble.botId, ...spot })),
    area,
  );
  const sideOf = (botId: string) =>
    spots.find(({ bubble }) => bubble.botId === botId)?.spot.side ?? "right";
  const positionOf = (botId: string): HeadPosition | undefined =>
    drag?.botId === botId ? { x: drag.x, y: drag.y } : positions.get(botId);

  const setInteractive = React.useCallback((next: boolean) => {
    if (interactive.current === next) return;
    interactive.current = next;
    callbacks.current.onInteractiveChange?.(next);
  }, []);

  // Main's flag may be left over from an earlier layer: say where things stand now, and reset on the way out.
  React.useEffect(() => {
    callbacks.current.onInteractiveChange?.(interactive.current);
    return () => {
      interactive.current = false;
      callbacks.current.onInteractiveChange?.(false);
      callbacks.current.onDraggingChange?.(false);
    };
  }, []);

  // Click-through: the host learns whenever the pointer is over one of the layer's surfaces.
  // While a menu is open the whole layer takes clicks, so a click beside the menu closes it.
  React.useEffect(() => {
    const onMove = (event: MouseEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      if (gesture.current?.moved || document.querySelector('[role="menu"]'))
        return setInteractive(true);
      const target = event.target instanceof Element ? event.target : null;
      setInteractive(Boolean(target?.closest(BOT_BUBBLE_HIT_SELECTOR)));
    };
    const onLeave = () => {
      if (!gesture.current) setInteractive(false);
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("pointermove", onMove, true);
    document.documentElement.addEventListener("mouseleave", onLeave);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("pointermove", onMove, true);
      document.documentElement.removeEventListener("mouseleave", onLeave);
    };
  }, [setInteractive]);

  // A click anywhere else tucks the open chat away. In the overlay, clicks
  // elsewhere reach other apps, so the overlay losing focus does the same.
  // Each tuck names the chat it closes: by the time it lands, another display
  // may have opened a different one, which it must leave alone.
  React.useEffect(() => {
    if (openBotId === null) return;
    const tuck = () =>
      report(
        applyBotBubbleChange(botBubblesApi.open(null, { ifOpen: openBotId })),
        "Aiden couldn’t tuck that chat away.",
      );
    const tuckIfOutside = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(BOT_BUBBLE_HIT_SELECTOR)) return;
      tuck();
    };
    document.addEventListener("pointerdown", tuckIfOutside, true);
    if (host === "overlay") window.addEventListener("blur", tuck);
    return () => {
      document.removeEventListener("pointerdown", tuckIfOutside, true);
      window.removeEventListener("blur", tuck);
    };
  }, [host, openBotId]);

  const persist = (bubble: BotBubble, spot: HeadSpot) => {
    setPending((current) => ({ ...current, [bubble.botId]: spot }));
    void applyBotBubbleChange(
      botBubblesApi.move(bubble.botId, {
        side: spot.side,
        y: yToShare(spot.y, area),
        displayId: bubble.placement.displayId,
      }),
    ).catch((error: unknown) => {
      // Back to where main has it.
      setPending((current) => {
        if (current[bubble.botId] !== spot) return current;
        const { [bubble.botId]: _dropped, ...rest } = current;
        return rest;
      });
      toast.error(
        userFacingErrorMessage(error, "Aiden couldn’t move that bubble."),
      );
    });
  };

  const endDrag = () => {
    setDrag(null);
    callbacks.current.onDraggingChange?.(false);
  };

  const onPointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
    bubble: BotBubble,
  ) => {
    if (event.button !== 0) return;
    const origin = positionOf(bubble.botId);
    if (!origin) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic pointer can't be captured; the drag still follows it.
    }
    gesture.current = {
      botId: bubble.botId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin,
      moved: false,
      samples: [{ t: event.timeStamp, x: event.clientX, y: event.clientY }],
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      current.moved = true;
      setPeekBotId(null);
      setInteractive(true);
      callbacks.current.onDraggingChange?.(true);
    }
    current.samples.push({
      t: event.timeStamp,
      x: event.clientX,
      y: event.clientY,
    });
    if (current.samples.length > 12) current.samples.shift();
    const position = { x: current.origin.x + dx, y: current.origin.y + dy };
    setDrag({
      botId: current.botId,
      ...position,
      hot: isOverCloseTarget(position, area),
    });
  };

  const onPointerUp = (
    event: React.PointerEvent<HTMLButtonElement>,
    bubble: BotBubble,
  ) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (!current.moved) return;
    suppressClick.current = true;
    current.samples.push({
      t: event.timeStamp,
      x: event.clientX,
      y: event.clientY,
    });
    const position = {
      x: current.origin.x + event.clientX - current.startX,
      y: current.origin.y + event.clientY - current.startY,
    };
    if (isOverCloseTarget(position, area)) {
      // The head stays on the × until main drops it, rather than springing back to its side first.
      callbacks.current.onDraggingChange?.(false);
      void applyBotBubbleChange(botBubblesApi.close(bubble.botId)).catch(
        (error: unknown) => {
          setDrag((now) => (now?.botId === bubble.botId ? null : now));
          toast.error(
            userFacingErrorMessage(error, "Aiden couldn’t close that bubble."),
          );
        },
      );
      return;
    }
    endDrag();
    persist(
      bubble,
      placeHeadInStack(
        wantedSpots,
        bubble.botId,
        releaseHead(position, velocityOf(current.samples), area),
        area,
      ),
    );
  };

  const onPointerCancel = () => {
    if (!gesture.current) return;
    const moved = gesture.current.moved;
    gesture.current = null;
    if (moved) endDrag();
  };

  // A head that goes away mid-drag (closed elsewhere, pushed out) never sees its
  // pointerup: end the gesture so the × goes and the overlay passes clicks again.
  const draggedBotId = drag?.botId;
  React.useEffect(() => {
    const botId = gesture.current?.botId ?? draggedBotId;
    if (botId === undefined || bubbles.some((bubble) => bubble.botId === botId))
      return;
    const moved = gesture.current?.moved ?? true;
    gesture.current = null;
    if (!moved) return;
    endDrag();
    setInteractive(false);
  });

  const focusNeighbour = (botId: string) => {
    const heads = Array.from(
      layerRef.current?.querySelectorAll<HTMLElement>("[data-bubble-head]") ??
        [],
    );
    const at = heads.findIndex((head) => head.dataset.bubbleHead === botId);
    (heads[at + 1] ?? heads[at - 1])?.focus();
  };

  const onKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    bubble: BotBubble,
  ) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      focusNeighbour(bubble.botId);
      closeBubble(bubble.botId);
      return;
    }
    if (event.key === "Escape" && openBotId !== null) {
      event.preventDefault();
      report(
        applyBotBubbleChange(botBubblesApi.open(null)),
        "Aiden couldn’t tuck that chat away.",
      );
      return;
    }
    if (isHeadMoveKey(event.key)) {
      const spot = moveStackedHeadWithKey(
        wantedSpots,
        bubble.botId,
        event.key,
        area,
      );
      if (!spot) return;
      event.preventDefault();
      persist(bubble, spot);
    }
  };

  const showPeekSoon = (botId: string) => {
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeekBotId(botId), PEEK_DELAY_MS);
  };
  const hidePeek = () => {
    clearTimeout(peekTimer.current);
    setPeekBotId(null);
  };

  const openPosition =
    openBotId !== null && drag?.botId !== openBotId
      ? positions.get(openBotId)
      : undefined;
  // While its head is dragged the chat stays mounted but hidden, so a half-written message survives.
  const lastChatPlacement = React.useRef<{
    botId: string;
    placement: MiniChatPlacement;
  } | null>(null);
  // A chat that was just tucked away stays where it was, inert, until its exit
  // has played; it is the same element all along, so nothing blinks or remounts.
  const [chats, setChats] = React.useState<{
    open: string | null;
    leaving: { botId: string; placement: MiniChatPlacement } | null;
  }>({ open: openBotId, leaving: null });
  let leavingChat = chats.leaving;
  if (chats.open !== openBotId) {
    const last = lastChatPlacement.current;
    const wasShown =
      chats.open !== null &&
      last?.botId === chats.open &&
      drag?.botId !== chats.open;
    leavingChat = wasShown
      ? last
      : leavingChat?.botId === openBotId
        ? null
        : leavingChat;
  }
  // A chat whose head is gone goes with it.
  const leavingId = leavingChat?.botId;
  if (
    leavingId !== undefined &&
    !bubbles.some((bubble) => bubble.botId === leavingId)
  )
    leavingChat = null;
  if (chats.open !== openBotId || chats.leaving !== leavingChat)
    setChats({ open: openBotId, leaving: leavingChat });
  const chatLeft = React.useCallback(
    (botId: string) =>
      setChats((now) =>
        now.leaving?.botId === botId ? { ...now, leaving: null } : now,
      ),
    [],
  );
  // The pointer may now rest on nothing of ours (Escape closed the chat under it).
  const leavingBotId = leavingChat?.botId ?? null;
  React.useEffect(() => {
    const at = pointer.current;
    if (!at || gesture.current || typeof document.elementFromPoint !== "function")
      return;
    if (document.querySelector('[role="menu"]')) return;
    const under = document.elementFromPoint(at.x, at.y);
    setInteractive(Boolean(under?.closest(BOT_BUBBLE_HIT_SELECTOR)));
  }, [openBotId, leavingBotId, setInteractive]);
  if (openBotId !== null && openPosition)
    lastChatPlacement.current = {
      botId: openBotId,
      placement: miniChatPlacement(openPosition, sideOf(openBotId), area),
    };
  const chatHidden = openBotId !== null && drag?.botId === openBotId;
  const chatPlacement =
    openBotId !== null &&
    (openPosition || chatHidden) &&
    lastChatPlacement.current?.botId === openBotId
      ? lastChatPlacement.current.placement
      : null;
  const target = closeTargetCentre(area);
  const peekPosition =
    peekBotId !== null && !drag && peekBotId !== openBotId
      ? positions.get(peekBotId)
      : undefined;

  return (
    <div ref={layerRef} className="bot-bubble-layer" data-host={host}>
      {drag ? (
        <div
          aria-hidden="true"
          data-bubble-hit=""
          data-bubble-close-target=""
          className="bot-bubble-close-target"
          data-hot={drag.hot ? "" : undefined}
          style={{ left: target.x, top: target.y }}
        >
          <X className="size-6" />
        </div>
      ) : null}
      {bubbles.map((bubble) => {
        const position = positionOf(bubble.botId);
        if (!position) return null;
        return (
          // The chat follows its own head in the page, so Tab goes from the head into its chat.
          <React.Fragment key={bubble.botId}>
            <BotBubbleHead
              botId={bubble.botId}
              position={position}
              open={openBotId === bubble.botId}
              dragging={drag?.botId === bubble.botId}
              magnet={drag?.botId === bubble.botId && drag.hot}
              live={host === "overlay"}
              peekShown={
                peekPosition !== undefined && peekBotId === bubble.botId
              }
              peek={
                peekPosition !== undefined && peekBotId === bubble.botId
                  ? peekPlacement(peekPosition, sideOf(bubble.botId), area)
                  : null
              }
              onOpen={() => {
                if (suppressClick.current) {
                  suppressClick.current = false;
                  return;
                }
                hidePeek();
                toggleOpen(bubble.botId, openBotId);
              }}
              onOpenInAiden={() =>
                report(
                  applyBotBubbleChange(botBubblesApi.bringBack(bubble.botId)),
                  "Aiden couldn’t open that chat.",
                )
              }
              onOpenFromMenu={() => {
                if (openBotId !== bubble.botId)
                  toggleOpen(bubble.botId, openBotId);
              }}
              onClose={() => closeBubble(bubble.botId)}
              onPointerDown={(event) => onPointerDown(event, bubble)}
              onPointerMove={onPointerMove}
              onPointerUp={(event) => onPointerUp(event, bubble)}
              onPointerCancel={onPointerCancel}
              onLostPointerCapture={onPointerCancel}
              onKeyDown={(event) => onKeyDown(event, bubble)}
              onHover={(hovering) =>
                hovering ? showPeekSoon(bubble.botId) : hidePeek()
              }
            />
            {openBotId === bubble.botId && chatPlacement ? (
              <BotBubbleMiniChat
                botId={bubble.botId}
                placement={chatPlacement}
                hidden={chatHidden}
                offerAuto={host === "window"}
              />
            ) : leavingChat?.botId === bubble.botId ? (
              <BotBubbleMiniChat
                botId={bubble.botId}
                placement={leavingChat.placement}
                closing
                onClosed={() => chatLeft(bubble.botId)}
                offerAuto={host === "window"}
              />
            ) : null}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/** A head waits this long for its Bot's photo before it shows the drawn face instead. */
const HEAD_PHOTO_WAIT_MS = 600;

type HeadPhoto = ReturnType<typeof useBotCanonicalPhoto>;

/**
 * The Bot's photo for a head. While the photo cache reloads (it is emptied
 * whenever a head is added) the photo already on the head stays, so a new
 * head never makes the others blink to their drawn faces and back. `settled`
 * is false until the first answer, or until the wait runs out.
 */
function useHeadPhoto(botId: string): {
  photo: NonNullable<HeadPhoto> | null;
  settled: boolean;
} {
  const latest = useBotCanonicalPhoto(botId, true, "selected");
  const held = React.useRef<HeadPhoto>(undefined);
  if (latest !== undefined) held.current = latest;
  const [waitedOut, setWaitedOut] = React.useState(false);
  const known = held.current !== undefined;
  React.useEffect(() => {
    if (known) return;
    const timer = setTimeout(() => setWaitedOut(true), HEAD_PHOTO_WAIT_MS);
    return () => clearTimeout(timer);
  }, [known]);
  return { photo: held.current ?? null, settled: known || waitedOut };
}

function HeadFace({
  avatar,
  name,
  photo,
}: {
  avatar: Parameters<typeof AvatarFace>[0]["avatar"];
  name: string;
  photo: NonNullable<HeadPhoto> | null;
}) {
  const [failed, setFailed] = React.useState<string>();
  const showPhoto = photo && failed !== photo.assetRevision;
  return (
    <span className="bot-bubble-face" aria-hidden="true" title={name}>
      <AvatarFace avatar={avatar} />
      {showPhoto ? (
        <img
          alt=""
          draggable={false}
          // Decoded with the frame that first shows it, so the drawn face never shows through for a frame.
          decoding="sync"
          src={photo.dataUrl}
          onError={() => setFailed(photo.assetRevision)}
        />
      ) : null}
    </span>
  );
}

interface BotBubbleHeadProps {
  botId: string;
  position: HeadPosition;
  open: boolean;
  dragging: boolean;
  magnet: boolean;
  live: boolean;
  peekShown: boolean;
  peek: ReturnType<typeof peekPlacement> | null;
  onOpen(): void;
  onOpenFromMenu(): void;
  onOpenInAiden(): void;
  onClose(): void;
  onPointerDown(event: React.PointerEvent<HTMLButtonElement>): void;
  onPointerMove(event: React.PointerEvent<HTMLButtonElement>): void;
  onPointerUp(event: React.PointerEvent<HTMLButtonElement>): void;
  onPointerCancel(): void;
  onLostPointerCapture(): void;
  onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void;
  onHover(hovering: boolean): void;
}

function BotBubbleHead(props: BotBubbleHeadProps) {
  const { botId, position, open, dragging, magnet, live, peek } = props;
  const status = useBotHeadStatus(botId, { live, viewing: open });
  const { photo, settled } = useHeadPhoto(botId);
  // Drawn only once its Bot and photo are known, so a new head fades in with
  // its real face instead of flashing the default one first.
  const arriving = status.loading || !settled;
  const peekId = `bot-bubble-peek-${botId}`;
  const count = status.unreadCount;
  return (
    <>
      {/* Not modal: a modal menu stops pointer events on the page, which in the overlay would leave it click-through with the menu stuck open. */}
      <ContextMenu modal={false}>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            data-bubble-hit=""
            data-bubble-head={botId}
            aria-label={botHeadLabel(status)}
            aria-expanded={open}
            aria-describedby={props.peekShown ? peekId : undefined}
            className="bot-bubble-head"
            data-arriving={arriving ? "" : undefined}
            data-dragging={dragging ? "" : undefined}
            data-magnet={magnet ? "" : undefined}
            style={{ translate: `${position.x}px ${position.y}px` }}
            onClick={props.onOpen}
            onPointerDown={props.onPointerDown}
            onPointerMove={props.onPointerMove}
            onPointerUp={props.onPointerUp}
            onPointerCancel={props.onPointerCancel}
            onLostPointerCapture={props.onLostPointerCapture}
            onKeyDown={props.onKeyDown}
            onPointerEnter={() => props.onHover(true)}
            onPointerLeave={() => props.onHover(false)}
          >
            <HeadFace
              avatar={status.bot?.avatar ?? DEFAULT_BOT_AVATAR}
              name={status.name}
              photo={photo}
            />
            {status.working ? (
              <span aria-hidden="true" className="bot-bubble-ring" />
            ) : null}
            {status.unread ? (
              <span
                aria-hidden="true"
                className="bot-bubble-badge bg-fill-accent text-mini font-semibold text-fill-accent-foreground"
              >
                {count === null ? "" : botUnreadBadge(count)}
              </span>
            ) : null}
            {status.needsYou ? (
              <span aria-hidden="true" className="bot-bubble-needs">
                <span className="bg-status-warning-surface text-status-warning">
                  <AlertTriangle className="size-3" />
                </span>
              </span>
            ) : null}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent data-bubble-hit="">
          <ContextMenuItem onSelect={props.onOpenFromMenu}>
            Open
          </ContextMenuItem>
          <ContextMenuItem onSelect={props.onOpenInAiden}>
            Open in Aiden
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={props.onClose}>
            Close bubble
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {peek ? (
        <div
          id={peekId}
          role="tooltip"
          data-bubble-hit=""
          className="bot-bubble-peek"
          data-side={peek.side}
          style={{ left: peek.x, top: peek.y, maxWidth: peek.maxWidth }}
        >
          <Text as="p" variant="small-strong" truncate>
            {status.name}
          </Text>
          {status.line ? (
            <Text
              as="p"
              variant="small"
              color="secondary"
              className="line-clamp-2"
            >
              {status.line}
            </Text>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
