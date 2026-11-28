import type { WorkspaceSettingsTab } from "./workspace-settings-view";

export interface OpenWorkspaceSettingsRequest {
  workspaceId: string;
  tab: WorkspaceSettingsTab;
  returnFocus?: HTMLElement | null;
}

const openListeners = new Set<(request: OpenWorkspaceSettingsRequest) => void>();

/** Opens Workspace settings for one workspace, on the given tab. */
export function openWorkspaceSettings(
  workspaceId: string,
  tab: WorkspaceSettingsTab = "general",
): void {
  const returnFocus =
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  for (const listener of openListeners) {
    listener({ workspaceId, tab, returnFocus });
  }
}

export function subscribeWorkspaceSettingsOpen(
  listener: (request: OpenWorkspaceSettingsRequest) => void,
): () => void {
  openListeners.add(listener);
  return () => {
    openListeners.delete(listener);
  };
}
