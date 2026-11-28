// The see-through bubble overlay over one display (macOS). Clicks pass
// through to the apps below except over a head, the peek, the ×, a menu or the
// open chat, which the layer reports so main can stop ignoring the mouse.
// Main also sends the shrink and grow between the Aiden window and a head.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useBotBubbles, botBubblesApi } from "../lib/bot-bubbles-api";
import { invalidateForBotsChanged } from "../lib/bot-notifications-sync";
import { onNotification } from "../lib/ipc-bridge";
import { queryKeys } from "../lib/queries";
import { invalidateBotCanonicalPhotos } from "../lib/bot-canonical-photo-cache";
import { prefersReducedMotion } from "../lib/appearance-runtime";
import type { BotBubble, BotBubbleOverlayInfo, BotBubbleTransition } from "../shared/bot-bubbles";
import { BotBubbleHeads } from "./bot-bubble-heads";
import { HEAD_SIZE, shareToY, stackHeads, type BubbleArea, type HeadPosition } from "./head-layout";
import { useViewportArea } from "./window-host";

type OverlayInfoState =
  | { kind: "loading" }
  | { kind: "ready"; info: BotBubbleOverlayInfo }
  | { kind: "failed" };

/** The heads that belong on this overlay's display; a null display is the primary one. */
export function bubblesForOverlay(
  bubbles: readonly BotBubble[],
  info: OverlayInfoState,
): readonly BotBubble[] {
  if (info.kind === "failed") return bubbles;
  if (info.kind === "loading") return [];
  const { displayId, primary = true } = info.info;
  return bubbles.filter((bubble) =>
    bubble.placement.displayId === null ? primary : bubble.placement.displayId === displayId,
  );
}

/** Keeps this window's Bot reads current: a Bot's definition, photo and live summary. */
function useOverlayBotSync() {
  const queryClient = useQueryClient();
  React.useEffect(() => {
    const stopChanged = onNotification(
      "bots:changed",
      (payload: unknown) => void invalidateForBotsChanged(queryClient, payload),
    );
    const stopAttention = onNotification("bots:attention", (payload: unknown) => {
      const botId =
        payload && typeof payload === "object" ? (payload as { botId?: unknown }).botId : undefined;
      if (typeof botId === "string" && botId)
        void queryClient.invalidateQueries({ queryKey: queryKeys.botLiveSummary(botId) });
    });
    return () => {
      stopChanged();
      stopAttention();
    };
  }, [queryClient]);
  // This window hears nothing about a Bot while it isn't bubbled, so a Bot that
  // comes (back) as a head is read afresh: its definition, photo and summary.
  const bubbledIds = useBotBubbles()
    .bubbles.map((bubble) => bubble.botId)
    .join("\n");
  const known = React.useRef<ReadonlySet<string> | null>(null);
  React.useEffect(() => {
    const ids = new Set(bubbledIds ? bubbledIds.split("\n") : []);
    const before = known.current;
    known.current = ids;
    if (!before) return;
    const added = [...ids].filter((id) => !before.has(id));
    if (added.length === 0) return;
    invalidateBotCanonicalPhotos();
    for (const id of added) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.bot(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.botLiveSummary(id) });
    }
  }, [bubbledIds, queryClient]);
}

function cssToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** A transition with the head it flies to or from, as known when it arrived. */
export type OverlayTransition = BotBubbleTransition & { key: number; head: HeadPosition | null };

/** A shrink waits this long for its head before it fades out where it is. */
export const SHRINK_HEAD_WAIT_MS = 600;

/** Two frames from now: what was just rendered is on screen by then. */
function afterPaint(run: () => void): () => void {
  let second = 0;
  const first = requestAnimationFrame(() => {
    second = requestAnimationFrame(run);
  });
  return () => {
    cancelAnimationFrame(first);
    cancelAnimationFrame(second);
  };
}

/**
 * The shrink (the captured chat scales and fades into its head) or the grow
 * (the head swells toward the Aiden window's chat, then fades). It runs once
 * per transition: re-renders never restart or cut it short.
 *
 * A shrink draws nothing until its picture is decoded, then shows it still,
 * says so (`onShown`, which lets the Aiden window swap its chat for the card
 * underneath) and moves only once its head is there. With Reduce Motion the
 * shrink is a short fade in place and the grow is skipped.
 */
export function BotBubbleTransitionView({
  transition,
  head,
  onShown,
  onDone,
}: {
  transition: OverlayTransition;
  /** Where the head is now; null until it exists. */
  head: HeadPosition | null;
  onShown?(): void;
  onDone(): void;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const imageRef = React.useRef<HTMLImageElement | null>(null);
  const callbacks = React.useRef({ onShown, onDone });
  callbacks.current = { onShown, onDone };
  const { rect, kind, image } = transition;
  // A grow with nowhere to start, or with Reduce Motion, would only flash a window-sized sheet.
  const skipped = kind === "grow" && (!head || prefersReducedMotion());
  const [pictured, setPictured] = React.useState(image === null);
  const [waitedOut, setWaitedOut] = React.useState(false);
  const animation = React.useRef<Animation | null>(null);

  React.useEffect(() => {
    if (skipped) callbacks.current.onDone();
  }, [skipped]);

  // The picture is decoded before anything shows, so the first frame is never an empty sheet.
  React.useEffect(() => {
    if (image === null) return;
    let active = true;
    const element = imageRef.current;
    const ready = () => {
      if (active) setPictured(true);
    };
    if (element && typeof element.decode === "function") void element.decode().then(ready, ready);
    else ready();
    return () => {
      active = false;
    };
  }, [image]);

  React.useEffect(() => {
    if (!pictured || kind !== "shrink") return;
    const stopShown = afterPaint(() => callbacks.current.onShown?.());
    const timer = setTimeout(() => setWaitedOut(true), SHRINK_HEAD_WAIT_MS);
    return () => {
      stopShown();
      clearTimeout(timer);
    };
  }, [pictured, kind]);

  const headKnown = head !== null;
  const latestHead = React.useRef(head);
  latestHead.current = head;
  React.useLayoutEffect(() => {
    if (skipped || animation.current || !pictured) return;
    // A shrink holds still until its head exists (or never comes).
    if (kind === "shrink" && !headKnown && !waitedOut) return;
    const element = ref.current;
    if (!element || typeof element.animate !== "function") {
      callbacks.current.onDone();
      return;
    }
    const to = latestHead.current;
    let started: Animation;
    if (prefersReducedMotion() || !to) {
      started = element.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 150,
        easing: cssToken("--motion-easing", "ease-out"),
        fill: "forwards",
      });
    } else {
      const scale = HEAD_SIZE / Math.max(1, rect.width);
      const dx = to.x + HEAD_SIZE / 2 - (rect.x + rect.width / 2);
      const dy = to.y + HEAD_SIZE / 2 - (rect.y + rect.height / 2);
      const small = {
        transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
        borderRadius: `${rect.width / 2}px`,
        opacity: 0,
      };
      const big = { transform: "translate(0, 0) scale(1)", borderRadius: "", opacity: 1 };
      started = element.animate(
        kind === "shrink"
          ? [big, small]
          : [
              { ...small, opacity: 1 },
              { ...big, opacity: 0.9 },
              { ...big, opacity: 0 },
            ],
        { duration: 340, easing: cssToken("--motion-large-easing", "ease-out"), fill: "forwards" },
      );
    }
    animation.current = started;
    // Only the animation itself ends the transition; cancelling it on unmount does not.
    started.onfinish = () => callbacks.current.onDone();
    started.oncancel = () => callbacks.current.onDone();
  }, [skipped, pictured, kind, headKnown, waitedOut, rect]);
  React.useEffect(
    () => () => {
      const running = animation.current;
      if (!running) return;
      running.onfinish = null;
      running.oncancel = null;
      running.cancel();
    },
    [],
  );

  if (skipped) return null;
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-bubble-transition={kind}
      className="bot-bubble-transition bg-popover"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        // Kept in layout while the picture decodes, so it can be decoded and animated.
        ...(pictured ? {} : { visibility: "hidden" as const }),
      }}
    >
      {image ? <img ref={imageRef} alt="" decoding="sync" src={image} draggable={false} /> : null}
    </div>
  );
}

function headPosition(
  bubbles: readonly BotBubble[],
  botId: string,
  area: BubbleArea,
): HeadPosition | null {
  const positions = stackHeads(
    bubbles.map((bubble) => ({
      id: bubble.botId,
      side: bubble.placement.side,
      y: shareToY(bubble.placement.y, area),
    })),
    area,
  );
  return positions.get(botId) ?? null;
}

/** This overlay's display and size: read once, again when main says it changed, and on resize. */
function useOverlayInfo(): OverlayInfoState {
  const [info, setInfo] = React.useState<OverlayInfoState>({ kind: "loading" });
  React.useEffect(() => {
    let active = true;
    let read = 0;
    const refresh = () => {
      const asked = ++read;
      botBubblesApi
        .overlayInfo()
        .then((next) => {
          if (active && asked === read) setInfo({ kind: "ready", info: next });
        })
        .catch(() => {
          if (active && asked === read)
            setInfo((current) => (current.kind === "ready" ? current : { kind: "failed" }));
        });
    };
    refresh();
    // Main pushes display and zoom changes; a resize re-reads as well.
    const stopChanged = botBubblesApi.onOverlayInfoChanged((next) => {
      read += 1;
      if (active) setInfo({ kind: "ready", info: next });
    });
    window.addEventListener("resize", refresh);
    return () => {
      active = false;
      stopChanged();
      window.removeEventListener("resize", refresh);
    };
  }, []);
  return info;
}

/** Where each head last sat, so a grow can leave from a head main already removed. */
const lastHead = new Map<string, HeadPosition>();

export function BotBubbleOverlayApp() {
  const state = useBotBubbles();
  const viewport = useViewportArea();
  const info = useOverlayInfo();
  const [transitions, setTransitions] = React.useState<readonly OverlayTransition[]>([]);
  useOverlayBotSync();

  const area: BubbleArea = React.useMemo(
    () =>
      info.kind === "ready" && info.info.width > 0 && info.info.height > 0
        ? { width: info.info.width, height: info.info.height }
        : viewport,
    [info, viewport],
  );
  const bubbles = React.useMemo(
    () => bubblesForOverlay(state.bubbles, info),
    [state.bubbles, info],
  );
  const openBotId =
    state.openBotId !== null && bubbles.some((bubble) => bubble.botId === state.openBotId)
      ? state.openBotId
      : null;
  const showing = state.host === "overlay" && bubbles.length > 0;

  // Remember where this display's heads sit, for a grow that leaves from a closed one.
  React.useEffect(() => {
    for (const bubble of bubbles) {
      const position = headPosition(bubbles, bubble.botId, area);
      if (position) lastHead.set(bubble.botId, position);
    }
  }, [bubbles, area]);

  const latest = React.useRef({ bubbles, area });
  latest.current = { bubbles, area };
  React.useEffect(() => {
    let next = 0;
    return botBubblesApi.onTransition((transition) => {
      next += 1;
      const { bubbles: shown, area: now } = latest.current;
      // A grow leaves from its head, or from where a head main already removed last sat.
      // A shrink lands on its head, which may not exist yet: it is looked up again as heads change.
      const head =
        headPosition(shown, transition.botId, now) ??
        (transition.kind === "grow" ? (lastHead.get(transition.botId) ?? null) : null);
      const item: OverlayTransition = { ...transition, key: next, head };
      setTransitions((current) => [
        ...current.filter((other) => other.botId !== transition.botId),
        item,
      ]);
    });
  }, []);

  const onInteractiveChange = React.useCallback((interactive: boolean) => {
    void botBubblesApi.setInteractive(interactive).catch(() => undefined);
  }, []);
  const onDraggingChange = React.useCallback((dragging: boolean) => {
    void botBubblesApi.setDragging(dragging).catch(() => undefined);
  }, []);
  // With no heads drawn here, nothing is under the pointer: clicks pass through and nothing is dragged.
  React.useEffect(() => {
    if (showing) return;
    onInteractiveChange(false);
    onDraggingChange(false);
  }, [showing, onInteractiveChange, onDraggingChange]);
  const finish = React.useCallback(
    (key: number) => setTransitions((current) => current.filter((item) => item.key !== key)),
    [],
  );

  return (
    <>
      {showing ? (
        <BotBubbleHeads
          bubbles={bubbles}
          openBotId={openBotId}
          area={area}
          host="overlay"
          onInteractiveChange={onInteractiveChange}
          onDraggingChange={onDraggingChange}
        />
      ) : null}
      {transitions.length > 0 ? (
        <div className="bot-bubble-layer">
          {transitions.map((transition) => (
            <BotBubbleTransitionView
              key={transition.key}
              transition={transition}
              head={
                transition.kind === "shrink"
                  ? headPosition(bubbles, transition.botId, area)
                  : transition.head
              }
              onShown={() => {
                if (transition.cover !== undefined)
                  void botBubblesApi.transitionShown(transition.cover).catch(() => undefined);
              }}
              onDone={() => finish(transition.key)}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}
