import {
  isSubagentRunViewStateActive,
  type SubagentRunView,
} from "./subagent-view-state";

export interface SubagentTreeNode {
  run: SubagentRunView;
  parentRunId?: string;
  children: SubagentTreeNode[];
  level: number;
  position: number;
  setSize: number;
  branchActive: boolean;
  descendantCount: number;
  activeDescendantCount: number;
}

export interface SubagentTreeGroups {
  active: SubagentTreeNode[];
  done: SubagentTreeNode[];
}

function canAttach(parent: SubagentRunView | undefined, child: SubagentRunView): boolean {
  const parentSnapshot = parent?.snapshot;
  const childSnapshot = child.snapshot;
  return Boolean(
    parent &&
      parentSnapshot?.version === 2 &&
      parentSnapshot.depth === 1 &&
      childSnapshot?.version === 2 &&
      childSnapshot.depth === 2 &&
      childSnapshot.parentRunId === parent.runId &&
      childSnapshot.chatId === parentSnapshot.chatId &&
      childSnapshot.workspaceId === parentSnapshot.workspaceId &&
      childSnapshot.generationId === parentSnapshot.generationId,
  );
}

/**
 * Reconstruct only lineage proven by strict V2 snapshots. Legacy, orphaned,
 * owner-mismatched and otherwise corrupt-looking records remain visible roots.
 */
export function buildSubagentTree(runs: readonly SubagentRunView[]): SubagentTreeGroups {
  const byId = new Map(runs.map((run) => [run.runId, run]));
  const childrenByParent = new Map<string, SubagentRunView[]>();
  const attached = new Set<string>();
  for (const run of runs) {
    const snapshot = run.snapshot;
    if (snapshot?.version !== 2 || snapshot.depth !== 2 || !snapshot.parentRunId) continue;
    const parent = byId.get(snapshot.parentRunId);
    if (!canAttach(parent, run)) continue;
    const siblings = childrenByParent.get(parent!.runId) ?? [];
    siblings.push(run);
    childrenByParent.set(parent!.runId, siblings);
    attached.add(run.runId);
  }

  const roots = runs.filter((run) => !attached.has(run.runId));
  const nodes = roots.map((run): SubagentTreeNode => {
    const childRuns = childrenByParent.get(run.runId) ?? [];
    const children = childRuns.map((child, index): SubagentTreeNode => ({
      run: child,
      parentRunId: run.runId,
      children: [],
      level: 2,
      position: index + 1,
      setSize: childRuns.length,
      branchActive: isSubagentRunViewStateActive(child.state),
      descendantCount: 0,
      activeDescendantCount: 0,
    }));
    const activeDescendantCount = children.filter(({ branchActive }) => branchActive).length;
    return {
      run,
      children,
      level: 1,
      position: 0,
      setSize: 0,
      branchActive: isSubagentRunViewStateActive(run.state) || activeDescendantCount > 0,
      descendantCount: children.length,
      activeDescendantCount,
    };
  });
  const active = nodes.filter(({ branchActive }) => branchActive);
  const done = nodes.filter(({ branchActive }) => !branchActive);
  for (const group of [active, done]) {
    group.forEach((node, index) => {
      node.position = index + 1;
      node.setSize = group.length;
    });
  }
  return { active, done };
}

export function subagentTreeIsExpanded(
  node: SubagentTreeNode,
  expansion: Readonly<Record<string, boolean>>,
): boolean {
  return node.children.length > 0 && (expansion[node.run.runId] ?? node.branchActive);
}

export function visibleSubagentTreeNodes(
  groups: SubagentTreeGroups,
  expansion: Readonly<Record<string, boolean>>,
): SubagentTreeNode[] {
  const visible: SubagentTreeNode[] = [];
  for (const root of [...groups.active, ...groups.done]) {
    visible.push(root);
    if (subagentTreeIsExpanded(root, expansion)) visible.push(...root.children);
  }
  return visible;
}

export type SubagentTreeKey =
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowRight"
  | "ArrowLeft"
  | "Home"
  | "End";

export interface SubagentTreeKeyResult {
  focusRunId: string;
  expansion?: Readonly<Record<string, boolean>>;
}

export function subagentTreeKeyResult(
  groups: SubagentTreeGroups,
  expansion: Readonly<Record<string, boolean>>,
  focusedRunId: string,
  key: SubagentTreeKey,
): SubagentTreeKeyResult {
  const visible = visibleSubagentTreeNodes(groups, expansion);
  if (visible.length === 0) return { focusRunId: focusedRunId };
  const index = Math.max(0, visible.findIndex(({ run }) => run.runId === focusedRunId));
  const current = visible[index]!;
  if (key === "Home") return { focusRunId: visible[0]!.run.runId };
  if (key === "End") return { focusRunId: visible[visible.length - 1]!.run.runId };
  if (key === "ArrowUp") {
    return { focusRunId: visible[Math.max(0, index - 1)]!.run.runId };
  }
  if (key === "ArrowDown") {
    return { focusRunId: visible[Math.min(visible.length - 1, index + 1)]!.run.runId };
  }
  if (key === "ArrowRight") {
    if (current.children.length === 0) return { focusRunId: current.run.runId };
    if (!subagentTreeIsExpanded(current, expansion)) {
      return {
        focusRunId: current.run.runId,
        expansion: { ...expansion, [current.run.runId]: true },
      };
    }
    return { focusRunId: current.children[0]!.run.runId };
  }
  if (current.children.length > 0 && subagentTreeIsExpanded(current, expansion)) {
    return {
      focusRunId: current.run.runId,
      expansion: { ...expansion, [current.run.runId]: false },
    };
  }
  return { focusRunId: current.parentRunId ?? current.run.runId };
}
