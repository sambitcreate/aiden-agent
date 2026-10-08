import {
  IMAGE_WORKFLOW_LIMITS,
  type ImageNodeType,
  type WorkflowDocV1,
  type WorkflowEdge,
  type WorkflowNode,
} from "./schema.js";

export type ImagePortKind = "text" | "image" | "images";

export interface ImagePortDefinition {
  id: string;
  kind: ImagePortKind;
  label: string;
  required?: boolean;
  maxConnections?: number;
}

export interface ImageNodeDefinition {
  type: ImageNodeType;
  title: string;
  /** Local nodes resolve inline; provider nodes send one paid request. */
  lane: "local" | "provider";
  inputs: readonly ImagePortDefinition[];
  outputs: readonly ImagePortDefinition[];
}

export const IMAGE_NODE_DEFINITIONS: Readonly<Record<ImageNodeType, ImageNodeDefinition>> = Object.freeze({
  prompt: {
    type: "prompt",
    title: "Prompt",
    lane: "local",
    inputs: [],
    outputs: [{ id: "text", kind: "text", label: "Prompt" }],
  },
  "image-input": {
    type: "image-input",
    title: "Image Input",
    lane: "local",
    inputs: [],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
  },
  "generate-image": {
    type: "generate-image",
    title: "Generate Image",
    lane: "provider",
    inputs: [
      { id: "prompt", kind: "text", label: "Prompt", required: true, maxConnections: 1 },
      {
        id: "references",
        kind: "images",
        label: "References",
        maxConnections: IMAGE_WORKFLOW_LIMITS.maxReferences,
      },
    ],
    outputs: [{ id: "images", kind: "images", label: "Images" }],
  },
  output: {
    type: "output",
    title: "Output",
    lane: "local",
    inputs: [{ id: "images", kind: "images", label: "Images", required: true, maxConnections: 1 }],
    outputs: [],
  },
});

export function imageNodePorts(
  node: Pick<WorkflowNode, "type">,
  direction: "inputs" | "outputs",
): readonly ImagePortDefinition[] {
  return IMAGE_NODE_DEFINITIONS[node.type][direction];
}

export function isImagePortCompatible(source: ImagePortKind, target: ImagePortKind): boolean {
  return source === target || (source === "image" && target === "images");
}

export type WorkflowGraphIssueCode =
  | "unknown_node"
  | "unknown_port"
  | "invalid_direction"
  | "incompatible_port"
  | "duplicate_connection"
  | "connection_limit"
  | "self_loop"
  | "cycle"
  | "missing_required_input"
  | "missing_asset"
  | "missing_prompt"
  | "missing_model";

export interface WorkflowGraphIssue {
  code: WorkflowGraphIssueCode;
  message: string;
  nodeId?: string;
  edgeId?: string;
  portId?: string;
}

function port(node: WorkflowNode, direction: "inputs" | "outputs", portId: string) {
  return imageNodePorts(node, direction).find((candidate) => candidate.id === portId);
}

function structurallyValidEdges(document: WorkflowDocV1, issues: WorkflowGraphIssue[]): WorkflowEdge[] {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const incomingCount = new Map<string, number>();
  const valid: WorkflowEdge[] = [];
  for (const edge of document.edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) {
      issues.push({ code: "unknown_node", edgeId: edge.id, message: "This connection points at a node that no longer exists." });
      continue;
    }
    if (source.id === target.id) {
      issues.push({ code: "self_loop", edgeId: edge.id, nodeId: source.id, message: "A node cannot connect to itself." });
      continue;
    }
    const sourcePort = port(source, "outputs", edge.sourcePort);
    if (!sourcePort) {
      const reversed = port(source, "inputs", edge.sourcePort) !== undefined;
      issues.push({
        code: reversed ? "invalid_direction" : "unknown_port",
        edgeId: edge.id,
        nodeId: source.id,
        portId: edge.sourcePort,
        message: reversed ? "Connections start from an output port." : "That output port does not exist.",
      });
      continue;
    }
    const targetPort = port(target, "inputs", edge.targetPort);
    if (!targetPort) {
      const reversed = port(target, "outputs", edge.targetPort) !== undefined;
      issues.push({
        code: reversed ? "invalid_direction" : "unknown_port",
        edgeId: edge.id,
        nodeId: target.id,
        portId: edge.targetPort,
        message: reversed ? "Connections end at an input port." : "That input port does not exist.",
      });
      continue;
    }
    if (!isImagePortCompatible(sourcePort.kind, targetPort.kind)) {
      issues.push({
        code: "incompatible_port",
        edgeId: edge.id,
        message: `${sourcePort.label} cannot connect to ${targetPort.label}.`,
      });
      continue;
    }
    const key = [edge.source, edge.sourcePort, edge.target, edge.targetPort].join("\u0000");
    if (seen.has(key)) {
      issues.push({ code: "duplicate_connection", edgeId: edge.id, message: "This connection already exists." });
      continue;
    }
    seen.add(key);
    const targetKey = `${target.id}\u0000${targetPort.id}`;
    const count = (incomingCount.get(targetKey) ?? 0) + 1;
    incomingCount.set(targetKey, count);
    if (targetPort.maxConnections !== undefined && count > targetPort.maxConnections) {
      issues.push({
        code: "connection_limit",
        edgeId: edge.id,
        nodeId: target.id,
        portId: targetPort.id,
        message: `${targetPort.label} accepts at most ${targetPort.maxConnections} connection${targetPort.maxConnections === 1 ? "" : "s"}.`,
      });
      continue;
    }
    valid.push(edge);
  }
  return valid;
}

/** Kahn's algorithm. Ready nodes leave in document order, so plans are deterministic. */
function kahn(document: WorkflowDocV1, edges: readonly WorkflowEdge[]) {
  const index = new Map(document.nodes.map((node, position) => [node.id, position]));
  const indegree = new Map(document.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(document.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }
  const ready = document.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort((left, right) => index.get(left)! - index.get(right)!);
    const current = ready.shift()!;
    order.push(current);
    for (const target of outgoing.get(current) ?? []) {
      const next = indegree.get(target)! - 1;
      indegree.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  return { order, remaining: indegree };
}

function cycleIssues(document: WorkflowDocV1, edges: readonly WorkflowEdge[]): WorkflowGraphIssue[] {
  const { order, remaining } = kahn(document, edges);
  if (order.length === document.nodes.length) return [];
  return document.nodes
    .filter((node) => remaining.get(node.id)! > 0)
    .map((node) => ({
      code: "cycle" as const,
      nodeId: node.id,
      message: "Cycles are not supported in image workflows.",
    }));
}

export function topologicalWorkflowOrder(document: WorkflowDocV1): {
  order: string[];
  issues: WorkflowGraphIssue[];
} {
  const issues: WorkflowGraphIssue[] = [];
  const edges = structurallyValidEdges(document, issues);
  issues.push(...cycleIssues(document, edges));
  if (issues.length > 0) return { order: [], issues };
  return { order: kahn(document, edges).order, issues };
}

export function validateWorkflowGraph(
  document: WorkflowDocV1,
  options: { forRun?: boolean; nodeIds?: ReadonlySet<string> } = {},
): WorkflowGraphIssue[] {
  const issues: WorkflowGraphIssue[] = [];
  const validEdges = structurallyValidEdges(document, issues);
  issues.push(...cycleIssues(document, validEdges));
  if (!options.forRun) return issues;

  const incoming = new Set(validEdges.map((edge) => `${edge.target}\u0000${edge.targetPort}`));
  for (const node of document.nodes) {
    if (options.nodeIds && !options.nodeIds.has(node.id)) continue;
    const definition = IMAGE_NODE_DEFINITIONS[node.type];
    for (const input of definition.inputs) {
      if (input.required && !incoming.has(`${node.id}\u0000${input.id}`)) {
        issues.push({
          code: "missing_required_input",
          nodeId: node.id,
          portId: input.id,
          message: `${definition.title} needs a ${input.label} connection.`,
        });
      }
    }
    if (node.type === "prompt" && node.data.text.trim().length === 0) {
      issues.push({ code: "missing_prompt", nodeId: node.id, message: "Write a prompt before running." });
    } else if (node.type === "image-input" && !node.data.assetId) {
      issues.push({ code: "missing_asset", nodeId: node.id, message: "Choose an image before running." });
    } else if (node.type === "generate-image" && !node.data.model) {
      issues.push({ code: "missing_model", nodeId: node.id, message: "Choose an image model." });
    }
  }
  return issues;
}
