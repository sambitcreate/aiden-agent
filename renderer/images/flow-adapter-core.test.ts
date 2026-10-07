import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowDocV1 } from "../shared/images/schema";
import { interpretEdgeChanges, interpretNodeChanges, toFlowEdges, toFlowNodes } from "./flow-adapter-core";

const doc: WorkflowDocV1 = {
  schemaVersion: 1, id: "wf", title: "T", revision: 1, createdAt: 0, updatedAt: 0, settings: { concurrency: 2 },
  nodes: [
    { id: "p", type: "prompt", position: { x: 1, y: 2 }, data: { text: "x" } },
    { id: "i", type: "image-input", position: { x: 3, y: 4 }, dimensions: { width: 320, height: 160 }, data: {} },
  ],
  edges: [{ id: "e", source: "i", sourcePort: "image", target: "p", targetPort: "never" }],
};

test("document nodes and edges become flow elements carrying their ports and sizes", () => {
  const nodes = toFlowNodes(doc, new Map([["p", { x: 50, y: 60 }]]), new Set(["i"]));
  assert.deepEqual(nodes.map((node) => [node.id, node.type, node.position, node.selected, node.width, node.height]), [
    ["p", "prompt", { x: 50, y: 60 }, false, undefined, undefined],
    ["i", "image-input", { x: 3, y: 4 }, true, 320, 160],
  ]);
  assert.equal(nodes[0]?.data.node, doc.nodes[0]);
  assert.deepEqual(toFlowEdges(doc, new Set()).map((edge) => [edge.sourceHandle, edge.targetHandle]), [["image", "never"]]);
});

test("a drag moves only the overlay and commits one move when it ends", () => {
  const dragging = interpretNodeChanges(
    [{ type: "position", id: "p", dragging: true, position: { x: 10, y: 10 } }],
    { dragging: new Map(), selected: new Set() },
  );
  assert.deepEqual(dragging.ops, []);
  assert.deepEqual([...dragging.dragging], [["p", { x: 10, y: 10 }]]);
  const dropped = interpretNodeChanges([{ type: "position", id: "p", dragging: false }], { dragging: dragging.dragging, selected: new Set() });
  assert.deepEqual(dropped.ops, [{ type: "move-nodes", positions: [{ id: "p", position: { x: 10, y: 10 } }] }]);
  assert.equal(dropped.dragging.size, 0);
});

test("removals become one remove op and selection follows select changes", () => {
  const nodes = interpretNodeChanges(
    [{ type: "select", id: "p", selected: true }, { type: "remove", id: "i" }],
    { dragging: new Map(), selected: new Set(["i"]) },
  );
  assert.deepEqual(nodes.ops, [{ type: "remove", nodeIds: ["i"], edgeIds: [] }]);
  assert.deepEqual([...nodes.selected], ["p"]);
  const edges = interpretEdgeChanges([{ type: "remove", id: "e" }, { type: "select", id: "x", selected: true }], new Set());
  assert.deepEqual(edges.ops, [{ type: "remove", nodeIds: [], edgeIds: ["e"] }]);
  assert.deepEqual([...edges.selected], ["x"]);
});

test("rendered sizes reported by React Flow are handed back so nodes stay visible", () => {
  const measured = interpretNodeChanges(
    [{ type: "dimensions", id: "p", dimensions: { width: 280, height: 92 } }],
    { dragging: new Map(), selected: new Set() },
  );
  assert.deepEqual(measured.ops, []);
  const nodes = toFlowNodes(doc, new Map(), new Set(), measured.measured);
  assert.deepEqual(nodes.find((node) => node.id === "p")?.measured, { width: 280, height: 92 });
  assert.equal(nodes.find((node) => node.id === "i")?.measured, undefined);
});
