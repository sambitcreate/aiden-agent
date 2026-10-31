// One per-window view of the stored sidebar preferences, kept in step across
// windows by the `storage` event. Writes merge per field over what is stored
// now, so a window changing one setting never resets another window's change
// to a different one. Storage can be missing or throw (a private profile,
// cleared site data): the sidebar then works for this session only.

import * as React from "react";
import {
  parseSidebarPreferences,
  serializeSidebarPreferences,
  type SidebarPreferences,
  type SidebarView,
} from "./sidebar-organization";

export const SIDEBAR_PREFERENCES_KEY = "aiden-agent.sidebar.v1";

const listeners = new Set<() => void>();
let cache: { raw: string | null; value: SidebarPreferences } | null = null;
/** Storage may hold something the cache hasn't read (see use-bot-sidebar-preferences). */
let stale = true;

function readRaw(): string | null {
  try {
    return localStorage.getItem(SIDEBAR_PREFERENCES_KEY);
  } catch {
    return null;
  }
}

function snapshot(): SidebarPreferences {
  if (cache && !stale && listeners.size > 0) return cache.value;
  const raw = readRaw();
  if (!cache || cache.raw !== raw) cache = { raw, value: parseSidebarPreferences(raw) };
  stale = false;
  return cache.value;
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) stale = true;
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== SIDEBAR_PREFERENCES_KEY) return;
    stale = true;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The stored preferences as this window last read them. */
export function readSidebarPreferences(): SidebarPreferences {
  return snapshot();
}

/**
 * Writes only the fields in `patch` over the stored record. With
 * `validLocalProjectIds`, local entries for removed workspaces are pruned too,
 * so an empty patch is a prune.
 */
export function writeSidebarPreferences(
  patch: Partial<SidebarPreferences>,
  validLocalProjectIds?: readonly string[],
): void {
  // Merge over storage as it is now, not the cache: another window's write may
  // not have raised its `storage` event here yet.
  stale = true;
  const current = snapshot();
  const next = parseSidebarPreferences(
    serializeSidebarPreferences({ ...current, ...patch }),
    validLocalProjectIds,
  );
  const serialized = serializeSidebarPreferences(next);
  if (serialized === serializeSidebarPreferences(current)) return;
  try {
    localStorage.setItem(SIDEBAR_PREFERENCES_KEY, serialized);
  } catch {
    // Per-device convenience only.
  }
  cache = { raw: readRaw(), value: next };
  for (const listener of listeners) listener();
}

/** The sidebar view, shared by every place that switches it. */
export function useSidebarView(): { view: SidebarView; setView: (view: SidebarView) => void } {
  const view = React.useSyncExternalStore(subscribe, () => snapshot().view, () => snapshot().view);
  const setView = React.useCallback((next: SidebarView) => writeSidebarPreferences({ view: next }), []);
  return { view, setView };
}

/** Whether the Inbox's Working shelf is collapsed. */
export function useWorkingShelfCollapsed(): {
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
} {
  const read = () => snapshot().workingShelfCollapsed;
  const collapsed = React.useSyncExternalStore(subscribe, read, read);
  const setCollapsed = React.useCallback(
    (next: boolean) => writeSidebarPreferences({ workingShelfCollapsed: next }),
    [],
  );
  return { collapsed, setCollapsed };
}
