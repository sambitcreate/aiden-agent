export type EnvironmentPanelTab = "review" | "subagents" | "files";
export type EnvironmentSurface = "quick-view" | "tools";
export type EnvironmentSurfaceMode = "closed" | "tools-pinned" | "tools-floating";

export interface EnvironmentSurfaceState {
  quickViewOpen: boolean;
  toolsOpen: boolean;
  toolsTab: EnvironmentPanelTab;
  frontSurface: EnvironmentSurface | null;
}

export type EnvironmentSurfaceAction =
  | { type: "toggle-quick-view" }
  | { type: "show-quick-view" }
  | { type: "close-quick-view" }
  | { type: "toggle-tools"; tab: EnvironmentPanelTab }
  | { type: "show-tools"; tab?: EnvironmentPanelTab }
  | { type: "close-tools" }
  | { type: "activate"; surface: EnvironmentSurface }
  | { type: "close-all" };

export const ENVIRONMENT_PANEL_TABS = ["review", "subagents", "files"] as const;
const DISABLED_ENVIRONMENT_PANEL_TABS = ["review", "files"] as const;

interface EnvironmentPanelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface EnvironmentClosestTarget {
  closest(selector: string): unknown;
}

export function shouldRestoreEnvironmentFocus(
  activeElement: EnvironmentClosestTarget | null,
  surface: EnvironmentSurface,
): boolean {
  return Boolean(activeElement?.closest(`[data-environment-surface="${surface}"]`));
}

export function availableEnvironmentPanelTabs(
  subagentsEnabled: boolean,
): readonly EnvironmentPanelTab[] {
  return subagentsEnabled ? ENVIRONMENT_PANEL_TABS : DISABLED_ENVIRONMENT_PANEL_TABS;
}

export function normalizeEnvironmentPanelTab(
  tab: EnvironmentPanelTab,
  subagentsEnabled: boolean,
): EnvironmentPanelTab {
  return tab === "subagents" && !subagentsEnabled ? "review" : tab;
}

export function storedEnvironmentPanelTab(
  storage: EnvironmentPanelStorage,
  key: string,
  subagentsEnabled: boolean,
): EnvironmentPanelTab {
  const stored = storage.getItem(key);
  const parsed: EnvironmentPanelTab =
    stored === "review" || stored === "subagents" || stored === "files" ? stored : "review";
  // Capability bootstrap starts fail-closed and can become authoritative later.
  // Preserve the raw destination instead of destructively repairing storage.
  return normalizeEnvironmentPanelTab(parsed, subagentsEnabled);
}

export function reduceEnvironmentSurfaceState(
  state: EnvironmentSurfaceState,
  action: EnvironmentSurfaceAction,
): EnvironmentSurfaceState {
  switch (action.type) {
    case "toggle-quick-view":
      return state.quickViewOpen
        ? {
            ...state,
            quickViewOpen: false,
            frontSurface: state.toolsOpen ? "tools" : null,
          }
        : { ...state, quickViewOpen: true, frontSurface: "quick-view" };
    case "show-quick-view":
      return { ...state, quickViewOpen: true, frontSurface: "quick-view" };
    case "close-quick-view":
      return {
        ...state,
        quickViewOpen: false,
        frontSurface: state.toolsOpen ? "tools" : null,
      };
    case "toggle-tools":
      return state.toolsOpen
        ? {
            ...state,
            toolsOpen: false,
            frontSurface: state.quickViewOpen ? "quick-view" : null,
          }
        : { ...state, toolsOpen: true, toolsTab: action.tab, frontSurface: "tools" };
    case "show-tools":
      return {
        ...state,
        toolsOpen: true,
        toolsTab: action.tab ?? state.toolsTab,
        frontSurface: "tools",
      };
    case "close-tools":
      return {
        ...state,
        toolsOpen: false,
        frontSurface: state.quickViewOpen ? "quick-view" : null,
      };
    case "activate":
      if (action.surface === "tools" && !state.toolsOpen) return state;
      if (action.surface === "quick-view" && !state.quickViewOpen) return state;
      return state.frontSurface === action.surface
        ? state
        : { ...state, frontSurface: action.surface };
    case "close-all":
      return { ...state, quickViewOpen: false, toolsOpen: false, frontSurface: null };
  }
}
