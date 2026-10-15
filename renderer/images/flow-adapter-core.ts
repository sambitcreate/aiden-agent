import type { Edge, EdgeChange, Node, NodeChange } from "@xyflow/react";
import type { ImageNodeType, WorkflowDocV1, WorkflowNode, WorkflowPosition } from "../shared/images/schema";
import type { EditorOp } from "./workflow-session-core";

export type WorkflowFlowNode = Node<{ node: WorkflowNode }, ImageNodeType>;

export function toFlowNodes(
  doc: WorkflowDocV1,
  dragging: ReadonlyMap<string, WorkflowPosition>,
  selected: ReadonlySet<string>,
  measured: ReadonlyMap<string, { width: number; height: number }> = new Map(),
): WorkflowFlowNode[] {
  return doc.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: dragging.get(node.id) ?? node.position,
    data: { node },
    selected: selected.has(node.id),
    ...(node.dimensions ? { width: node.dimensions.width, height: node.dimensions.height } : {}),
    // React Flow reports rendered sizes as dimension changes; a controlled flow must hand them back.
    ...(measured.get(node.id) ? { measured: measured.get(node.id) } : {}),
  }));
}

export function toFlowEdges(doc: WorkflowDocV1, selected: ReadonlySet<string>): Edge[] {
  return doc.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourcePort,
    target: edge.target,
    targetHandle: edge.targetPort,
    selected: selected.has(edge.id),
  }));
}

/**
 * Drags stay a transient overlay; only the drop becomes an undoable move. Removals only clear
 * transient state here: React Flow reports a deletion as separate edge and node changes, so the
 * document edit comes once from `deletionOp` (its `onDelete`) and stays one undo step.
 */
export function interpretNodeChanges(
  changes: readonly NodeChange<WorkflowFlowNode>[],
  state: {
    dragging: ReadonlyMap<string, WorkflowPosition>;
    selected: ReadonlySet<string>;
    measured?: ReadonlyMap<string, { width: number; height: number }>;
  },
): {
  ops: EditorOp[];
  dragging: Map<string, WorkflowPosition>;
  selected: Set<string>;
  measured: Map<string, { width: number; height: number }>;
} {
  const dragging = new Map(state.dragging);
  const selected = new Set(state.selected);
  const measured = new Map(state.measured ?? []);
  const moves: { id: string; position: WorkflowPosition }[] = [];
  for (const change of changes) {
    if (change.type === "position") {
      if (change.dragging && change.position) {
        dragging.set(change.id, change.position);
      } else if (change.dragging === false) {
        const position = change.position ?? dragging.get(change.id);
        dragging.delete(change.id);
        if (position) moves.push({ id: change.id, position });
      }
    } else if (change.type === "dimensions") {
      if (change.dimensions) measured.set(change.id, { width: change.dimensions.width, height: change.dimensions.height });
    } else if (change.type === "remove") {
      selected.delete(change.id);
      dragging.delete(change.id);
      measured.delete(change.id);
    } else if (change.type === "select") {
      if (change.selected) selected.add(change.id);
      else selected.delete(change.id);
    }
  }
  const ops: EditorOp[] = moves.length > 0 ? [{ type: "move-nodes", positions: moves }] : [];
  return { ops, dragging, selected, measured };
}

export function interpretEdgeChanges(
  changes: readonly EdgeChange[],
  selected: ReadonlySet<string>,
): Set<string> {
  const next = new Set(selected);
  for (const change of changes) {
    if (change.type === "remove") {
      next.delete(change.id);
    } else if (change.type === "select") {
      if (change.selected) next.add(change.id);
      else next.delete(change.id);
    }
  }
  return next;
}

/** One deletion (Backspace on a node, its edges, or a selection) is one undoable edit. */
export function deletionOp(deleted: { nodes: readonly { id: string }[]; edges: readonly { id: string }[] }): EditorOp | null {
  if (deleted.nodes.length === 0 && deleted.edges.length === 0) return null;
  return { type: "remove", nodeIds: deleted.nodes.map((node) => node.id), edgeIds: deleted.edges.map((edge) => edge.id) };
}
