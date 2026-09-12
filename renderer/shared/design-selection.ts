import {
  MAX_DESIGN_TURN_TARGETS,
  type DesignElementSelectionV1,
  type DesignTurnTargetV1,
} from "./design-workspace";

/**
 * Renderer-only selection state for the Design workbench. It intentionally
 * contains no paths, capabilities, workspace bindings, or persistence fields.
 */
export type DesignSelectionSource =
  | "canvas"
  | "conversation"
  | "screen-navigator"
  | "project-search"
  | "history"
  | "inspector"
  | "composer"
  | "project-open";

export interface DesignSelectedRevision {
  mediaId: string;
  artifactId: string;
}

/** Element context is valid only for this exact immutable Screen revision. */
export interface DesignRevisionElementSelection {
  revision: DesignSelectedRevision;
  selection: DesignElementSelectionV1;
}

export interface DesignScreenSelection {
  kind: "screen";
  nodeId: string;
  lineageId: string;
  activeRevision: DesignSelectedRevision;
  /**
   * An ephemeral historical inspection target. Its presence never makes the
   * revision current and must not be written to activeMediaId.
   */
  previewRevision?: DesignSelectedRevision;
  element?: DesignRevisionElementSelection;
}

export interface DesignReferenceSelection {
  kind: "reference";
  nodeId: string;
  assetId: string;
}

/** Display selection only; source authority stays in the existing main binding. */
export interface DesignConnectedPreviewSelection {
  kind: "connected-preview";
  nodeId: string;
  previewId: string;
}

export type DesignWorkbenchSelection =
  | DesignScreenSelection
  | DesignReferenceSelection
  | DesignConnectedPreviewSelection;

export interface DesignWorkbenchSelectionState {
  /** Oldest to newest interaction order, bounded to five unique selections. */
  selections: readonly DesignWorkbenchSelection[];
  /** Most recently selected object of any kind. */
  primaryKey: string | null;
  /** Most recently selected Screen that remains selected. */
  primaryScreenKey: string | null;
  lastSource: DesignSelectionSource | null;
}

export type DesignWorkbenchSelectionAction =
  | {
      type: "select";
      selection: DesignWorkbenchSelection;
      additive: boolean;
      source: DesignSelectionSource;
    }
  | {
      type: "replace";
      selections: readonly DesignWorkbenchSelection[];
      source: DesignSelectionSource;
      primaryKey?: string;
    }
  | {
      type: "remove";
      key: string;
      source: DesignSelectionSource;
    }
  | {
      type: "preview-screen-revision";
      lineageId: string;
      revision: DesignSelectedRevision;
      source: DesignSelectionSource;
    }
  | {
      type: "clear-screen-preview";
      lineageId: string;
      source: DesignSelectionSource;
    }
  | {
      type: "sync-screen-active-revision";
      lineageId: string;
      revision: DesignSelectedRevision;
    }
  | {
      type: "select-screen-element";
      lineageId: string;
      revision: DesignSelectedRevision;
      selection: DesignElementSelectionV1;
      source: DesignSelectionSource;
    }
  | {
      type: "clear-screen-element";
      lineageId: string;
      source: DesignSelectionSource;
    }
  | { type: "clear-all"; source: DesignSelectionSource };

export type DesignSelectionEscapeLayer =
  | "element"
  | "historical-preview"
  | "multiple"
  | "selection"
  | "none";

export const MAX_DESIGN_WORKBENCH_SELECTIONS = MAX_DESIGN_TURN_TARGETS;

export const EMPTY_DESIGN_WORKBENCH_SELECTION: DesignWorkbenchSelectionState = {
  selections: [],
  primaryKey: null,
  primaryScreenKey: null,
  lastSource: null,
};

export function sameDesignWorkbenchSelectionState(
  left: DesignWorkbenchSelectionState,
  right: DesignWorkbenchSelectionState,
): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

/**
 * React Flow reports controlled selections whenever its node collection is
 * reconciled. Treat those reports as meaningful only when the selected node
 * identities actually changed; otherwise revision and element context owned
 * by the workbench would be needlessly rewritten as a generic canvas pick.
 */
export function sameDesignSelectedNodeIds(
  state: DesignWorkbenchSelectionState,
  nodeIds: readonly string[],
): boolean {
  const current = [...new Set(state.selections.map(({ nodeId }) => nodeId))].sort();
  const next = [...new Set(nodeIds)].sort();
  return current.length === next.length && current.every((nodeId, index) => nodeId === next[index]);
}

export interface DesignFlowSelectionSync {
  previousSignature: string;
  expectedSignature: string;
}

export function designSelectedNodeIdSignature(nodeIds: readonly string[]): string {
  return JSON.stringify([...new Set(nodeIds)].sort());
}

export function beginDesignFlowSelectionSync(
  previousNodeIds: readonly string[],
  expectedNodeIds: readonly string[],
): DesignFlowSelectionSync {
  return {
    previousSignature: designSelectedNodeIdSignature(previousNodeIds),
    expectedSignature: designSelectedNodeIdSignature(expectedNodeIds),
  };
}

export function consumeDesignFlowSelectionReport(
  pending: DesignFlowSelectionSync | null,
  reportedNodeIds: readonly string[],
): { ignore: boolean; pending: DesignFlowSelectionSync | null } {
  if (!pending) return { ignore: false, pending: null };
  if (pending.expectedSignature === designSelectedNodeIdSignature(reportedNodeIds)) {
    return { ignore: true, pending: null };
  }
  if (pending.previousSignature === designSelectedNodeIdSignature(reportedNodeIds)) {
    return { ignore: true, pending: null };
  }
  return { ignore: false, pending: null };
}

/** Preserve cross-kind interaction order when projecting selection into composer chips. */
export function orderDesignContextItems<T extends { id: string }>(
  items: readonly T[],
  order: readonly string[],
): T[] {
  const rank = new Map(order.map((key, index) => [key, index]));
  return [...items].sort((left, right) => {
    const leftKey = left.id.startsWith("source:") ? "source" : left.id;
    const rightKey = right.id.startsWith("source:") ? "source" : right.id;
    return (
      (rank.get(leftKey) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(rightKey) ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

export function designSelectionContextOrder(state: DesignWorkbenchSelectionState): string[] {
  return state.selections.map((selection) =>
    selection.kind === "screen"
      ? `target:${designDisplayedScreenRevision(selection).mediaId}`
      : selection.kind === "reference"
        ? `image:${selection.nodeId}`
        : "source",
  );
}

export function designWorkbenchSelectionKey(selection: DesignWorkbenchSelection): string {
  if (selection.kind === "screen") return `screen:${selection.lineageId}`;
  if (selection.kind === "reference") return `reference:${selection.assetId}`;
  return `connected-preview:${selection.previewId}`;
}

function sameRevision(left: DesignSelectedRevision, right: DesignSelectedRevision): boolean {
  return left.mediaId === right.mediaId && left.artifactId === right.artifactId;
}

function cloneRevision(revision: DesignSelectedRevision): DesignSelectedRevision {
  return { ...revision };
}

function cloneScreenSelection(selection: DesignScreenSelection): DesignScreenSelection {
  const previewRevision =
    selection.previewRevision && !sameRevision(selection.previewRevision, selection.activeRevision)
      ? cloneRevision(selection.previewRevision)
      : undefined;
  const displayedRevision = previewRevision ?? selection.activeRevision;
  const element =
    selection.element && sameRevision(selection.element.revision, displayedRevision)
      ? {
          revision: cloneRevision(selection.element.revision),
          selection: { ...selection.element.selection },
        }
      : undefined;
  return {
    kind: "screen",
    nodeId: selection.nodeId,
    lineageId: selection.lineageId,
    activeRevision: cloneRevision(selection.activeRevision),
    ...(previewRevision ? { previewRevision } : {}),
    ...(element ? { element } : {}),
  };
}

function cloneSelection(selection: DesignWorkbenchSelection): DesignWorkbenchSelection {
  return selection.kind === "screen" ? cloneScreenSelection(selection) : { ...selection };
}

/** De-duplicate by stable identity, keep latest interaction order, and cap at five. */
function normalizeSelections(
  selections: readonly DesignWorkbenchSelection[],
): DesignWorkbenchSelection[] {
  const ordered: DesignWorkbenchSelection[] = [];
  for (const candidate of selections) {
    const selection = cloneSelection(candidate);
    if (selection.kind === "connected-preview") {
      ordered.length = 0;
    } else {
      const connectedIndex = ordered.findIndex((existing) => existing.kind === "connected-preview");
      if (connectedIndex >= 0) ordered.splice(connectedIndex, 1);
    }
    const key = designWorkbenchSelectionKey(selection);
    const previousIndex = ordered.findIndex(
      (existing) => designWorkbenchSelectionKey(existing) === key,
    );
    if (previousIndex >= 0) ordered.splice(previousIndex, 1);
    ordered.push(selection);
  }
  return ordered.slice(-MAX_DESIGN_WORKBENCH_SELECTIONS);
}

function normalizeState(input: {
  selections: readonly DesignWorkbenchSelection[];
  primaryKey?: string | null;
  primaryScreenKey?: string | null;
  lastSource: DesignSelectionSource | null;
}): DesignWorkbenchSelectionState {
  const selections = normalizeSelections(input.selections);
  const keys = new Set(selections.map(designWorkbenchSelectionKey));
  const primaryKey =
    (input.primaryKey && keys.has(input.primaryKey) ? input.primaryKey : undefined) ??
    (selections.length > 0
      ? designWorkbenchSelectionKey(selections[selections.length - 1]!)
      : null);
  const screenKeys = new Set(
    selections.flatMap((selection) =>
      selection.kind === "screen" ? [designWorkbenchSelectionKey(selection)] : [],
    ),
  );
  const fallbackPrimaryScreen = [...selections]
    .reverse()
    .find((selection): selection is DesignScreenSelection => selection.kind === "screen");
  const normalizedPrimaryScreenKey =
    (input.primaryScreenKey && screenKeys.has(input.primaryScreenKey)
      ? input.primaryScreenKey
      : undefined) ??
    (fallbackPrimaryScreen ? designWorkbenchSelectionKey(fallbackPrimaryScreen) : null);

  return {
    selections: selections.map((selection) => {
      if (selection.kind !== "screen") return selection;
      if (designWorkbenchSelectionKey(selection) === normalizedPrimaryScreenKey) return selection;
      const { element: _element, ...withoutElement } = selection;
      return withoutElement;
    }),
    primaryKey,
    primaryScreenKey: normalizedPrimaryScreenKey,
    lastSource: input.lastSource,
  };
}

export function createDesignWorkbenchSelectionState(
  selections: readonly DesignWorkbenchSelection[] = [],
  source: DesignSelectionSource | null = null,
): DesignWorkbenchSelectionState {
  return normalizeState({ selections, lastSource: source });
}

export function designDisplayedScreenRevision(
  screen: DesignScreenSelection,
): DesignSelectedRevision {
  return screen.previewRevision ?? screen.activeRevision;
}

export function designScreenIsPreviewingHistory(screen: DesignScreenSelection): boolean {
  return Boolean(screen.previewRevision);
}

export function designPrimaryScreenSelection(
  state: DesignWorkbenchSelectionState,
): DesignScreenSelection | undefined {
  if (!state.primaryScreenKey) return undefined;
  const selection = state.selections.find(
    (candidate) => designWorkbenchSelectionKey(candidate) === state.primaryScreenKey,
  );
  return selection?.kind === "screen" ? selection : undefined;
}

export function designPrimaryScreenRevision(
  state: DesignWorkbenchSelectionState,
): (DesignSelectedRevision & { mode: "current" | "historical" }) | undefined {
  const screen = designPrimaryScreenSelection(state);
  if (!screen) return undefined;
  return {
    ...designDisplayedScreenRevision(screen),
    mode: screen.previewRevision ? "historical" : "current",
  };
}

/** Project selected Screens into exact, bounded prompt context in interaction order. */
export function designSelectionTurnTargets(
  state: DesignWorkbenchSelectionState,
): DesignTurnTargetV1[] {
  return state.selections.flatMap((selection) => {
    if (selection.kind !== "screen") return [];
    const revision = designDisplayedScreenRevision(selection);
    return [
      {
        ...revision,
        ...(selection.element && sameRevision(selection.element.revision, revision)
          ? { selection: { ...selection.element.selection } }
          : {}),
      },
    ];
  });
}

function updateScreen(
  state: DesignWorkbenchSelectionState,
  lineageId: string,
  update: (screen: DesignScreenSelection) => DesignScreenSelection,
  source?: DesignSelectionSource,
): DesignWorkbenchSelectionState {
  const key = `screen:${lineageId}`;
  if (!state.selections.some((selection) => designWorkbenchSelectionKey(selection) === key)) {
    return state;
  }
  return normalizeState({
    selections: state.selections.map((selection) =>
      selection.kind === "screen" && selection.lineageId === lineageId
        ? update(selection)
        : selection,
    ),
    primaryKey: source ? key : state.primaryKey,
    primaryScreenKey: source ? key : state.primaryScreenKey,
    lastSource: source ?? state.lastSource,
  });
}

export function reduceDesignWorkbenchSelection(
  state: DesignWorkbenchSelectionState,
  action: DesignWorkbenchSelectionAction,
): DesignWorkbenchSelectionState {
  if (action.type === "select") {
    const key = designWorkbenchSelectionKey(action.selection);
    const selections = action.additive
      ? [
          ...state.selections.filter((selection) => designWorkbenchSelectionKey(selection) !== key),
          action.selection,
        ]
      : [action.selection];
    return normalizeState({
      selections,
      primaryKey: key,
      primaryScreenKey:
        action.selection.kind === "screen" ? key : action.additive ? state.primaryScreenKey : null,
      lastSource: action.source,
    });
  }

  if (action.type === "replace") {
    return normalizeState({
      selections: action.selections,
      primaryKey: action.primaryKey,
      lastSource: action.source,
    });
  }

  if (action.type === "remove") {
    return normalizeState({
      selections: state.selections.filter(
        (selection) => designWorkbenchSelectionKey(selection) !== action.key,
      ),
      primaryKey: state.primaryKey === action.key ? null : state.primaryKey,
      primaryScreenKey: state.primaryScreenKey === action.key ? null : state.primaryScreenKey,
      lastSource: action.source,
    });
  }

  if (action.type === "preview-screen-revision") {
    return updateScreen(
      state,
      action.lineageId,
      (screen) => ({
        ...screen,
        ...(sameRevision(action.revision, screen.activeRevision)
          ? { previewRevision: undefined, element: undefined }
          : { previewRevision: cloneRevision(action.revision), element: undefined }),
      }),
      action.source,
    );
  }

  if (action.type === "clear-screen-preview") {
    return updateScreen(
      state,
      action.lineageId,
      (screen) => ({ ...screen, previewRevision: undefined, element: undefined }),
      action.source,
    );
  }

  if (action.type === "sync-screen-active-revision") {
    return updateScreen(state, action.lineageId, (screen) => {
      const displayedBefore = designDisplayedScreenRevision(screen);
      const previewRevision =
        screen.previewRevision && !sameRevision(screen.previewRevision, action.revision)
          ? screen.previewRevision
          : undefined;
      const displayedAfter = previewRevision ?? action.revision;
      return {
        ...screen,
        activeRevision: cloneRevision(action.revision),
        previewRevision,
        ...(screen.element &&
        sameRevision(screen.element.revision, displayedBefore) &&
        sameRevision(screen.element.revision, displayedAfter)
          ? { element: screen.element }
          : { element: undefined }),
      };
    });
  }

  if (action.type === "select-screen-element") {
    const screen = state.selections.find(
      (selection): selection is DesignScreenSelection =>
        selection.kind === "screen" && selection.lineageId === action.lineageId,
    );
    if (!screen || !sameRevision(designDisplayedScreenRevision(screen), action.revision)) {
      return state;
    }
    return updateScreen(
      state,
      action.lineageId,
      (candidate) => ({
        ...candidate,
        element: {
          revision: cloneRevision(action.revision),
          selection: { ...action.selection },
        },
      }),
      action.source,
    );
  }

  if (action.type === "clear-screen-element") {
    return updateScreen(
      state,
      action.lineageId,
      (screen) => ({ ...screen, element: undefined }),
      action.source,
    );
  }

  return {
    selections: [],
    primaryKey: null,
    primaryScreenKey: null,
    lastSource: action.source,
  };
}

export function designSelectionEscapeLayer(
  state: DesignWorkbenchSelectionState,
): DesignSelectionEscapeLayer {
  const primaryScreen = designPrimaryScreenSelection(state);
  if (primaryScreen?.element) return "element";
  if (primaryScreen?.previewRevision) return "historical-preview";
  if (state.selections.length > 1) return "multiple";
  if (state.selections.length === 1) return "selection";
  return "none";
}

/**
 * Clear one visible interaction layer for Escape: element, historical preview,
 * multi-selection, then the final object selection.
 */
export function clearDesignSelectionLayer(
  state: DesignWorkbenchSelectionState,
  source: DesignSelectionSource = "canvas",
): DesignWorkbenchSelectionState {
  const layer = designSelectionEscapeLayer(state);
  const screen = designPrimaryScreenSelection(state);
  if (layer === "element" && screen) {
    return {
      ...updateScreen(state, screen.lineageId, (candidate) => ({
        ...candidate,
        element: undefined,
      })),
      lastSource: source,
    };
  }
  if (layer === "historical-preview" && screen) {
    return {
      ...updateScreen(state, screen.lineageId, (candidate) => ({
        ...candidate,
        previewRevision: undefined,
        element: undefined,
      })),
      lastSource: source,
    };
  }
  if (layer === "multiple") {
    const primary = state.selections.find(
      (selection) => designWorkbenchSelectionKey(selection) === state.primaryKey,
    );
    return createDesignWorkbenchSelectionState(primary ? [primary] : [], source);
  }
  if (layer === "selection") {
    return reduceDesignWorkbenchSelection(state, { type: "clear-all", source });
  }
  return state;
}
