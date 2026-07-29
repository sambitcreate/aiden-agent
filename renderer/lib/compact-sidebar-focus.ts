export interface CompactSidebarFocusState {
  compact: boolean;
  expanded: boolean;
  contentModalOpen: boolean;
}

export type CompactSidebarAutoFocusIntent = "first-control" | "preserve-current";

function isInteractiveCompactSidebar(state: CompactSidebarFocusState): boolean {
  return state.compact && state.expanded && !state.contentModalOpen;
}

/**
 * A compact sidebar can become interactive either because the user opened it
 * or because an app-level modal stopped covering a sidebar that was already
 * open. Only the first transition owns initial focus. On modal return, the
 * modal's exact restoration target must remain authoritative.
 */
export function compactSidebarAutoFocusIntent(
  previous: CompactSidebarFocusState,
  next: CompactSidebarFocusState,
): CompactSidebarAutoFocusIntent | null {
  if (!isInteractiveCompactSidebar(next) || isInteractiveCompactSidebar(previous)) {
    return null;
  }

  const resumesCoveredSidebar =
    previous.compact && previous.expanded && previous.contentModalOpen;
  return resumesCoveredSidebar ? "preserve-current" : "first-control";
}
