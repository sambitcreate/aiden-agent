import {
  CREATE_IMAGES_MAX_EDGES,
  CREATE_IMAGES_MAX_NODES,
  CREATE_IMAGES_MAX_PROMPT_LENGTH,
  CREATE_IMAGES_POSITION_LIMIT,
  CREATE_IMAGES_SCHEMA_VERSION,
  parseWorkflowDocument,
  type CreateImagesAspectRatio,
  type CreateImagesImageSize,
  type WorkflowDocumentV1,
  type WorkflowEdgeV1,
  type WorkflowNodeV1,
} from "./schema.js";

const SOURCE_ID_MAX_LENGTH = 512;
const LABEL_MAX_LENGTH = 120;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;
const DATA_IMAGE_PATTERN = /^data:(image\/[A-Za-z0-9.+-]{1,64});base64,([A-Za-z0-9+/]*={0,2})$/u;
const ASPECT_RATIOS: ReadonlySet<string> = new Set([
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
]);
const IMAGE_SIZES: ReadonlySet<string> = new Set(["1K", "2K", "4K"]);

export interface CreateImagesNodeBananaInlineImage {
  sourceNodeIndex: number;
  targetNodeId: string;
  mediaType: string;
  base64: string;
  displayName: string;
}

export interface CreateImagesNodeBananaImportEntry {
  sourceNodeIndex: number;
  sourceType: string;
  action: "rewritten" | "skipped";
  message: string;
}

export interface CreateImagesNodeBananaImportReport {
  sourceNodeCount: number;
  importedNodeCount: number;
  skippedNodeCount: number;
  importedEdgeCount: number;
  skippedEdgeCount: number;
  embeddedImageCount: number;
  importedEmbeddedImageCount: number;
  skippedEmbeddedImageCount: number;
  entries: CreateImagesNodeBananaImportEntry[];
  securityNote: string;
}

export interface CreateImagesNodeBananaConversion {
  workflow: WorkflowDocumentV1;
  inlineImages: CreateImagesNodeBananaInlineImage[];
  report: CreateImagesNodeBananaImportReport;
}

export class CreateImagesNodeBananaImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreateImagesNodeBananaImportError";
  }
}

interface SourceNode {
  id: string;
  type: string;
  data: Record<string, unknown>;
  position: { x: number; y: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceType(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(value) ? value : "unknown";
}

function sourceNode(value: unknown): SourceNode | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > SOURCE_ID_MAX_LENGTH
  ) {
    return undefined;
  }
  const type = sourceType(value.type);
  const rawPosition = isRecord(value.position) ? value.position : {};
  const coordinate = (candidate: unknown): number =>
    typeof candidate === "number" && Number.isFinite(candidate)
      ? Math.max(-CREATE_IMAGES_POSITION_LIMIT, Math.min(CREATE_IMAGES_POSITION_LIMIT, candidate))
      : 0;
  return {
    id: value.id,
    type,
    data: isRecord(value.data) ? value.data : {},
    position: { x: coordinate(rawPosition.x), y: coordinate(rawPosition.y) },
  };
}

function label(data: Record<string, unknown>, fallback: string): string {
  for (const candidate of [data.customTitle, data.label, data.filename]) {
    if (typeof candidate === "string") {
      const normalized = candidate.normalize("NFKC").replace(/\s+/gu, " ").trim();
      if (normalized) return normalized.slice(0, LABEL_MAX_LENGTH);
    }
  }
  return fallback;
}

function title(value: unknown): string {
  if (typeof value !== "string") return "Imported Node Banana workflow";
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, LABEL_MAX_LENGTH) : "Imported Node Banana workflow";
}

function validDataImage(value: unknown): { mediaType: string; base64: string } | undefined {
  if (typeof value !== "string") return undefined;
  const match = DATA_IMAGE_PATTERN.exec(value);
  if (!match || match[2]!.length < 4 || match[2]!.length % 4 !== 0) return undefined;
  if (match[1]!.toLowerCase() === "image/svg+xml") return undefined;
  return { mediaType: match[1]!.toLowerCase(), base64: match[2]! };
}

function importedModel(data: Record<string, unknown>): { providerId?: "gemini"; modelId?: string } {
  const selected = isRecord(data.selectedModel) ? data.selectedModel : undefined;
  const selectedModelId = selected?.modelId;
  if (
    selected?.provider === "gemini" &&
    typeof selectedModelId === "string" &&
    MODEL_ID_PATTERN.test(selectedModelId)
  ) {
    return { providerId: "gemini", modelId: selectedModelId };
  }
  if (typeof data.model === "string" && MODEL_ID_PATTERN.test(data.model)) {
    return { providerId: "gemini", modelId: data.model };
  }
  return {};
}

function sourcePort(type: string): string | undefined {
  if (type === "prompt") return "text";
  if (type === "imageInput") return "image";
  if (type === "nanoBanana") return "images";
  return undefined;
}

function targetPort(
  source: string,
  target: string,
  sourceHandle: unknown,
  targetHandle: unknown,
): string | undefined {
  if (target === "nanoBanana") {
    if (
      source === "prompt" ||
      (typeof targetHandle === "string" && targetHandle.startsWith("text")) ||
      sourceHandle === "text"
    ) {
      return "prompt";
    }
    if (
      source === "imageInput" ||
      source === "nanoBanana" ||
      (typeof targetHandle === "string" && targetHandle.startsWith("image"))
    ) {
      return "references";
    }
  }
  if (
    (target === "output" || target === "outputGallery") &&
    (source === "imageInput" || source === "nanoBanana")
  ) {
    return "images";
  }
  return undefined;
}

function createsCycle(edges: readonly WorkflowEdgeV1[], source: string, target: string): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }
  const pending = [target];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === source) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(outgoing.get(current) ?? []));
  }
  return false;
}

function connectionLimit(targetType: string, port: string): number {
  if (targetType === "nanoBanana") return port === "prompt" ? 1 : 14;
  if (targetType === "output") return 1;
  if (targetType === "outputGallery") return 64;
  return 0;
}

export function convertNodeBananaWorkflow(
  value: unknown,
  input: { workflowId: string; now: string; nextId(): string },
): CreateImagesNodeBananaConversion {
  if (!isRecord(value) || value.version !== 1) {
    throw new CreateImagesNodeBananaImportError(
      "Only Node Banana workflow version 1 is supported.",
    );
  }
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new CreateImagesNodeBananaImportError("The Node Banana workflow graph is missing.");
  }
  if (
    value.nodes.length > CREATE_IMAGES_MAX_NODES ||
    value.edges.length > CREATE_IMAGES_MAX_EDGES
  ) {
    throw new CreateImagesNodeBananaImportError(
      "The Node Banana workflow exceeds Aiden's graph limits.",
    );
  }

  const nodes: WorkflowNodeV1[] = [];
  const inlineImages: CreateImagesNodeBananaInlineImage[] = [];
  const entries: CreateImagesNodeBananaImportEntry[] = [];
  const sourceById = new Map<string, { node: SourceNode; targetId: string }>();
  let skippedNodeCount = 0;

  for (let index = 0; index < value.nodes.length; index += 1) {
    const parsed = sourceNode(value.nodes[index]);
    const type =
      parsed?.type ??
      sourceType(isRecord(value.nodes[index]) ? value.nodes[index].type : undefined);
    if (!parsed || sourceById.has(parsed.id)) {
      skippedNodeCount += 1;
      entries.push({
        sourceNodeIndex: index,
        sourceType: type,
        action: "skipped",
        message: parsed ? "Duplicate source node ID." : "Invalid source node shape or ID.",
      });
      continue;
    }
    const targetId = input.nextId();
    let targetNode: WorkflowNodeV1 | undefined;
    let message = "";
    if (parsed.type === "imageInput") {
      const image = validDataImage(parsed.data.image);
      const displayName = label(parsed.data, `Imported image ${index + 1}`);
      targetNode = {
        id: targetId,
        type: "image-input",
        position: parsed.position,
        data: { label: displayName },
      };
      if (image) {
        inlineImages.push({
          sourceNodeIndex: index,
          targetNodeId: targetId,
          mediaType: image.mediaType,
          base64: image.base64,
          displayName,
        });
        message = "Mapped to Image Input; embedded bytes will be validated and externalized.";
      } else if (parsed.data.image !== null && parsed.data.image !== undefined) {
        message =
          "Mapped to Image Input, but its non-portable or unsupported image was not imported.";
      } else if (parsed.data.imageRef !== undefined) {
        message = "Mapped to Image Input without its device-specific image reference.";
      } else {
        message = "Mapped to an empty Image Input.";
      }
    } else if (parsed.type === "prompt") {
      const text = typeof parsed.data.prompt === "string" ? parsed.data.prompt : "";
      targetNode = {
        id: targetId,
        type: "prompt",
        position: parsed.position,
        data: { text: text.slice(0, CREATE_IMAGES_MAX_PROMPT_LENGTH) },
      };
      message =
        text.length > CREATE_IMAGES_MAX_PROMPT_LENGTH
          ? "Mapped to Prompt and truncated to Aiden's prompt limit."
          : "Mapped to Prompt.";
    } else if (parsed.type === "nanoBanana") {
      const model = importedModel(parsed.data);
      const aspectRatio =
        typeof parsed.data.aspectRatio === "string" && ASPECT_RATIOS.has(parsed.data.aspectRatio)
          ? (parsed.data.aspectRatio as CreateImagesAspectRatio)
          : "1:1";
      const imageSize =
        typeof parsed.data.resolution === "string" && IMAGE_SIZES.has(parsed.data.resolution)
          ? (parsed.data.resolution as CreateImagesImageSize)
          : "1K";
      targetNode = {
        id: targetId,
        type: "generate-image",
        position: parsed.position,
        data: {
          ...model,
          aspectRatio,
          imageSize,
          outputMime: "image/png",
          count: 1,
        },
      };
      message = model.modelId
        ? "Mapped to Generate Image; runtime state, outputs, search, fallback, parameters, and credentials were removed."
        : "Mapped to Generate Image without an unverified provider model; choose a current Aiden model before running.";
    } else if (parsed.type === "output" || parsed.type === "outputGallery") {
      targetNode = {
        id: targetId,
        type: parsed.type === "output" ? "output" : "output-gallery",
        position: parsed.position,
        data: { label: label(parsed.data, parsed.type === "output" ? "Output" : "Output gallery") },
      };
      message = `Mapped to ${parsed.type === "output" ? "Output" : "Output Gallery"}; cached media was removed.`;
    }
    if (!targetNode) {
      skippedNodeCount += 1;
      entries.push({
        sourceNodeIndex: index,
        sourceType: parsed.type,
        action: "skipped",
        message: "This Node Banana node type is not supported by the Create Images MVP.",
      });
      continue;
    }
    nodes.push(targetNode);
    sourceById.set(parsed.id, { node: parsed, targetId });
    entries.push({
      sourceNodeIndex: index,
      sourceType: parsed.type,
      action: "rewritten",
      message,
    });
  }

  const edges: WorkflowEdgeV1[] = [];
  const connections = new Set<string>();
  const incoming = new Map<string, number>();
  let skippedEdgeCount = 0;
  for (const rawEdge of value.edges) {
    if (
      !isRecord(rawEdge) ||
      typeof rawEdge.source !== "string" ||
      typeof rawEdge.target !== "string"
    ) {
      skippedEdgeCount += 1;
      continue;
    }
    const source = sourceById.get(rawEdge.source);
    const target = sourceById.get(rawEdge.target);
    if (!source || !target) {
      skippedEdgeCount += 1;
      continue;
    }
    const mappedSourcePort = sourcePort(source.node.type);
    const mappedTargetPort = targetPort(
      source.node.type,
      target.node.type,
      rawEdge.sourceHandle,
      rawEdge.targetHandle,
    );
    if (!mappedSourcePort || !mappedTargetPort) {
      skippedEdgeCount += 1;
      continue;
    }
    const connection = `${source.targetId}\u0000${mappedSourcePort}\u0000${target.targetId}\u0000${mappedTargetPort}`;
    const incomingKey = `${target.targetId}\u0000${mappedTargetPort}`;
    const nextIncoming = (incoming.get(incomingKey) ?? 0) + 1;
    if (
      connections.has(connection) ||
      nextIncoming > connectionLimit(target.node.type, mappedTargetPort) ||
      createsCycle(edges, source.targetId, target.targetId)
    ) {
      skippedEdgeCount += 1;
      continue;
    }
    connections.add(connection);
    incoming.set(incomingKey, nextIncoming);
    edges.push({
      id: input.nextId(),
      source: source.targetId,
      sourcePort: mappedSourcePort,
      target: target.targetId,
      targetPort: mappedTargetPort,
    });
  }

  const workflow: WorkflowDocumentV1 = {
    schemaVersion: CREATE_IMAGES_SCHEMA_VERSION,
    id: input.workflowId,
    title: title(value.name),
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes,
    edges,
    assetRefs: [],
    settings: { concurrency: 1 },
  };
  const parsedWorkflow = parseWorkflowDocument(workflow);
  if (!parsedWorkflow.success) {
    throw new CreateImagesNodeBananaImportError(
      "The converted workflow did not pass Aiden's schema.",
    );
  }
  return {
    workflow: parsedWorkflow.value,
    inlineImages,
    report: {
      sourceNodeCount: value.nodes.length,
      importedNodeCount: nodes.length,
      skippedNodeCount,
      importedEdgeCount: edges.length,
      skippedEdgeCount,
      embeddedImageCount: inlineImages.length,
      importedEmbeddedImageCount: 0,
      skippedEmbeddedImageCount: 0,
      entries,
      securityNote:
        "Provider credentials, provider settings, absolute paths, external media references, cached outputs, and runtime state were never imported.",
    },
  };
}
