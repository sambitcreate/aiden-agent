export interface DesignScreenNavigatorRevision {
  mediaId: string;
  artifactId: string;
  label: string;
}

export interface DesignScreenNavigatorItem {
  nodeId: string;
  lineageId: string;
  title: string;
  activeRevision: DesignScreenNavigatorRevision;
  previewRevision?: DesignScreenNavigatorRevision;
}

/** Exact, renderer-only identity for centering a Screen from the project root. */
export interface DesignScreenNavigatorTarget {
  nodeId: string;
  lineageId: string;
  mediaId: string;
  artifactId: string;
  mode: "current" | "historical";
}

function revisionsMatch(
  left: DesignScreenNavigatorRevision,
  right: DesignScreenNavigatorRevision,
): boolean {
  return left.mediaId === right.mediaId && left.artifactId === right.artifactId;
}

export function designScreenNavigatorTarget(
  screen: DesignScreenNavigatorItem,
): DesignScreenNavigatorTarget {
  const previewRevision =
    screen.previewRevision && !revisionsMatch(screen.previewRevision, screen.activeRevision)
      ? screen.previewRevision
      : undefined;
  const displayedRevision = previewRevision ?? screen.activeRevision;
  return {
    nodeId: screen.nodeId,
    lineageId: screen.lineageId,
    mediaId: displayedRevision.mediaId,
    artifactId: displayedRevision.artifactId,
    mode: previewRevision ? "historical" : "current",
  };
}

export function invokeDesignScreenNavigatorSelection(
  screen: DesignScreenNavigatorItem,
  onSelectScreen: (target: DesignScreenNavigatorTarget) => void,
): void {
  onSelectScreen(designScreenNavigatorTarget(screen));
}

export function filterDesignScreenNavigatorItems(
  screens: readonly DesignScreenNavigatorItem[],
  query: string,
): DesignScreenNavigatorItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...screens];
  return screens.filter((screen) =>
    [screen.title, screen.activeRevision.label, screen.previewRevision?.label]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
  );
}
