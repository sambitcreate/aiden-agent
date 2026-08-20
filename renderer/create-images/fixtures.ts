import {
  createStarterWorkflow,
  type WorkflowDocumentV1,
  type WorkflowEdgeV1,
  type WorkflowNodeV1,
} from "../shared/create-images/schema";
export { CREATE_IMAGES_FIXTURES } from "./fixture-summaries";

const FIXTURE_NOW = "2026-08-11T16:00:00.000Z";
const REFERENCE_FIXTURE_ASSET_ID = "f".repeat(64);

function stressAssetId(index: number): string {
  return (index + 1).toString(16).padStart(64, "0");
}

function starterFixture(): WorkflowDocumentV1 {
  const document = createStarterWorkflow({
    workflowId: "starter",
    promptNodeId: "starter-prompt",
    generationNodeId: "starter-generate",
    outputNodeId: "starter-output",
    promptEdgeId: "starter-edge-prompt",
    outputEdgeId: "starter-edge-output",
    now: FIXTURE_NOW,
  });
  document.title = "Editorial portrait study";
  const prompt = document.nodes.find((node) => node.type === "prompt");
  if (prompt?.type === "prompt") {
    prompt.data.text = "A quiet editorial portrait in soft window light, warm neutral palette";
  }
  const generation = document.nodes.find((node) => node.type === "generate-image");
  if (generation?.type === "generate-image") {
    generation.data.providerId = "gemini";
    generation.data.modelId = "gemini-3.1-flash-image";
  }
  return document;
}

function referenceFixture(): WorkflowDocumentV1 {
  return {
    schemaVersion: 1,
    id: "reference-edit",
    title: "Reference-led campaign",
    revision: 1,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: "reference-input",
        type: "image-input",
        position: { x: 60, y: 120 },
        data: { assetId: REFERENCE_FIXTURE_ASSET_ID, label: "Reference image" },
      },
      {
        id: "reference-prompt",
        type: "prompt",
        position: { x: 60, y: 360 },
        data: { text: "Preserve the composition; shift the scene to a misty blue hour" },
      },
      {
        id: "reference-generate",
        type: "generate-image",
        position: { x: 410, y: 220 },
        data: {
          providerId: "gemini",
          modelId: "gemini-3.1-flash-image",
          aspectRatio: "4:5",
          imageSize: "2K",
          outputMime: "image/png",
          count: 1,
        },
      },
      {
        id: "reference-gallery",
        type: "output-gallery",
        position: { x: 780, y: 220 },
        data: { label: "Campaign selects" },
      },
    ],
    edges: [
      {
        id: "reference-edge-image",
        source: "reference-input",
        sourcePort: "image",
        target: "reference-generate",
        targetPort: "references",
      },
      {
        id: "reference-edge-prompt",
        source: "reference-prompt",
        sourcePort: "text",
        target: "reference-generate",
        targetPort: "prompt",
      },
      {
        id: "reference-edge-output",
        source: "reference-generate",
        sourcePort: "images",
        target: "reference-gallery",
        targetPort: "images",
      },
    ],
    assetRefs: [REFERENCE_FIXTURE_ASSET_ID],
    settings: { concurrency: 1, defaultProviderId: "gemini" },
  };
}

function stressFixture(nodeCount: 100 | 250): WorkflowDocumentV1 {
  const nodes: WorkflowNodeV1[] = [];
  const edges: WorkflowEdgeV1[] = [];
  const assetRefs: string[] = [];
  const groups = Math.ceil(nodeCount / 4);
  for (let index = 0; index < groups; index += 1) {
    // Keep stress rows clear at the production gate's 0.7 zoom even when the
    // capability-driven Generate Image card renders every curated control.
    const row = index * 1_120;
    const promptId = `stress-prompt-${index}`;
    const inputId = `stress-input-${index}`;
    const generationId = `stress-generate-${index}`;
    const outputId = `stress-output-${index}`;
    const assetId = stressAssetId(index);
    nodes.push(
      {
        id: promptId,
        type: "prompt",
        position: { x: 40, y: row + 20 },
        data: { text: `Concept ${index + 1}: sculptural still life` },
      },
      {
        id: inputId,
        type: "image-input",
        position: { x: 390, y: row + 20 },
        data: { assetId, label: `Reference ${index + 1}` },
      },
      {
        id: generationId,
        type: "generate-image",
        position: { x: 740, y: row + 20 },
        data: {
          providerId: "gemini",
          modelId: "gemini-3.1-flash-image",
          aspectRatio: "1:1",
          imageSize: "1K",
          outputMime: "image/png",
          count: 1,
        },
      },
      {
        id: outputId,
        type: index % 5 === 0 ? "output-gallery" : "output",
        position: { x: 1_090, y: row + 20 },
        data: index % 5 === 0 ? { label: `Gallery ${index + 1}` } : {},
      },
    );
    assetRefs.push(assetId);
    edges.push(
      {
        id: `stress-edge-prompt-${index}`,
        source: promptId,
        sourcePort: "text",
        target: generationId,
        targetPort: "prompt",
      },
      {
        id: `stress-edge-image-${index}`,
        source: inputId,
        sourcePort: "image",
        target: generationId,
        targetPort: "references",
      },
      {
        id: `stress-edge-output-${index}`,
        source: generationId,
        sourcePort: "images",
        target: outputId,
        targetPort: "images",
      },
    );
  }
  const keptNodes = nodes.slice(0, nodeCount);
  const keptNodeIds = new Set(keptNodes.map((node) => node.id));
  return {
    schemaVersion: 1,
    id: `stress-${nodeCount}`,
    title: `${nodeCount}-node canvas fixture`,
    revision: 1,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    viewport: { x: 0, y: 0, zoom: 0.7 },
    nodes: keptNodes,
    edges: edges.filter((edge) => keptNodeIds.has(edge.source) && keptNodeIds.has(edge.target)),
    assetRefs: assetRefs.filter((_assetId, index) => index * 4 + 1 < nodeCount),
    settings: { concurrency: 1, defaultProviderId: "gemini" },
  };
}

const FIXTURES: ReadonlyMap<string, () => WorkflowDocumentV1> = new Map<
  string,
  () => WorkflowDocumentV1
>([
  [
    "blank",
    () => ({
      schemaVersion: 1,
      id: "blank",
      title: "Untitled image workflow",
      revision: 1,
      createdAt: FIXTURE_NOW,
      updatedAt: FIXTURE_NOW,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
      assetRefs: [],
      settings: { concurrency: 1 },
    }),
  ],
  ["starter", starterFixture],
  ["reference-edit", referenceFixture],
  ["stress-100", () => stressFixture(100)],
  ["stress-250", () => stressFixture(250)],
]);

export function createImagesFixture(workflowId: string): WorkflowDocumentV1 | undefined {
  if (workflowId.length === 0 || workflowId.length > 128) return undefined;
  return FIXTURES.get(workflowId)?.();
}
