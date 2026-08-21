import type {
  CreateImagesNodeType,
  WorkflowDocumentV1,
  WorkflowEdgeV1,
  WorkflowNodeV1,
} from "./schema.js";
import { parseCreateImagesPromptList } from "./prompt-list.js";

export type CreateImagesPortKind = "text" | "text-list" | "image" | "image-list" | "metadata";

export interface CreateImagesPortDefinition {
  id: string;
  kind: CreateImagesPortKind;
  label: string;
  required?: boolean;
  maxConnections?: number;
}

export interface CreateImagesNodeDefinition {
  type: CreateImagesNodeType;
  title: string;
  category: "input" | "prompt" | "generation" | "output";
  inputs: readonly CreateImagesPortDefinition[];
  outputs: readonly CreateImagesPortDefinition[];
  execution: "local" | "remote";
}

export const CREATE_IMAGES_NODE_DEFINITIONS: Readonly<
  Record<CreateImagesNodeType, CreateImagesNodeDefinition>
> = Object.freeze({
  "image-input": {
    type: "image-input",
    title: "Image Input",
    category: "input",
    inputs: [],
    outputs: [{ id: "image", kind: "image", label: "Image" }],
    execution: "local",
  },
  prompt: {
    type: "prompt",
    title: "Prompt",
    category: "prompt",
    inputs: [],
    outputs: [{ id: "text", kind: "text", label: "Prompt" }],
    execution: "local",
  },
  "prompt-list": {
    type: "prompt-list",
    title: "Prompt List",
    category: "prompt",
    inputs: [],
    outputs: [{ id: "items", kind: "text-list", label: "Prompt items" }],
    execution: "local",
  },
  "generate-image": {
    type: "generate-image",
    title: "Generate Image",
    category: "generation",
    inputs: [
      { id: "prompt", kind: "text", label: "Prompt", required: true, maxConnections: 1 },
      { id: "references", kind: "image-list", label: "References", maxConnections: 14 },
    ],
    outputs: [
      { id: "images", kind: "image-list", label: "Images" },
      { id: "metadata", kind: "metadata", label: "Generation metadata" },
    ],
    execution: "remote",
  },
  output: {
    type: "output",
    title: "Output",
    category: "output",
    inputs: [
      { id: "images", kind: "image-list", label: "Images", required: true, maxConnections: 1 },
    ],
    outputs: [],
    execution: "local",
  },
  "output-gallery": {
    type: "output-gallery",
    title: "Output Gallery",
    category: "output",
    inputs: [
      { id: "images", kind: "image-list", label: "Images", required: true, maxConnections: 64 },
    ],
    outputs: [],
    execution: "local",
  },
  "image-compare": {
    type: "image-compare",
    title: "Image Compare",
    category: "output",
    inputs: [
      { id: "left", kind: "image-list", label: "Image A", required: true, maxConnections: 1 },
      { id: "right", kind: "image-list", label: "Image B", required: true, maxConnections: 1 },
    ],
    outputs: [],
    execution: "local",
  },
  annotation: {
    type: "annotation",
    title: "Annotation",
    category: "generation",
    inputs: [
      { id: "image", kind: "image-list", label: "Image", required: true, maxConnections: 1 },
    ],
    outputs: [{ id: "image", kind: "image-list", label: "Annotated image" }],
    execution: "local",
  },
  group: {
    type: "group",
    title: "Group",
    category: "output",
    inputs: [],
    outputs: [],
    execution: "local",
  },
});

export function createImagesNodePorts(
  node: WorkflowNodeV1,
  direction: "inputs" | "outputs",
): readonly CreateImagesPortDefinition[] {
  if (node.type === "prompt" && direction === "inputs") {
    return (node.data.variables ?? []).map((variable) => ({
      id: `variable-${variable.id}`,
      kind: "text" as const,
      label: variable.name,
      required: variable.required,
      maxConnections: 1,
    }));
  }
  return CREATE_IMAGES_NODE_DEFINITIONS[node.type][direction];
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
  | "missing_provider"
  | "missing_model"
  | "invalid_run_scope";

export interface WorkflowGraphIssue {
  code: WorkflowGraphIssueCode;
  message: string;
  nodeId?: string;
  edgeId?: string;
  portId?: string;
}

function nodeMap(document: WorkflowDocumentV1): Map<string, WorkflowNodeV1> {
  return new Map(document.nodes.map((node) => [node.id, node]));
}

function port(
  node: WorkflowNodeV1,
  direction: "inputs" | "outputs",
  portId: string,
): CreateImagesPortDefinition | undefined {
  return createImagesNodePorts(node, direction).find(
    (candidate) => candidate.id === portId,
  );
}

export function isCreateImagesPortCompatible(
  source: CreateImagesPortKind,
  target: CreateImagesPortKind,
): boolean {
  return (
    source === target ||
    (source === "image" && target === "image-list") ||
    (source === "text-list" && target === "text")
  );
}

function connectionKey(edge: WorkflowEdgeV1): string {
  return [edge.source, edge.sourcePort, edge.target, edge.targetPort].join("\u0000");
}

function structurallyValidEdges(
  document: WorkflowDocumentV1,
  issues: WorkflowGraphIssue[],
): WorkflowEdgeV1[] {
  const nodes = nodeMap(document);
  const seenConnections = new Set<string>();
  const incomingCount = new Map<string, number>();
  const valid: WorkflowEdgeV1[] = [];

  for (const edge of document.edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) {
      issues.push({
        code: "unknown_node",
        edgeId: edge.id,
        message: `Edge "${edge.id}" references a node that is not in the workflow.`,
      });
      continue;
    }
    if (source.id === target.id) {
      issues.push({
        code: "self_loop",
        edgeId: edge.id,
        nodeId: source.id,
        message: "A node cannot connect to itself.",
      });
      continue;
    }
    const sourcePort = port(source, "outputs", edge.sourcePort);
    const targetPort = port(target, "inputs", edge.targetPort);
    if (!sourcePort) {
      const reverse = port(source, "inputs", edge.sourcePort);
      issues.push({
        code: reverse ? "invalid_direction" : "unknown_port",
        edgeId: edge.id,
        nodeId: source.id,
        portId: edge.sourcePort,
        message: reverse
          ? `Port "${edge.sourcePort}" is an input and cannot start a connection.`
          : `Source port "${edge.sourcePort}" does not exist on ${source.type}.`,
      });
      continue;
    }
    if (!targetPort) {
      const reverse = port(target, "outputs", edge.targetPort);
      issues.push({
        code: reverse ? "invalid_direction" : "unknown_port",
        edgeId: edge.id,
        nodeId: target.id,
        portId: edge.targetPort,
        message: reverse
          ? `Port "${edge.targetPort}" is an output and cannot end a connection.`
          : `Target port "${edge.targetPort}" does not exist on ${target.type}.`,
      });
      continue;
    }
    if (!isCreateImagesPortCompatible(sourcePort.kind, targetPort.kind)) {
      issues.push({
        code: "incompatible_port",
        edgeId: edge.id,
        message: `${sourcePort.label} (${sourcePort.kind}) cannot connect to ${targetPort.label} (${targetPort.kind}).`,
      });
      continue;
    }
    const key = connectionKey(edge);
    if (seenConnections.has(key)) {
      issues.push({
        code: "duplicate_connection",
        edgeId: edge.id,
        message: "This connection already exists.",
      });
      continue;
    }
    seenConnections.add(key);

    const targetKey = `${target.id}\u0000${targetPort.id}`;
    const nextCount = (incomingCount.get(targetKey) ?? 0) + 1;
    incomingCount.set(targetKey, nextCount);
    if (targetPort.maxConnections !== undefined && nextCount > targetPort.maxConnections) {
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

function cycleIssues(
  document: WorkflowDocumentV1,
  edges: readonly WorkflowEdgeV1[],
): WorkflowGraphIssue[] {
  const order = new Map(document.nodes.map((node, index) => [node.id, index]));
  const indegree = new Map(document.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(document.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }
  const ready: string[] = [];
  for (const node of document.nodes) {
    if (indegree.get(node.id) === 0) ready.push(node.id);
  }
  let visited = 0;
  while (ready.length > 0) {
    ready.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
    const current = ready.shift();
    if (!current) break;
    visited += 1;
    for (const target of outgoing.get(current) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  if (visited === document.nodes.length) return [];
  const issues: WorkflowGraphIssue[] = [];
  for (const node of document.nodes) {
    if ((indegree.get(node.id) ?? 0) > 0) {
      issues.push({
        code: "cycle" as const,
        nodeId: node.id,
        message: "Cycles are not supported in Create Images workflows.",
      });
    }
  }
  return issues;
}

export function validateWorkflowGraph(
  document: WorkflowDocumentV1,
  options: { forRun?: boolean } = {},
): WorkflowGraphIssue[] {
  const issues: WorkflowGraphIssue[] = [];
  const validEdges = structurallyValidEdges(document, issues);
  issues.push(...cycleIssues(document, validEdges));

  if (!options.forRun) return issues;

  const incoming = new Set(validEdges.map((edge) => `${edge.target}\u0000${edge.targetPort}`));
  for (const node of document.nodes) {
    const definition = CREATE_IMAGES_NODE_DEFINITIONS[node.type];
    for (const input of createImagesNodePorts(node, "inputs")) {
      if (input.required && !incoming.has(`${node.id}\u0000${input.id}`)) {
        issues.push({
          code: "missing_required_input",
          nodeId: node.id,
          portId: input.id,
          message: `${definition.title} requires ${input.label}.`,
        });
      }
    }
    if (node.type === "image-input" && !node.data.assetId) {
      issues.push({
        code: "missing_asset",
        nodeId: node.id,
        message: "Choose an image before running this node.",
      });
    } else if (node.type === "prompt" && node.data.text.trim().length === 0) {
      issues.push({
        code: "missing_prompt",
        nodeId: node.id,
        message: "Enter a prompt before running this node.",
      });
    } else if (node.type === "prompt-list") {
      const parsed = parseCreateImagesPromptList(node.data.source, node.data.format);
      if (parsed.status === "invalid") {
        issues.push({
          code: "missing_prompt",
          nodeId: node.id,
          message: parsed.message,
        });
      }
    } else if (node.type === "generate-image") {
      if (!node.data.providerId) {
        issues.push({
          code: "missing_provider",
          nodeId: node.id,
          message: "Choose a connected image provider.",
        });
      }
      if (!node.data.modelId) {
        issues.push({
          code: "missing_model",
          nodeId: node.id,
          message: "Choose a supported image model.",
        });
      }
    }
  }
  return issues;
}

export function topologicalWorkflowOrder(document: WorkflowDocumentV1): {
  order: string[];
  issues: WorkflowGraphIssue[];
} {
  const issues: WorkflowGraphIssue[] = [];
  const edges = structurallyValidEdges(document, issues);
  const cycles = cycleIssues(document, edges);
  issues.push(...cycles);
  if (issues.length > 0) return { order: [], issues };

  const index = new Map(document.nodes.map((node, nodeIndex) => [node.id, nodeIndex]));
  const indegree = new Map(document.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(document.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }
  const ready: string[] = [];
  for (const node of document.nodes) {
    if (indegree.get(node.id) === 0) ready.push(node.id);
  }
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort((left, right) => (index.get(left) ?? 0) - (index.get(right) ?? 0));
    const current = ready.shift();
    if (!current) break;
    order.push(current);
    for (const target of outgoing.get(current) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  return { order, issues };
}
