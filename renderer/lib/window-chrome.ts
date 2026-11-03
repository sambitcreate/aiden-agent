// Renderer side of the window chrome: which controls this window has, where
// the leading top-bar cluster sits, and how much room Aiden's own Linux window
// controls take at the top-right corner.

import * as React from "react";
import { isWindowChrome, type WindowChrome, type WindowControlsState } from "../shared/window-chrome";

/** Fixed for the window's lifetime; read once from the preload. Unknown hosts lay out like macOS. */
export function currentWindowChrome(): WindowChrome {
  const chrome = typeof window === "undefined"
    ? undefined
    : (window as { aidenAPI?: { window?: { chrome?: unknown } } }).aidenAPI?.window?.chrome;
  return isWindowChrome(chrome) ? chrome : "mac";
}

export function useWindowChrome(): WindowChrome {
  return React.useMemo(currentWindowChrome, []);
}

/** Left edge of the sidebar-toggle cluster: past the macOS traffic lights, or the window edge elsewhere. */
export function leadingClusterOffset(chrome: WindowChrome): number {
  return chrome === "mac" ? 90 : 12;
}

/** Room for the leading cluster's buttons, ignoring the Linux menu button. */
const LEADING_CLUSTER_WIDTH = 88;
/** The Linux main-menu button and its gap. */
const MENU_BUTTON_WIDTH = 30;

/**
 * Left padding that keeps a full-width header clear of the window controls and
 * the leading sidebar-toggle/history cluster while the sidebar is collapsed.
 */
export function collapsedHeaderInset(chrome: WindowChrome): number {
  return leadingClusterOffset(chrome) + (chrome === "aiden" ? MENU_BUTTON_WIDTH : 0) + LEADING_CLUSTER_WIDTH + 12;
}

interface ControlsSnapshot extends WindowControlsState {
  /** Rendered width of Aiden's window-control cluster, 0 until it mounts. */
  width: number;
}

let snapshot: ControlsSnapshot = { maximized: false, fullScreen: false, width: 0 };
const listeners = new Set<() => void>();

function publish(next: Partial<ControlsSnapshot>): void {
  const merged = { ...snapshot, ...next };
  if (merged.maximized === snapshot.maximized && merged.fullScreen === snapshot.fullScreen && merged.width === snapshot.width) return;
  snapshot = merged;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setWindowControlsState(state: WindowControlsState): void {
  publish({ maximized: state.maximized, fullScreen: state.fullScreen });
}

export function setWindowControlsWidth(width: number): void {
  publish({ width: Math.max(0, Math.ceil(width)) });
}

export function useWindowControlsSnapshot(): ControlsSnapshot {
  return React.useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/** Width Aiden's drawn window controls take at the top-right corner, or 0 when there are none. */
export function useWindowControlsInset(): number {
  const chrome = useWindowChrome();
  const { fullScreen, width } = useWindowControlsSnapshot();
  return chrome === "aiden" && !fullScreen ? width : 0;
}

/**
 * Extra right padding for a top bar: the controls' width while the bar's
 * right end meets the window's top-right corner, otherwise 0. A bar beside a
 * docked panel needs none; the panel's own header takes it.
 */
export function useTrailingWindowControlsClearance(ref: React.RefObject<HTMLElement | null>): number {
  const inset = useWindowControlsInset();
  const [touches, setTouches] = React.useState(false);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element || inset === 0) {
      setTouches(false);
      return;
    }
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setTouches(rect.top < 1 && rect.right >= document.documentElement.clientWidth - 1);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    observer?.observe(document.documentElement);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [inset, ref]);
  return touches ? inset : 0;
}
