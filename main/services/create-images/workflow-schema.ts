// Strict v1 parser. Exact keys everywhere; anything else is rejected, never
// repaired. There is no migration code: v1 is the only schema that has shipped.
import { hasExactKeys, isRecord } from "../../shared/guards.js";
import {
  IMAGE_ASSET_ID_PATTERN,
  IMAGE_NODE_TYPES,
  IMAGE_WORKFLOW_ID_PATTERN,
  IMAGE_WORKFLOW_LIMITS as LIMITS,
  type ImageModelRef,
  type WorkflowDocV1,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeDimensions,
  type WorkflowPosition,
} from "../../../renderer/shared/images/schema.js";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

/** Titles and labels are single-line display text; prompts are not checked here. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
  }
  return false;
}
const PORT_ID = /^[a-z][a-z-]{0,31}$/u;

function finiteIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function label(value: unknown, maxLength: number, allowBlank = true): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    !hasControlCharacter(value) &&
    (allowBlank || value.trim().length > 0)
  );
}

function opaqueId(value: unknown): value is string {
  return typeof value === "string" && IMAGE_WORKFLOW_ID_PATTERN.test(value);
}

function position(value: unknown): WorkflowPosition | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["x", "y"])) return undefined;
  const limit = LIMITS.positionLimit;
  return finiteIn(value.x, -limit, limit) && finiteIn(value.y, -limit, limit)
    ? { x: value.x, y: value.y }
    : undefined;
}

function dimensions(value: unknown): WorkflowNodeDimensions | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["width", "height"])) return undefined;
  return finiteIn(value.width, LIMITS.minNodeSize, LIMITS.maxNodeSize) &&
    finiteIn(value.height, LIMITS.minNodeSize, LIMITS.maxNodeSize)
    ? { width: value.width, height: value.height }
    : undefined;
}

function modelRef(value: unknown): ImageModelRef | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["provider", "id"])) return undefined;
  return label(value.provider, LIMITS.maxProviderIdLength, false) &&
    label(value.id, LIMITS.maxModelIdLength, false)
    ? { provider: value.provider, id: value.id }
    : undefined;
}

function nodeData(type: WorkflowNode["type"], value: unknown): WorkflowNode["data"] | undefined {
  if (!isRecord(value)) return undefined;
  switch (type) {
    case "prompt":
      // Prompts are free text sent to the model; only their size is bounded.
      if (!hasExactKeys(value, ["text"]) || typeof value.text !== "string") return undefined;
      return Buffer.byteLength(value.text, "utf8") <= LIMITS.maxPromptBytes ? { text: value.text } : undefined;
    case "image-input": {
      if (!hasExactKeys(value, [], ["assetId", "label"])) return undefined;
      if (value.assetId !== undefined && !(typeof value.assetId === "string" && IMAGE_ASSET_ID_PATTERN.test(value.assetId))) return undefined;
      if (value.label !== undefined && !label(value.label, LIMITS.maxLabelLength)) return undefined;
      return {
        ...(value.assetId !== undefined ? { assetId: value.assetId as string } : {}),
        ...(value.label !== undefined ? { label: value.label as string } : {}),
      };
    }
    case "generate-image": {
      if (!hasExactKeys(value, ["count"], ["model"]) || value.count !== 1) return undefined;
      if (value.model === undefined) return { count: 1 };
      const model = modelRef(value.model);
      return model ? { model, count: 1 } : undefined;
    }
    case "output":
      if (!hasExactKeys(value, [], ["label"])) return undefined;
      if (value.label !== undefined && !label(value.label, LIMITS.maxLabelLength)) return undefined;
      return value.label !== undefined ? { label: value.label as string } : {};
  }
}

function node(value: unknown): WorkflowNode | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "type", "position", "data"], ["title", "dimensions"])) {
    return undefined;
  }
  if (!opaqueId(value.id) || !(IMAGE_NODE_TYPES as readonly unknown[]).includes(value.type)) return undefined;
  const type = value.type as WorkflowNode["type"];
  const at = position(value.position);
  const data = nodeData(type, value.data);
  if (!at || !data) return undefined;
  if (value.title !== undefined && !label(value.title, LIMITS.maxTitleLength)) return undefined;
  const size = value.dimensions === undefined ? undefined : dimensions(value.dimensions);
  if (value.dimensions !== undefined && !size) return undefined;
  return {
    id: value.id,
    type,
    position: at,
    ...(value.title !== undefined ? { title: value.title as string } : {}),
    ...(size ? { dimensions: size } : {}),
    data,
  } as WorkflowNode;
}

function edge(value: unknown): WorkflowEdge | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "source", "sourcePort", "target", "targetPort"])) return undefined;
  const ports = [value.sourcePort, value.targetPort];
  if (![value.id, value.source, value.target].every(opaqueId)) return undefined;
  if (!ports.every((port) => typeof port === "string" && PORT_ID.test(port))) return undefined;
  return {
    id: value.id as string,
    source: value.source as string,
    sourcePort: value.sourcePort as string,
    target: value.target as string,
    targetPort: value.targetPort as string,
  };
}

export function parseWorkflowDocV1(value: unknown): ParseResult<WorkflowDocV1> {
  const issues: string[] = [];
  const fail = (message: string): ParseResult<WorkflowDocV1> => ({ ok: false, issues: [...issues, message] });
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ["schemaVersion", "id", "title", "revision", "createdAt", "updatedAt", "nodes", "edges", "settings"],
      ["viewport"],
    )
  ) {
    return fail("The workflow has unexpected or missing fields.");
  }
  if (value.schemaVersion !== 1) return fail("Only schema version 1 is supported.");
  if (!opaqueId(value.id)) return fail("The workflow id is invalid.");
  if (!label(value.title, LIMITS.maxTitleLength, false)) return fail("The workflow title is invalid.");
  if (!integerIn(value.revision, 1, Number.MAX_SAFE_INTEGER)) return fail("The revision is invalid.");
  if (!integerIn(value.createdAt, 0, Number.MAX_SAFE_INTEGER) || !integerIn(value.updatedAt, 0, Number.MAX_SAFE_INTEGER)) {
    return fail("The timestamps are invalid.");
  }
  let viewport: WorkflowDocV1["viewport"];
  if (value.viewport !== undefined) {
    const raw = value.viewport;
    const limit = LIMITS.positionLimit;
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, ["x", "y", "zoom"]) ||
      !finiteIn(raw.x, -limit, limit) ||
      !finiteIn(raw.y, -limit, limit) ||
      !finiteIn(raw.zoom, LIMITS.minZoom, LIMITS.maxZoom)
    ) {
      return fail("The viewport is invalid.");
    }
    viewport = { x: raw.x, y: raw.y, zoom: raw.zoom };
  }
  const settings = value.settings;
  if (
    !isRecord(settings) ||
    !hasExactKeys(settings, ["concurrency"]) ||
    !integerIn(settings.concurrency, LIMITS.minConcurrency, LIMITS.maxConcurrency)
  ) {
    return fail(`Concurrency must be ${LIMITS.minConcurrency} to ${LIMITS.maxConcurrency}.`);
  }
  if (!Array.isArray(value.nodes) || value.nodes.length > LIMITS.maxNodes) {
    return fail(`Workflows are limited to ${LIMITS.maxNodes} nodes.`);
  }
  if (!Array.isArray(value.edges) || value.edges.length > LIMITS.maxEdges) {
    return fail(`Workflows are limited to ${LIMITS.maxEdges.toLocaleString("en-US")} connections.`);
  }
  const nodes = value.nodes.map(node);
  const edges = value.edges.map(edge);
  nodes.forEach((parsed, index) => {
    if (!parsed) issues.push(`Node ${index + 1} is invalid.`);
  });
  edges.forEach((parsed, index) => {
    if (!parsed) issues.push(`Connection ${index + 1} is invalid.`);
  });
  if (issues.length > 0) return { ok: false, issues };
  const ids = [...nodes, ...edges].map((item) => item!.id);
  if (new Set(ids).size !== ids.length) return fail("Node and connection ids must be unique.");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > LIMITS.maxDocumentBytes) {
    return fail("The workflow is larger than the 2 MiB limit.");
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      id: value.id,
      title: value.title,
      revision: value.revision,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      ...(viewport ? { viewport } : {}),
      nodes: nodes as WorkflowNode[],
      edges: edges as WorkflowEdge[],
      settings: { concurrency: settings.concurrency },
    },
  };
}
