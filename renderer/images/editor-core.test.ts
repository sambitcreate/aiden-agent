import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowDocV1, WorkflowNode } from "../shared/images/schema";
import {
  boundedCanvasPosition,
  boundedPromptText,
  commitEditorHistory,
  createEditorHistory,
  decideCanvasConnection,
  decideCanvasMutationCapacity,
  redoEditorHistory,
  undoEditorHistory,
} from "./editor-core";
import { fitNodeToMediaAspect } from "./node-dimensions-core";

const node = (id: string, type: WorkflowNode["type"]): WorkflowNode =>
  ({ id, type, position: { x: 0, y: 0 }, data: type === "prompt" ? { text: "x" } : type === "generate-image" ? { count: 1 } : {} }) as WorkflowNode;
const doc = (nodes: WorkflowNode[], edges: WorkflowDocV1["edges"] = []): WorkflowDocV1 =>
  ({ schemaVersion: 1, id: "wf", title: "T", revision: 1, createdAt: 0, updatedAt: 0, nodes, edges, settings: { concurrency: 2 } });

test("connections follow typed ports and refuse duplicates, limits and cycles", () => {
  const base = doc([node("p", "prompt"), node("g1", "generate-image"), node("g2", "generate-image"), node("o", "output")]);
  const ok = decideCanvasConnection(base, { source: "p", sourcePort: "text", target: "g1", targetPort: "prompt" }, "e1");
  assert.deepEqual(ok, { allowed: true, edge: { id: "e1", source: "p", sourcePort: "text", target: "g1", targetPort: "prompt" } });
  const withPrompt = doc(base.nodes, [ok.allowed ? ok.edge : assert.fail("expected an edge")]);
  assert.equal(decideCanvasConnection(withPrompt, { source: "p", sourcePort: "text", target: "g1", targetPort: "prompt" }, "e2").allowed, false);
  assert.equal(decideCanvasConnection(base, { source: "p", sourcePort: "text", target: "g1", targetPort: "references" }, "e3").allowed, false);
  assert.equal(decideCanvasConnection(base, { source: "o", sourcePort: "images", target: "g1", targetPort: "references" }, "e4").allowed, false);
  const chained = doc(base.nodes, [{ id: "c1", source: "g1", sourcePort: "images", target: "g2", targetPort: "references" }]);
  const cycle = decideCanvasConnection(chained, { source: "g2", sourcePort: "images", target: "g1", targetPort: "references" }, "c2");
  assert.equal(cycle.allowed, false);
  assert.match(cycle.allowed ? "" : cycle.message, /Cycles/u);
});

test("history is bounded and a new edit clears redo", () => {
  let history = createEditorHistory(0);
  for (let value = 1; value <= 60; value += 1) history = commitEditorHistory(history, value);
  assert.equal(history.past.length, 50);
  history = undoEditorHistory(undoEditorHistory(history));
  assert.equal(history.present, 58);
  assert.deepEqual(redoEditorHistory(history).present, 59);
  history = commitEditorHistory(history, 100);
  assert.deepEqual(history.future, []);
  assert.equal(undoEditorHistory(createEditorHistory("x")).present, "x");
});

test("capacity, prompt and position bounds keep edits inside the schema", () => {
  assert.equal(decideCanvasMutationCapacity(500, 0, 1, 0).allowed, false);
  assert.equal(decideCanvasMutationCapacity(10, 2_000, 0, 1).allowed, false);
  assert.equal(decideCanvasMutationCapacity(499, 1_999, 1, 1).allowed, true);
  const emoji = "🙂".repeat(5_000); // 4 bytes each: 20,000 bytes
  const bounded = boundedPromptText(emoji);
  assert.equal(new TextEncoder().encode(bounded).byteLength, 16 * 1024);
  assert.equal(bounded, "🙂".repeat(4_096)); // never splits a surrogate pair
  assert.deepEqual(boundedCanvasPosition({ x: Number.NaN, y: 2_000_000 }), { x: 0, y: 1_000_000 });
});

test("media fitting keeps the aspect inside node bounds and rejects bad metadata", () => {
  assert.deepEqual(fitNodeToMediaAspect({ width: 320, height: 200 }, 1024, 512), { width: 320, height: 160 });
  // A 1:100 portrait clamps the height to the maximum and the width to the minimum.
  assert.deepEqual(fitNodeToMediaAspect(undefined, 100, 10_000), { width: 180, height: 1_600 });
  assert.equal(fitNodeToMediaAspect(undefined, 0, 10), undefined);
  assert.equal(fitNodeToMediaAspect(undefined, Number.NaN, 10), undefined);
});
