export type EnvironmentPanelTab = "overview" | "review" | "subagents" | "files";

export const ENVIRONMENT_PANEL_TABS = ["review", "subagents", "files"] as const;
const DISABLED_ENVIRONMENT_PANEL_TABS = ["review", "files"] as const;

interface EnvironmentPanelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface EnvironmentFocusTarget {
  isConnected: boolean;
  focus(): void;
}

export interface EnvironmentFocusBoundary extends EnvironmentFocusTarget {
  contains(target: Node | null): boolean;
}

export interface EnvironmentSurfaceMode {
  fullOpen: boolean;
  compactModal: boolean;
}

export const ENVIRONMENT_COMPACT_MODAL_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "textarea:not(:disabled)",
  "select:not(:disabled)",
  "summary:not([tabindex='-1'])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Native disclosure summaries are keyboard-focusable without an explicit
 * tabIndex. Keep them in the compact modal's boundary so pointer focus on a
 * Subagents detail disclosure cannot be mistaken for focus outside the modal.
 */
export function environmentCompactModalFocusableTargets(
  surface: ParentNode | null,
): HTMLElement[] {
  return Array.from(
    surface?.querySelectorAll<HTMLElement>(
      ENVIRONMENT_COMPACT_MODAL_FOCUSABLE_SELECTOR,
    ) ?? [],
  ).filter((element) => element.offsetParent !== null && !element.closest("[inert]"));
}

/**
 * Return only an explicit wrap target. A focusable control in the middle of
 * the modal, including a native summary selected with the pointer, keeps the
 * browser's normal Tab order.
 */
export function environmentCompactModalTabWrapTarget(
  focusable: readonly HTMLElement[],
  activeElement: Element | null,
  shiftKey: boolean,
): HTMLElement | null {
  if (focusable.length === 0) return null;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (shiftKey && (activeElement === first || !focusable.includes(activeElement as HTMLElement))) {
    return last;
  }
  if (!shiftKey && (activeElement === last || !focusable.includes(activeElement as HTMLElement))) {
    return first;
  }
  return null;
}

/**
 * When a mounted inline surface becomes modal, focus must cross the new modal
 * boundary before paint. Initial opens retain their existing focus path, and a
 * focus already inside the surface is never moved.
 */
export function focusEnvironmentCompactModalTransition(
  previous: EnvironmentSurfaceMode,
  next: EnvironmentSurfaceMode,
  surface: EnvironmentFocusBoundary | null,
  activeElement: Node | null,
  preferredTarget: EnvironmentFocusTarget | null,
): boolean {
  if (
    !previous.fullOpen ||
    previous.compactModal ||
    !next.fullOpen ||
    !next.compactModal ||
    !surface ||
    surface.contains(activeElement)
  ) {
    return false;
  }
  const target = preferredTarget?.isConnected ? preferredTarget : surface;
  if (!target.isConnected) return false;
  target.focus();
  return true;
}

export function availableEnvironmentPanelTabs(
  subagentsEnabled: boolean,
): readonly Exclude<EnvironmentPanelTab, "overview">[] {
  return subagentsEnabled ? ENVIRONMENT_PANEL_TABS : DISABLED_ENVIRONMENT_PANEL_TABS;
}

export function normalizeEnvironmentPanelTab(
  tab: EnvironmentPanelTab,
  subagentsEnabled: boolean,
): EnvironmentPanelTab {
  return tab === "subagents" && !subagentsEnabled ? "overview" : tab;
}

export function storedEnvironmentPanelTab(
  storage: EnvironmentPanelStorage,
  key: string,
  subagentsEnabled: boolean,
): EnvironmentPanelTab {
  const stored = storage.getItem(key);
  const parsed: EnvironmentPanelTab =
    stored === "review" || stored === "subagents" || stored === "files" || stored === "overview"
      ? stored
      : "overview";
  const resolved = normalizeEnvironmentPanelTab(parsed, subagentsEnabled);
  if (resolved !== parsed) storage.setItem(key, resolved);
  return resolved;
}
