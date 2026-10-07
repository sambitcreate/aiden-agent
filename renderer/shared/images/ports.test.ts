import assert from "node:assert/strict";
import test from "node:test";
import { isImagePortCompatible, topologicalWorkflowOrder, validateWorkflowGraph } from "./ports.js";
import type { WorkflowDocV1, WorkflowEdge, WorkflowNode } from "./schema.js";

const prompt = (id: string, text = "A red bicycle"): WorkflowNode => ({ id, type: "prompt", position: { x: 0, y: 0 }, data: { text } });
const generate = (id: string, model = true): WorkflowNode => ({
  id, type: "generate-image", position: { x: 0, y: 0 },
  data: { count: 1, ...(model ? { model: { provider: "openrouter", id: "google/gemini-3.1-flash-image" } } : {}) },
});
const input = (id: string, assetId?: string): WorkflowNode => ({ id, type: "image-input", position: { x: 0, y: 0 }, data: assetId ? { assetId } : {} });
const output = (id: string): WorkflowNode => ({ id, type: "output", position: { x: 0, y: 0 }, data: {} });
const edge = (id: string, source: string, sourcePort: string, target: string, targetPort: string): WorkflowEdge =>
  ({ id, source, sourcePort, target, targetPort });
function doc(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowDocV1 {
  return { schemaVersion: 1, id: "wf", title: "Test", revision: 1, createdAt: 0, updatedAt: 0, nodes, edges, settings: { concurrency: 2 } };
}
const ASSET = "a".repeat(64);

test("typed ports accept an image into references and reject text there", () => {
  assert.equal(isImagePortCompatible("image", "images"), true);
  assert.equal(isImagePortCompatible("images", "images"), true);
  assert.equal(isImagePortCompatible("text", "images"), false);
  assert.equal(isImagePortCompatible("images", "image"), false);
  const issues = validateWorkflowGraph(
    doc([prompt("p"), generate("g")], [edge("e1", "p", "text", "g", "references")]),
  );
  assert.deepEqual(issues.map((issue) => issue.code), ["incompatible_port"]);
});

test("direction, unknown ports, duplicates and self loops are reported per edge", () => {
  const issues = validateWorkflowGraph(
    doc(
      [prompt("p"), generate("g"), output("o")],
      [
        edge("reverse", "g", "prompt", "o", "images"),
        edge("unknown", "p", "nope", "g", "prompt"),
        edge("ok", "p", "text", "g", "prompt"),
        edge("dup", "p", "text", "g", "prompt"),
        edge("self", "g", "images", "g", "references"),
      ],
    ),
  );
  assert.deepEqual(
    issues.map((issue) => [issue.edgeId, issue.code]),
    [["reverse", "invalid_direction"], ["unknown", "unknown_port"], ["dup", "duplicate_connection"], ["self", "self_loop"]],
  );
});

test("connection limits: one prompt, at most four references", () => {
  const nodes = [prompt("p1"), prompt("p2"), generate("g"), ...[1, 2, 3, 4, 5].map((n) => input(`i${n}`, ASSET))];
  const edges = [
    edge("p1", "p1", "text", "g", "prompt"),
    edge("p2", "p2", "text", "g", "prompt"),
    ...[1, 2, 3, 4, 5].map((n) => edge(`r${n}`, `i${n}`, "image", "g", "references")),
  ];
  const issues = validateWorkflowGraph(doc(nodes, edges));
  assert.deepEqual(issues.map((issue) => [issue.edgeId, issue.code]), [["p2", "connection_limit"], ["r5", "connection_limit"]]);
});

test("cycles are rejected and the order follows document order among ready nodes", () => {
  const cyclic = doc(
    [generate("a"), generate("b"), prompt("p")],
    [edge("e1", "a", "images", "b", "references"), edge("e2", "b", "images", "a", "references")],
  );
  assert.ok(validateWorkflowGraph(cyclic).some((issue) => issue.code === "cycle"));
  assert.deepEqual(topologicalWorkflowOrder(cyclic).order, []);

  const chain = doc(
    [output("o"), generate("g"), prompt("p2"), prompt("p1")],
    [edge("e1", "p1", "text", "g", "prompt"), edge("e2", "g", "images", "o", "images")],
  );
  assert.deepEqual(topologicalWorkflowOrder(chain).order, ["p2", "p1", "g", "o"]);
});

test("run validation reports missing inputs, prompt, asset and model only for the requested nodes", () => {
  const workflow = doc(
    [prompt("empty", "  "), generate("g", false), input("i"), output("o"), prompt("elsewhere", "")],
    [edge("e1", "empty", "text", "g", "prompt"), edge("e2", "i", "image", "g", "references")],
  );
  const all = validateWorkflowGraph(workflow, { forRun: true });
  assert.deepEqual(
    all.map((issue) => [issue.nodeId, issue.code]).sort(),
    [["elsewhere", "missing_prompt"], ["empty", "missing_prompt"], ["g", "missing_model"], ["i", "missing_asset"], ["o", "missing_required_input"]],
  );
  const scoped = validateWorkflowGraph(workflow, { forRun: true, nodeIds: new Set(["g", "empty"]) });
  assert.deepEqual(scoped.map((issue) => issue.nodeId).sort(), ["empty", "g"]);
  assert.deepEqual(validateWorkflowGraph(workflow), []);
});
