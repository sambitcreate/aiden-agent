import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowDocV1 } from "../shared/images/schema";
import { deletionOp, interpretEdgeChanges, interpretNodeChanges, toFlowEdges, toFlowNodes } from "./flow-adapter-core";
import { createSession, sessionReducer, type EditorOp } from "./workflow-session-core";

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

test("deleting a node is one undo step that brings back the node and its connections", () => {
  const starter: WorkflowDocV1 = {
    ...doc,
    nodes: [
      { id: "p", type: "prompt", position: { x: 0, y: 0 }, data: { text: "x" } },
      { id: "g", type: "generate-image", position: { x: 1, y: 0 }, data: { count: 1 } },
      { id: "o", type: "output", position: { x: 2, y: 0 }, data: {} },
    ],
    edges: [
      { id: "e1", source: "p", sourcePort: "text", target: "g", targetPort: "prompt" },
      { id: "e2", source: "g", sourcePort: "images", target: "o", targetPort: "images" },
    ],
  };
  // React Flow's deleteElements order: edge changes, then node changes, then onDelete with both.
  const ops: EditorOp[] = [];
  const selected = interpretEdgeChanges([{ type: "remove", id: "e1" }, { type: "remove", id: "e2" }], new Set(["g"]));
  const nodes = interpretNodeChanges([{ type: "remove", id: "g" }], { dragging: new Map(), selected });
  ops.push(...nodes.ops);
  const deletion = deletionOp({ nodes: [{ id: "g" }], edges: [{ id: "e1" }, { id: "e2" }] });
  if (deletion) ops.push(deletion);

  let session = createSession(starter);
  for (const op of ops) session = sessionReducer(session, { type: "op", op });
  assert.deepEqual(session.history.present.nodes.map((node) => node.id), ["p", "o"]);
  assert.deepEqual(session.history.present.edges, []);
  assert.equal(session.history.past.length, 1);
  session = sessionReducer(session, { type: "undo" });
  assert.deepEqual(session.history.present, starter);
  assert.equal(nodes.selected.size, 0);
  assert.equal(deletionOp({ nodes: [], edges: [] }), null);
});

test("selection follows select changes on nodes and edges", () => {
  const nodes = interpretNodeChanges([{ type: "select", id: "p", selected: true }], { dragging: new Map(), selected: new Set(["i"]) });
  assert.deepEqual([...nodes.selected], ["i", "p"]);
  const edges = interpretEdgeChanges([{ type: "select", id: "x", selected: true }, { type: "select", id: "i", selected: false }], nodes.selected);
  assert.deepEqual([...edges], ["p", "x"]);
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
