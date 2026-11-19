// The composer's last button when the draft is empty starts Aiden Live.
// Typing, attaching, dictating or a running turn turn it back into Send (or
// Stop). These are its hooks and press rule; the button itself renders in
// composer.tsx. See renderer/lib/live-launcher.ts.

import * as React from "react";
import { liveLauncher, type LiveLaunchState } from "../lib/live-launcher";

/** How long an empty draft waits before Send turns into Live. */
export const LIVE_SWAP_DELAY_MS = 400;
/** Presses this soon after the swap are ignored: they were meant for Send or Stop. */
export const LIVE_PRESS_GUARD_MS = 350;

export function useLiveLaunchState(): LiveLaunchState {
  return React.useSyncExternalStore(
    (listener) => liveLauncher.subscribe(listener),
    () => liveLauncher.get(),
    () => liveLauncher.get(),
  );
}

/**
 * Turns into Live only after the wanted action has stayed "live" for
 * LIVE_SWAP_DELAY_MS, so clearing a draft or a turn ending never puts Live
 * under a pointer that was aiming at Send or Stop. Send comes back at once.
 */
export function useSettledPrimaryAction(wanted: "live" | "send"): {
  action: "live" | "send";
  shownAt: number;
} {
  const [settled, setSettled] = React.useState<{ action: "live" | "send"; shownAt: number }>(() => ({
    action: wanted,
    shownAt: 0,
  }));
  React.useEffect(() => {
    if (wanted === "send") {
      setSettled((current) => (current.action === "send" ? current : { action: "send", shownAt: Date.now() }));
      return;
    }
    const timer = window.setTimeout(
      () => setSettled((current) => (current.action === "live" ? current : { action: "live", shownAt: Date.now() })),
      LIVE_SWAP_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [wanted]);
  // Send must win in the same render, even before the effect runs.
  return wanted === "send" && settled.action === "live" ? { action: "send", shownAt: settled.shownAt } : settled;
}

/** The Live button's name: first use opens setup rather than starting. */
export function composerLiveLabel(needsSetup: boolean): string {
  return needsSetup ? "Set up Aiden Live" : "Start Aiden Live";
}

/**
 * A press of the composer's Live button. Presses that land right as Send
 * turned into Live were meant for Send or Stop, so they do nothing.
 */
export function pressComposerLive(shownAt: number, now = Date.now()): boolean {
  if (now - shownAt < LIVE_PRESS_GUARD_MS) return false;
  return liveLauncher.launch();
}
