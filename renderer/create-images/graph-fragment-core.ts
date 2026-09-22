import { validateWorkflowGraph } from "../shared/create-images/ports.js";
import {
  CREATE_IMAGES_MAX_EDGES,
  CREATE_IMAGES_MAX_NODES,
  CREATE_IMAGES_SCHEMA_VERSION,
  parseWorkflowDocument,
  type CreateImagesPosition,
  type WorkflowDocumentV1,
  type WorkflowEdgeV1,
  type WorkflowNodeV1,
} from "../shared/create-images/schema.js";
import { boundedCanvasPosition } from "./editor-core.js";

export const CREATE_IMAGES_GRAPH_FRAGMENT_MIME = "application/x-aiden-create-images-graph-fragment";
export const CREATE_IMAGES_GRAPH_FRAGMENT_KIND = "aiden.create-images.graph-fragment";
export const CREATE_IMAGES_GRAPH_FRAGMENT_VERSION = 1 as const;
export const CREATE_IMAGES_MAX_GRAPH_FRAGMENT_BYTES = 2 * 1024 * 1024;

export interface CreateImagesGraphFragmentV1 {
  kind: typeof CREATE_IMAGES_GRAPH_FRAGMENT_KIND;
  version: typeof CREATE_IMAGES_GRAPH_FRAGMENT_VERSION;
  nodes: WorkflowNodeV1[];
  edges: WorkflowEdgeV1[];
  assetRefs: string[];
}

export type CreateImagesGraphFragmentParseResult =
  | { status: "valid"; fragment: CreateImagesGraphFragmentV1 }
  | { status: "invalid"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function validationDocument(value: Record<string, unknown>): unknown {
  return {
    schemaVersion: CREATE_IMAGES_SCHEMA_VERSION,
    id: "clipboard-fragment",
    title: "Clipboard fragment",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: value.nodes,
    edges: value.edges,
    assetRefs: value.assetRefs,
    settings: { concurrency: 1 },
  };
}

export function createCreateImagesGraphFragment(
  document: WorkflowDocumentV1,
  selectedNodeIds: ReadonlySet<string>,
): CreateImagesGraphFragmentV1 | undefined {
  if (selectedNodeIds.size === 0 || selectedNodeIds.size > CREATE_IMAGES_MAX_NODES) return undefined;
  const nodes = document.nodes
    .filter((node) => selectedNodeIds.has(node.id))
    .map((node) => {
      const copy = structuredClone(node);
      return copy.type === "group"
        ? {
            ...copy,
            data: {
              ...copy.data,
              memberNodeIds: copy.data.memberNodeIds.filter((id) => selectedNodeIds.has(id)),
            },
          }
        : copy;
    });
  if (nodes.length === 0) return undefined;
  const copiedIds = new Set(nodes.map((node) => node.id));
  const edges = document.edges
    .filter((edge) => copiedIds.has(edge.source) && copiedIds.has(edge.target))
    .map((edge) => structuredClone(edge));
  if (edges.length > CREATE_IMAGES_MAX_EDGES) return undefined;
  const assetRefs: string[] = [];
  const seenAssets = new Set<string>();
  for (const node of nodes) {
    const assetId = node.type === "image-input" ? node.data.assetId : undefined;
    if (assetId && !seenAssets.has(assetId)) {
      seenAssets.add(assetId);
      assetRefs.push(assetId);
    }
  }
  return {
    kind: CREATE_IMAGES_GRAPH_FRAGMENT_KIND,
    version: CREATE_IMAGES_GRAPH_FRAGMENT_VERSION,
    nodes,
    edges,
    assetRefs,
  };
}

export function serializeCreateImagesGraphFragment(
  fragment: CreateImagesGraphFragmentV1,
): string | undefined {
  const serialized = JSON.stringify(fragment);
  return new TextEncoder().encode(serialized).byteLength <= CREATE_IMAGES_MAX_GRAPH_FRAGMENT_BYTES
    ? serialized
    : undefined;
}

export function parseCreateImagesGraphFragment(
  serialized: string,
): CreateImagesGraphFragmentParseResult {
  if (
    serialized.length === 0 ||
    new TextEncoder().encode(serialized).byteLength > CREATE_IMAGES_MAX_GRAPH_FRAGMENT_BYTES
  ) {
    return { status: "invalid", message: "The copied graph fragment is empty or too large." };
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return { status: "invalid", message: "The copied graph fragment is not valid JSON." };
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, ["kind", "version", "nodes", "edges", "assetRefs"]) ||
    value.kind !== CREATE_IMAGES_GRAPH_FRAGMENT_KIND ||
    value.version !== CREATE_IMAGES_GRAPH_FRAGMENT_VERSION
  ) {
    return { status: "invalid", message: "The copied graph fragment has an unsupported format." };
  }
  const parsed = parseWorkflowDocument(validationDocument(value));
  if (!parsed.success || parsed.value.nodes.length === 0) {
    return { status: "invalid", message: "The copied graph fragment failed schema validation." };
  }
  if (validateWorkflowGraph(parsed.value).length > 0) {
    return { status: "invalid", message: "The copied graph fragment contains invalid connections." };
  }
  return {
    status: "valid",
    fragment: {
      kind: CREATE_IMAGES_GRAPH_FRAGMENT_KIND,
      version: CREATE_IMAGES_GRAPH_FRAGMENT_VERSION,
      nodes: parsed.value.nodes,
      edges: parsed.value.edges,
      assetRefs: parsed.value.assetRefs,
    },
  };
}

export function instantiateCreateImagesGraphFragment(
  fragment: CreateImagesGraphFragmentV1,
  input: { anchor: CreateImagesPosition; uniqueToken: string; startSequence?: number },
): { nodes: WorkflowNodeV1[]; edges: WorkflowEdgeV1[]; assetRefs: string[]; nextSequence: number } {
  const left = Math.min(...fragment.nodes.map((node) => node.position.x));
  const top = Math.min(...fragment.nodes.map((node) => node.position.y));
  const token = input.uniqueToken.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 40) || "fragment";
  let sequence = Math.max(0, Math.floor(input.startSequence ?? 0));
  const idMap = new Map<string, string>();
  const nodes = fragment.nodes.map((node) => {
    sequence += 1;
    const id = `${node.type}-paste-${token}-${sequence}`.slice(0, 128);
    idMap.set(node.id, id);
    return {
      ...structuredClone(node),
      id,
      position: boundedCanvasPosition({
        x: input.anchor.x + node.position.x - left,
        y: input.anchor.y + node.position.y - top,
      }),
    } as WorkflowNodeV1;
  });
  for (const node of nodes) {
    if (node.type !== "group") continue;
    node.data.memberNodeIds = node.data.memberNodeIds.flatMap((id) => {
      const mapped = idMap.get(id);
      return mapped ? [mapped] : [];
    });
  }
  const edges = fragment.edges.map((edge) => {
    sequence += 1;
    return {
      ...structuredClone(edge),
      id: `edge-paste-${token}-${sequence}`.slice(0, 128),
      source: idMap.get(edge.source)!,
      target: idMap.get(edge.target)!,
    };
  });
  return { nodes, edges, assetRefs: [...fragment.assetRefs], nextSequence: sequence };
}
