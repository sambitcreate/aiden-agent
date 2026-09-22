import {
  CREATE_IMAGES_SCHEMA_VERSION,
  createStarterWorkflow,
  parseWorkflowDocument,
  type WorkflowDocumentV1,
} from "./schema.js";

export type CreateImagesWorkflowTemplateId =
  | "blank"
  | "starter"
  | "reference-edit"
  | "variant-set";

export const CREATE_IMAGES_WORKFLOW_TEMPLATES = Object.freeze([
  {
    id: "starter" as const,
    title: "Prompt to image",
    description: "A prompt, one Gemini generation node, and a durable output.",
    category: "Essentials" as const,
    tags: ["prompt", "generate", "output"] as const,
    preview: "linear" as const,
  },
  {
    id: "reference-edit" as const,
    title: "Reference edit",
    description: "Combine an imported reference image with a transformation prompt.",
    category: "Editing" as const,
    tags: ["reference", "image", "edit"] as const,
    preview: "reference" as const,
  },
  {
    id: "variant-set" as const,
    title: "Variant set",
    description: "Generate four variants into a durable output gallery.",
    category: "Exploration" as const,
    tags: ["variants", "gallery", "batch"] as const,
    preview: "gallery" as const,
  },
] as const);

export function filterCreateImagesWorkflowTemplates(input: {
  search?: string;
  category?: string;
}) {
  const search = input.search?.trim().toLocaleLowerCase() ?? "";
  return CREATE_IMAGES_WORKFLOW_TEMPLATES.filter((template) => {
    if (input.category && input.category !== "All" && template.category !== input.category) {
      return false;
    }
    if (!search) return true;
    return [template.title, template.description, template.category, ...template.tags]
      .join(" ")
      .toLocaleLowerCase()
      .includes(search);
  });
}

export function createImagesWorkflowFromTemplate(input: {
  template: CreateImagesWorkflowTemplateId;
  workflowId: string;
  now: string;
  nextId(): string;
  title?: string;
}): WorkflowDocumentV1 {
  if (input.template === "blank") {
    const blank: WorkflowDocumentV1 = {
      schemaVersion: CREATE_IMAGES_SCHEMA_VERSION,
      id: input.workflowId,
      title: input.title ?? "Untitled image workflow",
      revision: 1,
      createdAt: input.now,
      updatedAt: input.now,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
      assetRefs: [],
      settings: { concurrency: 1 },
    };
    const parsed = parseWorkflowDocument(blank);
    if (!parsed.success) throw new Error("The blank workflow template is invalid.");
    return parsed.value;
  }

  const workflow = createStarterWorkflow({
    workflowId: input.workflowId,
    promptNodeId: input.nextId(),
    generationNodeId: input.nextId(),
    outputNodeId: input.nextId(),
    promptEdgeId: input.nextId(),
    outputEdgeId: input.nextId(),
    now: input.now,
  });
  if (input.template === "reference-edit") {
    const imageNodeId = input.nextId();
    const generationNode = workflow.nodes.find((node) => node.type === "generate-image")!;
    workflow.nodes.unshift({
      id: imageNodeId,
      type: "image-input",
      position: { x: 80, y: 430 },
      data: { label: "Reference image" },
    });
    workflow.edges.push({
      id: input.nextId(),
      source: imageNodeId,
      sourcePort: "image",
      target: generationNode.id,
      targetPort: "references",
    });
    workflow.title = input.title ?? "Reference edit workflow";
  } else if (input.template === "variant-set") {
    const generationNode = workflow.nodes.find((node) => node.type === "generate-image")!;
    const outputNode = workflow.nodes.find((node) => node.type === "output")!;
    generationNode.data.count = 4;
    const outputGallery: WorkflowDocumentV1["nodes"][number] = {
      id: outputNode.id,
      type: "output-gallery",
      position: outputNode.position,
      data: outputNode.data,
    };
    workflow.nodes = workflow.nodes.map((node) =>
      node.id === outputNode.id ? outputGallery : node,
    );
    workflow.title = input.title ?? "Image variant workflow";
  } else if (input.title) {
    workflow.title = input.title;
  }
  const parsed = parseWorkflowDocument(workflow);
  if (!parsed.success) throw new Error("The built-in workflow template is invalid.");
  return parsed.value;
}
