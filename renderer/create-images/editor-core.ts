import {
  CREATE_IMAGES_NODE_DEFINITIONS,
  isCreateImagesPortCompatible,
  validateWorkflowGraph,
} from "../shared/create-images/ports";
import type { WorkflowDocumentV1, WorkflowEdgeV1 } from "../shared/create-images/schema";
import {
  CREATE_IMAGES_MAX_EDGES,
  CREATE_IMAGES_MAX_NODES,
  CREATE_IMAGES_MAX_PROMPT_LENGTH,
  CREATE_IMAGES_POSITION_LIMIT,
} from "../shared/create-images/schema";
import type { CreateImagesPosition } from "../shared/create-images/schema";

export interface CanvasConnectionIntent {
  source: string | null;
  sourcePort: string | null;
  target: string | null;
  targetPort: string | null;
}

export type CanvasConnectionDecision =
  | { allowed: true; edge: WorkflowEdgeV1 }
  | { allowed: false; message: string };

export interface CanvasMutationCapacity {
  allowed: boolean;
  message?: string;
}

export type CreateImagesGraphShortcut = "undo" | "redo" | "duplicate";

export function resolveCreateImagesGraphShortcut(input: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): CreateImagesGraphShortcut | null {
  if (!input.metaKey || input.ctrlKey || input.altKey) return null;
  const key = input.key.toLowerCase();
  if (key === "z") return input.shiftKey ? "redo" : "undo";
  if (key === "d" && !input.shiftKey) return "duplicate";
  return null;
}

export function decideCanvasMutationCapacity(
  nodeCount: number,
  edgeCount: number,
  addedNodes: number,
  addedEdges: number,
): CanvasMutationCapacity {
  if (nodeCount + addedNodes > CREATE_IMAGES_MAX_NODES) {
    return {
      allowed: false,
      message: `Workflows are limited to ${CREATE_IMAGES_MAX_NODES.toLocaleString("en-US")} nodes.`,
    };
  }
  if (edgeCount + addedEdges > CREATE_IMAGES_MAX_EDGES) {
    return {
      allowed: false,
      message: `Workflows are limited to ${CREATE_IMAGES_MAX_EDGES.toLocaleString("en-US")} connections.`,
    };
  }
  return { allowed: true };
}

export function boundedPromptText(value: string): string {
  return value.slice(0, CREATE_IMAGES_MAX_PROMPT_LENGTH);
}

export function boundedCanvasPosition(position: CreateImagesPosition): CreateImagesPosition {
  const coordinate = (value: number) =>
    Number.isFinite(value)
      ? Math.max(-CREATE_IMAGES_POSITION_LIMIT, Math.min(CREATE_IMAGES_POSITION_LIMIT, value))
      : 0;
  return { x: coordinate(position.x), y: coordinate(position.y) };
}

export function decideCanvasConnection(
  document: WorkflowDocumentV1,
  intent: CanvasConnectionIntent,
  edgeId: string,
): CanvasConnectionDecision {
  const capacity = decideCanvasMutationCapacity(document.nodes.length, document.edges.length, 0, 1);
  if (!capacity.allowed) return { allowed: false, message: capacity.message! };
  if (!intent.source || !intent.sourcePort || !intent.target || !intent.targetPort) {
    return { allowed: false, message: "Choose a source and destination port." };
  }
  const source = document.nodes.find((node) => node.id === intent.source);
  const target = document.nodes.find((node) => node.id === intent.target);
  if (!source || !target) return { allowed: false, message: "That node is no longer available." };
  const sourcePort = CREATE_IMAGES_NODE_DEFINITIONS[source.type].outputs.find(
    (port) => port.id === intent.sourcePort,
  );
  const targetPort = CREATE_IMAGES_NODE_DEFINITIONS[target.type].inputs.find(
    (port) => port.id === intent.targetPort,
  );
  if (!sourcePort || !targetPort) {
    return { allowed: false, message: "Connect an output port to an input port." };
  }
  if (!isCreateImagesPortCompatible(sourcePort.kind, targetPort.kind)) {
    return {
      allowed: false,
      message: `${sourcePort.label} cannot connect to ${targetPort.label}.`,
    };
  }
  const edge: WorkflowEdgeV1 = {
    id: edgeId,
    source: source.id,
    sourcePort: sourcePort.id,
    target: target.id,
    targetPort: targetPort.id,
  };
  const issues = validateWorkflowGraph({ ...document, edges: [...document.edges, edge] });
  const introduced = issues.find((issue) => issue.edgeId === edge.id || issue.code === "cycle");
  return introduced ? { allowed: false, message: introduced.message } : { allowed: true, edge };
}

export interface EditorHistory<T> {
  past: readonly T[];
  present: T;
  future: readonly T[];
}

export function createEditorHistory<T>(present: T): EditorHistory<T> {
  return { past: [], present, future: [] };
}

export function commitEditorHistory<T>(
  history: EditorHistory<T>,
  next: T,
  limit = 50,
): EditorHistory<T> {
  return {
    past: [...history.past, history.present].slice(-limit),
    present: next,
    future: [],
  };
}

export function undoEditorHistory<T>(history: EditorHistory<T>): EditorHistory<T> {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redoEditorHistory<T>(history: EditorHistory<T>): EditorHistory<T> {
  const next = history.future[0];
  if (next === undefined) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}
