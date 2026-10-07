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
    ["duplicate edge id", (doc) => (doc.edges[1].id = doc.edges[0].id)],
    ["edge id that collides with a node id", (doc) => (doc.edges[0].id = doc.nodes[0].id)],
    ["edge id with a path separator", (doc) => (doc.edges[0].id = "../edge")],
    ["empty edge id", (doc) => (doc.edges[0].id = "")],
    ["edge port with uppercase letters", (doc) => (doc.edges[0].sourcePort = "Image")],
    ["edge port with a path separator", (doc) => (doc.edges[0].targetPort = "a/b")],
    ["edge port over 32 characters", (doc) => (doc.edges[0].targetPort = "a".repeat(33))],
    ["non-string edge port", (doc) => (doc.edges[0].sourcePort = 3)],
    ["node width below the minimum", (doc) => (doc.nodes[0].dimensions = { width: 119, height: 200 })],
    ["node height above the maximum", (doc) => (doc.nodes[0].dimensions = { width: 200, height: 1_601 })],
    ["non-finite node width", (doc) => (doc.nodes[0].dimensions = { width: Number.NaN, height: 200 })],
    ["node dimensions with an extra key", (doc) => (doc.nodes[0].dimensions = { width: 200, height: 200, depth: 1 })],
    ["viewport zoom below the minimum", (doc) => (doc.viewport = { x: 0, y: 0, zoom: 0.05 })],
    ["viewport zoom above the maximum", (doc) => (doc.viewport = { x: 0, y: 0, zoom: 4.5 })],
    ["viewport position out of range", (doc) => (doc.viewport = { x: 1_000_001, y: 0, zoom: 1 })],
    ["viewport missing zoom", (doc) => (doc.viewport = { x: 0, y: 0 })],
    ["viewport with an extra key", (doc) => (doc.viewport = { x: 0, y: 0, zoom: 1, rotation: 90 })],
    ["viewport that is not an object", (doc) => (doc.viewport = "1,1,1")],
    ["control character in the workflow title", (doc) => (doc.title = "Bike\u0007s")],
    ["NUL in the workflow title", (doc) => (doc.title = "A\u0000B")],
    ["control character in a node title", (doc) => (doc.nodes[0].title = "Line\u001b[31m")],
    ["control character in an Image Input label", (doc) => doc.nodes.push({ id: "in", type: "image-input", position: { x: 0, y: 0 }, data: { label: "a\u007fb" } })],
    ["control character in an Output label", (doc) => (doc.nodes[2].data.label = "x\u0001")],
    ["title over 120 characters", (doc) => (doc.title = "t".repeat(121))],
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

test("the parser caps connections at 2,000", () => {
  const doc = starter() as any;
  const edge = (index: number) => ({ id: `e${index}`, source: doc.nodes[0].id, sourcePort: "text", target: doc.nodes[1].id, targetPort: "prompt" });
  doc.edges = Array.from({ length: 2_000 }, (_, index) => edge(index));
  assert.equal(parseWorkflowDocV1(doc).ok, true, "2,000 connections is the allowed maximum");
  doc.edges.push(edge(2_000));
  const result = parseWorkflowDocV1(doc);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.issues.join(" "), /2,000 connections/u);
});

test("the parser rejects input that is not a document object", () => {
  for (const [label, input] of [
    ["null", null],
    ["undefined", undefined],
    ["a number", 7],
    ["a string", JSON.stringify(starter())],
    ["an array", [starter()]],
    ["an empty object", {}],
  ] as const) {
    assert.equal(parseWorkflowDocV1(input).ok, false, label);
  }
});
