import { imageNodePorts, isImagePortCompatible, validateWorkflowGraph } from "../shared/images/ports";
import {
  IMAGE_WORKFLOW_LIMITS,
  type WorkflowDocV1,
  type WorkflowEdge,
  type WorkflowPosition,
} from "../shared/images/schema";

export interface CanvasConnectionIntent {
  source: string | null;
  sourcePort: string | null;
  target: string | null;
  targetPort: string | null;
}

export type CanvasConnectionDecision =
  | { allowed: true; edge: WorkflowEdge }
  | { allowed: false; message: string };

export function decideCanvasMutationCapacity(
  nodeCount: number,
  edgeCount: number,
  addedNodes: number,
  addedEdges: number,
): { allowed: boolean; message?: string } {
  if (nodeCount + addedNodes > IMAGE_WORKFLOW_LIMITS.maxNodes) {
    return { allowed: false, message: `Workflows are limited to ${IMAGE_WORKFLOW_LIMITS.maxNodes} nodes.` };
  }
  if (edgeCount + addedEdges > IMAGE_WORKFLOW_LIMITS.maxEdges) {
    return {
      allowed: false,
      message: `Workflows are limited to ${IMAGE_WORKFLOW_LIMITS.maxEdges.toLocaleString("en-US")} connections.`,
    };
  }
  return { allowed: true };
}

export function boundedCanvasPosition(position: WorkflowPosition): WorkflowPosition {
  const limit = IMAGE_WORKFLOW_LIMITS.positionLimit;
  const coordinate = (value: number) => (Number.isFinite(value) ? Math.max(-limit, Math.min(limit, value)) : 0);
  return { x: coordinate(position.x), y: coordinate(position.y) };
}

export function decideCanvasConnection(
  document: WorkflowDocV1,
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
  const sourcePort = imageNodePorts(source, "outputs").find((port) => port.id === intent.sourcePort);
  const targetPort = imageNodePorts(target, "inputs").find((port) => port.id === intent.targetPort);
  if (!sourcePort || !targetPort) return { allowed: false, message: "Connect an output port to an input port." };
  if (!isImagePortCompatible(sourcePort.kind, targetPort.kind)) {
    return { allowed: false, message: `${sourcePort.label} cannot connect to ${targetPort.label}.` };
  }
  const edge: WorkflowEdge = {
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

export function commitEditorHistory<T>(history: EditorHistory<T>, next: T, limit = 50): EditorHistory<T> {
  return { past: [...history.past, history.present].slice(-limit), present: next, future: [] };
}

export function undoEditorHistory<T>(history: EditorHistory<T>): EditorHistory<T> {
  if (history.past.length === 0) return history;
  return {
    past: history.past.slice(0, -1),
    present: history.past[history.past.length - 1]!,
    future: [history.present, ...history.future],
  };
}

export function redoEditorHistory<T>(history: EditorHistory<T>): EditorHistory<T> {
  if (history.future.length === 0) return history;
  return { past: [...history.past, history.present], present: history.future[0]!, future: history.future.slice(1) };
}

const encoder = new TextEncoder();

/** Truncates to the 16 KiB UTF-8 prompt bound without splitting a code point. */
export function boundedPromptText(value: string): string {
  if (encoder.encode(value).byteLength <= IMAGE_WORKFLOW_LIMITS.maxPromptBytes) return value;
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > IMAGE_WORKFLOW_LIMITS.maxPromptBytes) break;
    bytes += size;
    output += character;
  }
  return output;
}
