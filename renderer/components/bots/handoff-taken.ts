// Whether the person pressed Take control on a hand-off card (§3.4), shared
// by every copy of that card's buttons on this device: the chat's Needs-you
// slot and the Bot panel that floats over it. It lives only in memory, so a
// reload shows Take control again; the answer itself still goes to main.

import * as React from "react";

/** Cards whose control was taken, oldest first; a few hundred at most. */
const taken: string[] = [];
const TAKEN_KEPT = 200;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `scope` names the Bot (and host, for a Bot on another Mac); `waitId` the card. */
export function handoffTakenKey(scope: string, waitId: string): string {
  return `${scope}\u0000${waitId}`;
}

export function markHandoffTaken(key: string): void {
  if (taken.includes(key)) return;
  taken.push(key);
  if (taken.length > TAKEN_KEPT) taken.splice(0, taken.length - TAKEN_KEPT);
  for (const listener of listeners) listener();
}

/** Forgets every card's Take control (a fresh window, or a test starting over). */
export function clearHandoffTaken(): void {
  taken.length = 0;
  for (const listener of listeners) listener();
}

/** Whether control of this card was taken here, and the function that records it. */
export function useHandoffTaken(key: string | undefined): [boolean, () => void] {
  const isTaken = React.useSyncExternalStore(subscribe, () => key !== undefined && taken.includes(key));
  const take = React.useCallback(() => {
    if (key !== undefined) markHandoffTaken(key);
  }, [key]);
  return [isTaken, take];
}
