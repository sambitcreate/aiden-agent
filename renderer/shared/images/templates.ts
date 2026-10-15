import {
  IMAGE_WORKFLOW_LIMITS,
  IMAGE_WORKFLOW_SCHEMA_VERSION,
  type ImageModelRef,
  type WorkflowDocV1,
} from "./schema.js";

export type ImageWorkflowTemplate = "blank" | "starter";

/** Blank and Starter only in CI-1; the template explorer arrives in CI-3. */
export function workflowFromTemplate(input: {
  template: ImageWorkflowTemplate;
  workflowId: string;
  now: number;
  nextId(): string;
  title?: string;
  model?: ImageModelRef;
}): WorkflowDocV1 {
  const base: WorkflowDocV1 = {
    schemaVersion: IMAGE_WORKFLOW_SCHEMA_VERSION,
    id: input.workflowId,
    title: input.title ?? (input.template === "starter" ? "Prompt to image" : "Untitled image workflow"),
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    settings: { concurrency: IMAGE_WORKFLOW_LIMITS.defaultConcurrency },
  };
  if (input.template === "blank") return base;

  const promptId = input.nextId();
  const generateId = input.nextId();
  const outputId = input.nextId();
  base.nodes = [
    { id: promptId, type: "prompt", position: { x: 80, y: 160 }, data: { text: "" } },
    {
      id: generateId,
      type: "generate-image",
      position: { x: 420, y: 140 },
      data: input.model ? { model: { ...input.model }, count: 1 } : { count: 1 },
    },
    { id: outputId, type: "output", position: { x: 780, y: 140 }, data: {} },
  ];
  base.edges = [
    { id: input.nextId(), source: promptId, sourcePort: "text", target: generateId, targetPort: "prompt" },
    { id: input.nextId(), source: generateId, sourcePort: "images", target: outputId, targetPort: "images" },
  ];
  return base;
}
