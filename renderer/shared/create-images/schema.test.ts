import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATE_IMAGES_MAX_ZOOM,
  CREATE_IMAGES_MAX_NODES,
  CREATE_IMAGES_MIN_ZOOM,
  createStarterWorkflow,
  parseWorkflowDocument,
  type WorkflowDocumentV1,
} from "./schema.js";
import { topologicalWorkflowOrder, validateWorkflowGraph } from "./ports.js";

function starter(): WorkflowDocumentV1 {
  return createStarterWorkflow({
    workflowId: "workflow-1",
    promptNodeId: "prompt-1",
    generationNodeId: "generate-1",
    outputNodeId: "output-1",
    promptEdgeId: "edge-prompt",
    outputEdgeId: "edge-output",
    now: "2026-08-11T12:00:00.000Z",
  });
}

test("starter workflow is structurally valid and deterministic", () => {
  const workflow = starter();
  const parsed = parseWorkflowDocument(JSON.parse(JSON.stringify(workflow)));
  assert.deepEqual(parsed, { success: true, value: workflow });
  assert.deepEqual(topologicalWorkflowOrder(workflow), {
    order: ["prompt-1", "generate-1", "output-1"],
    issues: [],
  });
});

test("schema rejects unknown credential fields and inline image data", () => {
  const workflow = starter();
  const generation = workflow.nodes.find((node) => node.type === "generate-image");
  assert.ok(generation);
  const withSecret = structuredClone(workflow) as unknown as {
    nodes: Array<{ type: string; data: Record<string, unknown> }>;
  };
  const generationRecord = withSecret.nodes.find((node) => node.type === "generate-image");
  assert.ok(generationRecord);
  generationRecord.data.apiKey = "must-not-cross-the-boundary";
  const secretResult = parseWorkflowDocument(withSecret);
  assert.equal(secretResult.success, false);
  if (!secretResult.success) {
    assert.ok(secretResult.issues.some((issue) => issue.path.endsWith(".apiKey")));
  }

  const withInlineImage = structuredClone(workflow);
  withInlineImage.nodes.unshift({
    id: "input-1",
    type: "image-input",
    position: { x: 0, y: 0 },
    data: { assetId: "data:image/png;base64,AAAA" },
  });
  assert.equal(parseWorkflowDocument(withInlineImage).success, false);
});

test("schema fails closed on future versions, unknown fields, and duplicate IDs", () => {
  const workflow = starter() as unknown as Record<string, unknown>;
  workflow.schemaVersion = 2;
  workflow.credentials = { apiKey: "secret" };
  const nodes = workflow.nodes as Array<Record<string, unknown>>;
  nodes.push(structuredClone(nodes[0]));
  const result = parseWorkflowDocument(workflow);
  assert.equal(result.success, false);
  if (result.success) return;
  assert.ok(result.issues.some((issue) => issue.path === "$.schemaVersion"));
  assert.ok(result.issues.some((issue) => issue.path === "$.credentials"));
  assert.ok(result.issues.some((issue) => issue.code === "duplicate"));
});

test("graph validation reports broken ports without repairing them", () => {
  const workflow = starter();
  workflow.edges.push({
    id: "edge-cycle",
    source: "output-1",
    sourcePort: "images",
    target: "prompt-1",
    targetPort: "text",
  });
  const invalidDirection = validateWorkflowGraph(workflow);
  assert.ok(invalidDirection.some((issue) => issue.code === "invalid_direction"));

  workflow.edges.pop();
  workflow.edges.push(
    {
      id: "edge-cycle-a",
      source: "prompt-1",
      sourcePort: "text",
      target: "generate-1",
      targetPort: "prompt",
    },
    {
      id: "edge-invalid-reverse",
      source: "generate-1",
      sourcePort: "images",
      target: "output-1",
      targetPort: "images",
    },
  );
  assert.ok(validateWorkflowGraph(workflow).some((issue) => issue.code === "duplicate_connection"));
});

test("graph validation detects a cycle made from otherwise compatible ports", () => {
  const workflow = starter();
  const generation = workflow.nodes.find((node) => node.type === "generate-image");
  assert.ok(generation);
  workflow.nodes.push(
    {
      id: "prompt-2",
      type: "prompt",
      position: { x: 0, y: 0 },
      data: { text: "second" },
    },
    {
      ...structuredClone(generation),
      id: "generate-2",
      position: { x: 320, y: 320 },
    },
  );
  workflow.edges.push(
    {
      id: "edge-prompt-2",
      source: "prompt-2",
      sourcePort: "text",
      target: "generate-2",
      targetPort: "prompt",
    },
    {
      id: "edge-cycle-a",
      source: "generate-1",
      sourcePort: "images",
      target: "generate-2",
      targetPort: "references",
    },
    {
      id: "edge-cycle-b",
      source: "generate-2",
      sourcePort: "images",
      target: "generate-1",
      targetPort: "references",
    },
  );

  const issues = validateWorkflowGraph(workflow);
  assert.ok(issues.some((issue) => issue.code === "cycle" && issue.nodeId === "generate-1"));
  assert.ok(issues.some((issue) => issue.code === "cycle" && issue.nodeId === "generate-2"));
  assert.deepEqual(topologicalWorkflowOrder(workflow).order, []);
});

test("schema rejects oversized collections without walking their entries", () => {
  const workflow = starter() as unknown as Record<string, unknown>;
  const trap = Object.defineProperty({}, "id", {
    get() {
      throw new Error("oversized collection entries must not be inspected");
    },
  });
  workflow.nodes = Array.from({ length: CREATE_IMAGES_MAX_NODES + 1 }, () => trap);

  const result = parseWorkflowDocument(workflow);
  assert.equal(result.success, false);
  if (result.success) return;
  assert.ok(result.issues.some((issue) => issue.path === "$.nodes" && issue.code === "too_large"));
});

test("schema rejects sparse workflow arrays", () => {
  const workflow = starter() as unknown as Record<string, unknown>;
  workflow.nodes = new Array(1);
  workflow.edges = new Array(1);
  workflow.assetRefs = new Array(1);
  const result = parseWorkflowDocument(workflow);
  assert.equal(result.success, false);
  if (result.success) return;
  assert.ok(result.issues.some((issue) => issue.path === "$.nodes[0]"));
  assert.ok(result.issues.some((issue) => issue.path === "$.edges[0]"));
  assert.ok(result.issues.some((issue) => issue.path === "$.assetRefs[0]"));
});

test("schema requires node-held assets in the workflow asset manifest", () => {
  const workflow = starter();
  const assetId = "a".repeat(64);
  workflow.nodes.push({
    id: "input-1",
    type: "image-input",
    position: { x: 0, y: 0 },
    data: { assetId },
  });
  const missing = parseWorkflowDocument(workflow);
  assert.equal(missing.success, false);
  if (!missing.success) {
    assert.ok(missing.issues.some((issue) => issue.path.endsWith(".data.assetId")));
  }
  workflow.assetRefs.push(assetId);
  assert.equal(parseWorkflowDocument(workflow).success, true);
});

test("schema requires lowercase SHA-256 asset identifiers", () => {
  for (const assetId of ["asset-1", "A".repeat(64), "a".repeat(63), "a".repeat(65)]) {
    const workflow = starter();
    workflow.nodes.push({
      id: "input-1",
      type: "image-input",
      position: { x: 0, y: 0 },
      data: { assetId },
    });
    workflow.assetRefs.push(assetId);

    const result = parseWorkflowDocument(workflow);
    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(result.issues.some((issue) => issue.path.endsWith(".data.assetId")));
      assert.ok(result.issues.some((issue) => issue.path === "$.assetRefs[0]"));
    }
  }
});

test("schema requires exact node asset references and shared viewport bounds", () => {
  const unusedAsset = starter();
  unusedAsset.assetRefs = ["b".repeat(64)];
  const unusedResult = parseWorkflowDocument(unusedAsset);
  assert.equal(unusedResult.success, false);
  if (!unusedResult.success) {
    assert.ok(unusedResult.issues.some((issue) => issue.path === "$.assetRefs[0]"));
  }

  const reversed = starter();
  const assetA = "a".repeat(64);
  const assetB = "b".repeat(64);
  reversed.nodes.push(
    { id: "image-a", type: "image-input", position: { x: 0, y: 0 }, data: { assetId: assetA } },
    { id: "image-b", type: "image-input", position: { x: 0, y: 100 }, data: { assetId: assetB } },
  );
  reversed.assetRefs = [assetB, assetA];
  const reversedResult = parseWorkflowDocument(reversed);
  assert.equal(reversedResult.success, false);
  if (!reversedResult.success) {
    assert.ok(reversedResult.issues.some((issue) => issue.path === "$.assetRefs"));
  }

  for (const zoom of [CREATE_IMAGES_MIN_ZOOM, CREATE_IMAGES_MAX_ZOOM]) {
    const workflow = starter();
    workflow.viewport = { x: 0, y: 0, zoom };
    assert.equal(parseWorkflowDocument(workflow).success, true);
  }
  for (const zoom of [CREATE_IMAGES_MIN_ZOOM - 0.01, CREATE_IMAGES_MAX_ZOOM + 0.01]) {
    const workflow = starter();
    workflow.viewport = { x: 0, y: 0, zoom };
    assert.equal(parseWorkflowDocument(workflow).success, false);
  }
});

test("run validation distinguishes incomplete drafts from structurally invalid graphs", () => {
  const workflow = starter();
  assert.deepEqual(validateWorkflowGraph(workflow), []);
  const runIssues = validateWorkflowGraph(workflow, { forRun: true });
  assert.ok(runIssues.some((issue) => issue.code === "missing_prompt"));
  assert.ok(runIssues.some((issue) => issue.code === "missing_provider"));
  assert.ok(runIssues.some((issue) => issue.code === "missing_model"));
});
