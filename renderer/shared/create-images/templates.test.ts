import assert from "node:assert/strict";
import test from "node:test";
import { validateWorkflowGraph } from "./ports.js";
import { parseWorkflowDocument } from "./schema.js";
import {
  CREATE_IMAGES_WORKFLOW_TEMPLATES,
  createImagesWorkflowFromTemplate,
  type CreateImagesWorkflowTemplateId,
} from "./templates.js";

function create(template: CreateImagesWorkflowTemplateId) {
  let sequence = 0;
  return createImagesWorkflowFromTemplate({
    template,
    workflowId: `workflow-${template}`,
    now: "2026-08-19T12:00:00.000Z",
    nextId: () => `id-${++sequence}`,
  });
}

test("all shipped Create Images templates are valid, deterministic, and runnable in shape", () => {
  assert.deepEqual(
    CREATE_IMAGES_WORKFLOW_TEMPLATES.map((template) => template.id),
    ["starter", "reference-edit", "variant-set"],
  );
  for (const template of ["blank", ...CREATE_IMAGES_WORKFLOW_TEMPLATES.map(({ id }) => id)] as const) {
    const first = create(template);
    const second = create(template);
    assert.deepEqual(first, second);
    assert.equal(parseWorkflowDocument(first).success, true);
    assert.equal(first.revision, 1);
    assert.deepEqual(first.assetRefs, []);
    if (template !== "blank") {
      const setupIssues = new Set([
        "missing_prompt",
        "missing_asset",
        "missing_provider",
        "missing_model",
      ]);
      assert.deepEqual(
        validateWorkflowGraph(first).filter((issue) => !setupIssues.has(issue.code)),
        [],
      );
    }
  }
  const reference = create("reference-edit");
  assert.ok(reference.nodes.some((node) => node.type === "image-input"));
  assert.ok(reference.edges.some((edge) => edge.targetPort === "references"));
  const variants = create("variant-set");
  assert.equal(
    variants.nodes.find((node) => node.type === "generate-image")?.data.count,
    4,
  );
  assert.ok(variants.nodes.some((node) => node.type === "output-gallery"));
});
