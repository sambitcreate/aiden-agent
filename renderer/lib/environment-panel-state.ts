export type EnvironmentPanelTab = "review" | "subagents" | "files" | "browser" | "devices" | "new-tab" | "context" | "terminal";
export type EnvironmentSurface = "quick-view" | "tools";
export type EnvironmentSurfaceMode = "closed" | "tools-pinned" | "tools-floating";

export interface EnvironmentSurfaceState {
  quickViewOpen: boolean;
  toolsOpen: boolean;
  toolsTab: EnvironmentPanelTab;
  openTabs?: EnvironmentPanelTab[];
  frontSurface: EnvironmentSurface | null;
}

export type EnvironmentSurfaceAction =
  | { type: "toggle-quick-view" }
  | { type: "show-quick-view" }
  | { type: "close-quick-view" }
  | { type: "toggle-tools"; tab: EnvironmentPanelTab }
  | { type: "show-tools"; tab?: EnvironmentPanelTab }
  | { type: "close-tab"; tab: EnvironmentPanelTab }
  | { type: "close-tools" }
  | { type: "activate"; surface: EnvironmentSurface }
  | { type: "close-all" };

export const ENVIRONMENT_PANEL_TABS = [
  "review",
  "subagents",
  "files",
  "browser",
  "devices",
  "new-tab",
  "context",
  "terminal",
] as const satisfies readonly EnvironmentPanelTab[];

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

export function parseEnvironmentPanelTab(value: string | null): EnvironmentPanelTab | null {
  return (ENVIRONMENT_PANEL_TABS as readonly string[]).includes(value ?? "")
    ? (value as EnvironmentPanelTab)
    : null;
}

function environmentPanelTabEnabled(
  tab: EnvironmentPanelTab,
  subagentsEnabled: boolean,
  devicesEnabled: boolean,
): boolean {
  if (tab === "subagents") return subagentsEnabled;
  if (tab === "devices") return devicesEnabled;
  return true;
}

export function availableEnvironmentPanelTabs(
  subagentsEnabled: boolean,
  devicesEnabled = false,
): readonly EnvironmentPanelTab[] {
  return ENVIRONMENT_PANEL_TABS.filter((tab) =>
    environmentPanelTabEnabled(tab, subagentsEnabled, devicesEnabled),
  );
}

export function normalizeEnvironmentPanelTab(
  tab: EnvironmentPanelTab,
  subagentsEnabled: boolean,
  devicesEnabled = false,
): EnvironmentPanelTab {
  return environmentPanelTabEnabled(tab, subagentsEnabled, devicesEnabled) ? tab : "review";
}

export function storedEnvironmentPanelTab(
  storage: EnvironmentPanelStorage,
  key: string,
  subagentsEnabled: boolean,
  devicesEnabled = false,
): EnvironmentPanelTab {
  const parsed = parseEnvironmentPanelTab(storage.getItem(key)) ?? "review";
  // Capability bootstrap starts fail-closed and can become authoritative later.
  // Preserve the raw destination instead of destructively repairing storage.
  return normalizeEnvironmentPanelTab(parsed, subagentsEnabled, devicesEnabled);
}

/** Navigation descriptors only. Tool services retain their own durable state. */
export function openEnvironmentTab(tabs: EnvironmentPanelTab[], tab: EnvironmentPanelTab): EnvironmentPanelTab[] {
  if (tabs.includes(tab)) return tabs;
  const launcher = tabs.indexOf("new-tab");
  if (tab !== "new-tab" && launcher >= 0) return tabs.map((entry, index) => index === launcher ? tab : entry);
  return [...tabs, tab];
}

export function parseEnvironmentOpenTabs(value: string | null, legacy: EnvironmentPanelTab): EnvironmentPanelTab[] {
  try {
    const data: unknown = JSON.parse(value ?? "null");
    if (data && typeof data === "object" && "version" in data && data.version === 1 && "tabs" in data && Array.isArray(data.tabs)) {
      const tabs = [...new Set(data.tabs.slice(0, 8).filter((tab): tab is EnvironmentPanelTab => typeof tab === "string" && parseEnvironmentPanelTab(tab) !== null))];
      if (tabs.length) return tabs;
    }
  } catch { /* Legacy state has no tab list. */ }
  return [legacy];
}

export function reduceEnvironmentSurfaceState(
  state: EnvironmentSurfaceState,
  action: EnvironmentSurfaceAction,
): EnvironmentSurfaceState {
  const tabs = state.openTabs ?? [state.toolsTab];
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
        : { ...state, toolsOpen: true, toolsTab: action.tab, openTabs: openEnvironmentTab(tabs, action.tab), frontSurface: "tools" };
    case "show-tools":
      return {
        ...state,
        toolsOpen: true,
        toolsTab: action.tab ?? "new-tab",
        openTabs: openEnvironmentTab(tabs, action.tab ?? "new-tab"),
        frontSurface: "tools",
      };
    case "close-tab": {
      const remaining = tabs.filter((tab) => tab !== action.tab);
      const openTabs: EnvironmentPanelTab[] = remaining.length ? remaining : ["new-tab"];
      return { ...state, openTabs, toolsTab: state.toolsTab === action.tab ? openTabs[Math.max(0, tabs.indexOf(action.tab) - 1)] ?? openTabs[0] : state.toolsTab };
    }
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
