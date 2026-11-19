import * as React from "react";
import { APPEARANCE_CHANGE_EVENT, prefersReducedMotion } from "./appearance-runtime";

function subscribe(notify: () => void): () => void {
  window.addEventListener(APPEARANCE_CHANGE_EVENT, notify);
  return () => window.removeEventListener(APPEARANCE_CHANGE_EVENT, notify);
}

/**
 * Aiden's applied Reduce Motion, live. The appearance runtime already folds the
 * system preference into the root attribute and announces every change, so
 * components read that one value rather than querying the system themselves.
 */
export function useReduceMotion(): boolean {
  return React.useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
