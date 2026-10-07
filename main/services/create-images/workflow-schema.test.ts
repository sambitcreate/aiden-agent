import assert from "node:assert/strict";
import test from "node:test";
import { workflowFromTemplate } from "../../../renderer/shared/images/templates.js";
import type { WorkflowDocV1 } from "../../../renderer/shared/images/schema.js";
import { parseWorkflowDocV1 } from "./workflow-schema.js";

function starter(): WorkflowDocV1 {
  let next = 0;
  return workflowFromTemplate({
    template: "starter",
    workflowId: "wf-1",
    now: 1_000,
    nextId: () => `id-${(next += 1)}`,
    model: { provider: "openrouter", id: "google/gemini-3.1-flash-image" },
  });
}

test("both templates produce documents the strict parser accepts unchanged", () => {
  const blank = workflowFromTemplate({ template: "blank", workflowId: "wf-0", now: 5, nextId: () => "x" });
  assert.deepEqual(parseWorkflowDocV1(blank), { ok: true, value: blank });
  const doc = starter();
  assert.deepEqual(parseWorkflowDocV1(doc), { ok: true, value: doc });
  assert.deepEqual(doc.nodes.map((node) => node.type), ["prompt", "generate-image", "output"]);
  assert.deepEqual(doc.settings, { concurrency: 2 });
  assert.equal(doc.revision, 1);
});

test("a starter without an available model leaves the Generate node unset", () => {
  const doc = workflowFromTemplate({ template: "starter", workflowId: "wf-2", now: 1, nextId: () => crypto.randomUUID() });
  const generate = doc.nodes.find((node) => node.type === "generate-image");
  assert.deepEqual(generate?.data, { count: 1 });
});

test("the parser rejects legacy fields, unknown keys and out-of-range values", () => {
  const mutations: Array<[string, (doc: any) => void]> = [
    ["schema version 5", (doc) => (doc.schemaVersion = 5)],
    ["unknown top-level key", (doc) => (doc.assetRefs = [])],
    ["legacy aspect ratio", (doc) => (doc.nodes[1].data.aspectRatio = "1:1")],
    ["legacy provider id", (doc) => (doc.nodes[1].data.providerId = "gemini")],
    ["count above the CI-1 cap", (doc) => (doc.nodes[1].data.count = 2)],
    ["concurrency 5", (doc) => (doc.settings.concurrency = 5)],
    ["concurrency 0", (doc) => (doc.settings.concurrency = 0)],
    ["non-finite position", (doc) => (doc.nodes[0].position.x = Number.POSITIVE_INFINITY)],
    ["prompt over 16 KiB", (doc) => (doc.nodes[0].data.text = "é".repeat(8 * 1024 + 1))],
    ["non-hex asset id", (doc) => doc.nodes.push({ id: "in", type: "image-input", position: { x: 0, y: 0 }, data: { assetId: "../x" } })],
    ["duplicate node id", (doc) => doc.nodes.push({ ...doc.nodes[0] })],
    ["unknown node type", (doc) => (doc.nodes[2].type = "output-gallery")],
    ["node comment", (doc) => (doc.nodes[0].comment = { text: "hi" })],
    ["edge breakpoint", (doc) => (doc.edges[0].breakpoint = true)],
    ["negative revision", (doc) => (doc.revision = 0)],
    ["empty title", (doc) => (doc.title = "   ")],
    ["model with extra key", (doc) => (doc.nodes[1].data.model.label = "x")],
  ];
  for (const [label, mutate] of mutations) {
    const doc = structuredClone(starter()) as any;
    mutate(doc);
    const result = parseWorkflowDocV1(doc);
    assert.equal(result.ok, false, label);
  }
});

test("the parser enforces node, edge and document size caps", () => {
  const doc = starter() as any;
  doc.nodes = Array.from({ length: 501 }, (_, index) => ({ id: `p${index}`, type: "prompt", position: { x: 0, y: 0 }, data: { text: "" } }));
  doc.edges = [];
  assert.equal(parseWorkflowDocV1(doc).ok, false);
  // 200 nodes × 15 KiB prompts exceeds the 2 MiB document cap while each prompt is legal.
  doc.nodes = Array.from({ length: 200 }, (_, index) => ({ id: `p${index}`, type: "prompt", position: { x: 0, y: 0 }, data: { text: "x".repeat(15 * 1024) } }));
  const result = parseWorkflowDocV1(doc);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.issues.join(" "), /2 MiB/u);
});
