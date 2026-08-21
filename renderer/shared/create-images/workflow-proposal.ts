import { parseCreateImagesPromptList } from "./prompt-list.js";
import { validateWorkflowGraph } from "./ports.js";
import { CREATE_IMAGES_GEMINI_RELEASE_CATALOG } from "./providers.js";
import {
  CREATE_IMAGES_SCHEMA_VERSION,
  parseWorkflowDocument,
  type WorkflowDocumentV1,
  type WorkflowNodeV1,
} from "./schema.js";

export const CREATE_IMAGES_WORKFLOW_PROPOSAL_VERSION = 1 as const;
export const CREATE_IMAGES_MAX_PROPOSAL_REQUEST_CHARS = 4_000;
export const CREATE_IMAGES_MAX_PROPOSAL_RESPONSE_BYTES = 256 * 1024;
export const CREATE_IMAGES_MAX_PROPOSAL_NODES = 50;
export const CREATE_IMAGES_MAX_PROPOSAL_EDGES = 200;

export interface CreateImagesWorkflowProposalDiff {
  nodesAdded: number;
  nodesRemoved: number;
  nodesChanged: number;
  edgesAdded: number;
  edgesRemoved: number;
  edgesChanged: number;
  maximumImageRequests: number;
  cost: { kind: "unknown" };
}

export interface CreateImagesWorkflowProposal {
  version: typeof CREATE_IMAGES_WORKFLOW_PROPOSAL_VERSION;
  workflow: WorkflowDocumentV1;
  diff: CreateImagesWorkflowProposalDiff;
}

export type CreateImagesWorkflowProposalParseResult =
  | { status: "ready"; proposal: CreateImagesWorkflowProposal }
  | { status: "invalid"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasUnsafeProposalText(value: unknown): boolean {
  if (typeof value === "string") {
    return (
      /(?:^|\s)(?:\/Users\/|\/home\/|file:\/\/|[A-Za-z]:\\)/u.test(value) ||
      /(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{12,})/u.test(value) ||
      /```|<script\b|#!\/|\b(?:curl|wget)\s+https?:\/\//iu.test(value)
    );
  }
  if (Array.isArray(value)) return value.some(hasUnsafeProposalText);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, candidate]) =>
      /(?:credential|api[_-]?key|secret|token|path|payload|providerResponse)/iu.test(key) ||
      hasUnsafeProposalText(candidate),
  );
}

function stableValue(value: unknown): string {
  return JSON.stringify(value);
}

function changedCount<T extends { id: string }>(current: readonly T[], next: readonly T[]): number {
  const before = new Map(current.map((item) => [item.id, stableValue(item)]));
  return next.filter((item) => before.has(item.id) && before.get(item.id) !== stableValue(item)).length;
}

function maximumImageRequests(document: WorkflowDocumentV1): number | undefined {
  let total = 0;
  for (const node of document.nodes) {
    if (node.type !== "generate-image") continue;
    const promptEdge = document.edges.find(
      (edge) => edge.target === node.id && edge.targetPort === "prompt",
    );
    const promptNode = promptEdge
      ? document.nodes.find((candidate) => candidate.id === promptEdge.source)
      : undefined;
    let prompts = 1;
    if (promptNode?.type === "prompt-list") {
      const parsed = parseCreateImagesPromptList(promptNode.data.source, promptNode.data.format);
      if (parsed.status !== "ready") return undefined;
      prompts = parsed.items.length;
    }
    const requests = prompts * node.data.count;
    if (requests > 8) return undefined;
    total += requests;
  }
  return total;
}

function proposalProviderConfigurationValid(nodes: readonly WorkflowNodeV1[]): boolean {
  for (const node of nodes) {
    if (node.type !== "generate-image") continue;
    if (node.data.providerId !== "gemini" || !node.data.modelId) return false;
    const model = CREATE_IMAGES_GEMINI_RELEASE_CATALOG.models.find(
      (candidate) => candidate.id === node.data.modelId,
    );
    if (
      !model ||
      !model.aspectRatios.includes(node.data.aspectRatio) ||
      !model.imageSizes.includes(node.data.imageSize) ||
      !model.outputMimes.includes(node.data.outputMime) ||
      node.data.count > model.maxOutputs
    ) {
      return false;
    }
  }
  return true;
}

export function normalizeCreateImagesWorkflowProposalRequest(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  return normalized.length > 0 && normalized.length <= CREATE_IMAGES_MAX_PROPOSAL_REQUEST_CHARS
    ? normalized
    : undefined;
}

export function parseCreateImagesWorkflowProposal(
  raw: string,
  current: WorkflowDocumentV1,
): CreateImagesWorkflowProposalParseResult {
  if (encodedBytes(raw) > CREATE_IMAGES_MAX_PROPOSAL_RESPONSE_BYTES || raw.trim() !== raw) {
    return { status: "invalid", message: "The proposal response was not bounded canonical JSON." };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { status: "invalid", message: "The selected model did not return strict proposal JSON." };
  }
  if (
    !isRecord(decoded) ||
    !exactKeys(decoded, ["version", "nodes", "edges"]) ||
    decoded.version !== CREATE_IMAGES_WORKFLOW_PROPOSAL_VERSION ||
    !Array.isArray(decoded.nodes) ||
    !Array.isArray(decoded.edges)
  ) {
    return { status: "invalid", message: "The proposal response does not match Aiden's graph contract." };
  }
  if (
    decoded.nodes.length > CREATE_IMAGES_MAX_PROPOSAL_NODES ||
    decoded.edges.length > CREATE_IMAGES_MAX_PROPOSAL_EDGES
  ) {
    return { status: "invalid", message: "The proposed graph exceeds the 50-node or 200-edge limit." };
  }
  if (hasUnsafeProposalText(decoded)) {
    return { status: "invalid", message: "The proposal contained unsafe paths, secrets, payloads, or code." };
  }
  for (const candidate of decoded.nodes) {
    if (!isRecord(candidate)) continue;
    if (candidate.type === "image-input") {
      if (!isRecord(candidate.data) || Object.keys(candidate.data).length !== 0) {
        return { status: "invalid", message: "Proposed Image Input nodes must remain empty placeholders." };
      }
    }
  }
  const parsed = parseWorkflowDocument({
    schemaVersion: CREATE_IMAGES_SCHEMA_VERSION,
    id: current.id,
    title: current.title,
    revision: current.revision + 1,
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
    nodes: decoded.nodes,
    edges: decoded.edges,
    assetRefs: [],
    settings: { ...current.settings },
  });
  if (!parsed.success) {
    return { status: "invalid", message: "The proposed graph failed Aiden's workflow schema." };
  }
  const graphIssues = validateWorkflowGraph(parsed.value, { forRun: true }).filter(
    (issue) => issue.code !== "missing_asset",
  );
  if (graphIssues.length > 0) {
    return { status: "invalid", message: graphIssues[0]!.message };
  }
  if (!proposalProviderConfigurationValid(parsed.value.nodes)) {
    return { status: "invalid", message: "The proposal uses an unsupported image-model configuration." };
  }
  const maximumRequests = maximumImageRequests(parsed.value);
  if (maximumRequests === undefined) {
    return { status: "invalid", message: "A proposed batch exceeds the eight-request confirmation limit." };
  }
  const currentNodeIds = new Set(current.nodes.map((node) => node.id));
  const nextNodeIds = new Set(parsed.value.nodes.map((node) => node.id));
  const currentEdgeIds = new Set(current.edges.map((edge) => edge.id));
  const nextEdgeIds = new Set(parsed.value.edges.map((edge) => edge.id));
  return {
    status: "ready",
    proposal: {
      version: CREATE_IMAGES_WORKFLOW_PROPOSAL_VERSION,
      workflow: parsed.value,
      diff: {
        nodesAdded: parsed.value.nodes.filter((node) => !currentNodeIds.has(node.id)).length,
        nodesRemoved: current.nodes.filter((node) => !nextNodeIds.has(node.id)).length,
        nodesChanged: changedCount(current.nodes, parsed.value.nodes),
        edgesAdded: parsed.value.edges.filter((edge) => !currentEdgeIds.has(edge.id)).length,
        edgesRemoved: current.edges.filter((edge) => !nextEdgeIds.has(edge.id)).length,
        edgesChanged: changedCount(current.edges, parsed.value.edges),
        maximumImageRequests: maximumRequests,
        cost: { kind: "unknown" },
      },
    },
  };
}

