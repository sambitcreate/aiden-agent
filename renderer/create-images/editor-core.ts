import {
  CREATE_IMAGES_NODE_DEFINITIONS,
  createImagesNodePorts,
  isCreateImagesPortCompatible,
  validateWorkflowGraph,
} from "../shared/create-images/ports";
import type {
  CreateImagesNodeType,
  WorkflowDocumentV1,
  WorkflowEdgeV1,
  WorkflowNodeV1,
} from "../shared/create-images/schema";
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

export type CreateImagesGraphShortcut =
  | "undo"
  | "redo"
  | "duplicate"
  | "copy"
  | "paste"
  | "open-search"
  | "shortcuts";

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
  if (key === "c" && !input.shiftKey) return "copy";
  if (key === "v" && !input.shiftKey) return "paste";
  if (key === "k" && input.shiftKey) return "open-search";
  if (key === "/" && input.shiftKey) return "shortcuts";
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
  const sourcePort = createImagesNodePorts(source, "outputs").find(
    (port) => port.id === intent.sourcePort,
  );
  const targetPort = createImagesNodePorts(target, "inputs").find(
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

export interface CreateImagesDanglingConnectionOrigin {
  nodeId: string;
  portId: string;
  direction: "source" | "target";
}

export interface CreateImagesCompatibleNodeOption {
  type: CreateImagesNodeType;
  portId: string;
  portLabel: string;
}

export function compatibleCreateImagesNodeOptions(
  document: WorkflowDocumentV1,
  origin: CreateImagesDanglingConnectionOrigin,
): CreateImagesCompatibleNodeOption[] {
  const originNode = document.nodes.find((node) => node.id === origin.nodeId);
  if (!originNode) return [];
  const originPort = createImagesNodePorts(
    originNode,
    origin.direction === "source" ? "outputs" : "inputs",
  ).find(
    (port) => port.id === origin.portId,
  );
  if (!originPort) return [];

  if (origin.direction === "target" && originPort.maxConnections !== undefined) {
    const incomingCount = document.edges.filter(
      (edge) => edge.target === origin.nodeId && edge.targetPort === origin.portId,
    ).length;
    if (incomingCount >= originPort.maxConnections) return [];
  }

  const options: CreateImagesCompatibleNodeOption[] = [];
  for (const type of Object.keys(CREATE_IMAGES_NODE_DEFINITIONS) as CreateImagesNodeType[]) {
    const candidateNode = {
      id: `candidate-${type}`,
      type,
      position: { x: 0, y: 0 },
      data:
        type === "prompt"
          ? { text: "" }
          : type === "generate-image"
            ? { aspectRatio: "1:1", imageSize: "1K", outputMime: "image/png", count: 1 }
            : type === "image-compare"
              ? { divider: 0.5 }
              : type === "annotation"
                ? { shapes: [] }
                : type === "group"
                  ? { memberNodeIds: [], color: "gray", locked: false }
                  : {},
    } as WorkflowNodeV1;
    const candidatePorts = createImagesNodePorts(
      candidateNode,
      origin.direction === "source" ? "inputs" : "outputs",
    );
    for (const candidate of candidatePorts) {
      const compatible =
        origin.direction === "source"
          ? isCreateImagesPortCompatible(originPort.kind, candidate.kind)
          : isCreateImagesPortCompatible(candidate.kind, originPort.kind);
      if (compatible) options.push({ type, portId: candidate.id, portLabel: candidate.label });
    }
  }
  return options;
}

export type CreateImagesArrangement = "horizontal" | "vertical" | "grid";

export interface CreateImagesLayoutItem {
  id: string;
  position: CreateImagesPosition;
  width?: number;
  height?: number;
}

export interface CreateImagesLayoutPosition {
  id: string;
  position: CreateImagesPosition;
}

export function arrangeCreateImagesSelection(
  items: readonly CreateImagesLayoutItem[],
  mode: CreateImagesArrangement,
  options: { defaultWidth?: number; defaultHeight?: number; gap?: number } = {},
): CreateImagesLayoutPosition[] {
  if (items.length < 2) return items.map((item) => ({ id: item.id, position: item.position }));
  const defaultWidth = options.defaultWidth ?? 288;
  const defaultHeight = options.defaultHeight ?? 300;
  const gap = Math.max(0, Math.min(200, options.gap ?? 24));
  const top = Math.min(...items.map((item) => item.position.y));
  const left = Math.min(...items.map((item) => item.position.x));

  if (mode === "horizontal") {
    let x = left;
    return [...items]
      .sort(
        (a, b) =>
          a.position.x - b.position.x || a.position.y - b.position.y || a.id.localeCompare(b.id),
      )
      .map((item) => {
        const position = boundedCanvasPosition({ x, y: top });
        x += Math.max(1, item.width ?? defaultWidth) + gap;
        return { id: item.id, position };
      });
  }

  if (mode === "vertical") {
    let y = top;
    return [...items]
      .sort(
        (a, b) =>
          a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id),
      )
      .map((item) => {
        const position = boundedCanvasPosition({ x: left, y });
        y += Math.max(1, item.height ?? defaultHeight) + gap;
        return { id: item.id, position };
      });
  }

  const sorted = [...items].sort(
    (a, b) => a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id),
  );
  const columns = Math.ceil(Math.sqrt(sorted.length));
  const cellWidth = Math.max(defaultWidth, ...sorted.map((item) => item.width ?? defaultWidth));
  const cellHeight = Math.max(defaultHeight, ...sorted.map((item) => item.height ?? defaultHeight));
  return sorted.map((item, index) => ({
    id: item.id,
    position: boundedCanvasPosition({
      x: left + (index % columns) * (cellWidth + gap),
      y: top + Math.floor(index / columns) * (cellHeight + gap),
    }),
  }));
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
