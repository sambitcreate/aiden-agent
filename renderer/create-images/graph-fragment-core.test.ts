import assert from "node:assert/strict";
import test from "node:test";
import { createStarterWorkflow } from "../shared/create-images/schema.js";
import {
  CREATE_IMAGES_GRAPH_FRAGMENT_KIND,
  CREATE_IMAGES_GRAPH_FRAGMENT_VERSION,
  createCreateImagesGraphFragment,
  instantiateCreateImagesGraphFragment,
  parseCreateImagesGraphFragment,
  serializeCreateImagesGraphFragment,
} from "./graph-fragment-core.js";

const workflow = () =>
  createStarterWorkflow({
    workflowId: "workflow-1",
    promptNodeId: "prompt-1",
    generationNodeId: "generate-1",
    outputNodeId: "output-1",
    promptEdgeId: "edge-1",
    outputEdgeId: "edge-2",
    now: "2026-08-21T12:00:00.000Z",
  });

test("graph fragments contain only selected graph data and opaque asset references", () => {
  const fragment = createCreateImagesGraphFragment(
    workflow(),
    new Set(["prompt-1", "generate-1"]),
  );
  assert.ok(fragment);
  assert.equal(fragment.kind, CREATE_IMAGES_GRAPH_FRAGMENT_KIND);
  assert.equal(fragment.version, CREATE_IMAGES_GRAPH_FRAGMENT_VERSION);
  assert.deepEqual(
    fragment.nodes.map((node) => node.id),
    ["prompt-1", "generate-1"],
  );
  assert.deepEqual(fragment.edges.map((edge) => edge.id), ["edge-1"]);
  const serialized = serializeCreateImagesGraphFragment(fragment);
  assert.ok(serialized);
  assert.doesNotMatch(serialized, /credential|filePath|providerPayload|data:image|\/Users\//u);
  assert.equal(parseCreateImagesGraphFragment(serialized).status, "valid");
});

test("graph fragment parsing fails closed for hostile fields, bytes, and invalid edges", () => {
  assert.equal(parseCreateImagesGraphFragment("not-json").status, "invalid");
  const base = createCreateImagesGraphFragment(workflow(), new Set(["prompt-1", "generate-1"]));
  assert.ok(base);
  assert.equal(
    parseCreateImagesGraphFragment(JSON.stringify({ ...base, credential: "secret" })).status,
    "invalid",
  );
  assert.equal(
    parseCreateImagesGraphFragment(
      JSON.stringify({ ...base, edges: [{ ...base.edges[0], targetPort: "missing" }] }),
    ).status,
    "invalid",
  );
  assert.equal(parseCreateImagesGraphFragment("x".repeat(2 * 1024 * 1024 + 1)).status, "invalid");
});

test("fragment instantiation remaps identities and anchors one atomic paste", () => {
  const base = createCreateImagesGraphFragment(workflow(), new Set(["prompt-1", "generate-1"]));
  assert.ok(base);
  const pasted = instantiateCreateImagesGraphFragment(base, {
    anchor: { x: 500, y: 700 },
    uniqueToken: "test",
    startSequence: 4,
  });
  assert.deepEqual(pasted.nodes[0]?.position, { x: 500, y: 730 });
  assert.deepEqual(pasted.nodes[1]?.position, { x: 840, y: 700 });
  assert.notEqual(pasted.nodes[0]?.id, base.nodes[0]?.id);
  assert.equal(pasted.edges[0]?.source, pasted.nodes[0]?.id);
  assert.equal(pasted.edges[0]?.target, pasted.nodes[1]?.id);
  assert.equal(pasted.nextSequence, 7);
});

test("group fragments keep only copied members and remap them on paste", () => {
  const document = workflow();
  document.nodes.push({
    id: "group-1",
    type: "group",
    position: { x: 20, y: 20 },
    data: {
      memberNodeIds: ["prompt-1", "generate-1", "output-1"],
      color: "blue",
      locked: true,
    },
  });
  const fragment = createCreateImagesGraphFragment(
    document,
    new Set(["group-1", "prompt-1", "generate-1"]),
  );
  assert.ok(fragment);
  const copiedGroup = fragment.nodes.find((node) => node.type === "group");
  assert.deepEqual(copiedGroup?.data.memberNodeIds, ["prompt-1", "generate-1"]);

  const pasted = instantiateCreateImagesGraphFragment(fragment, {
    anchor: { x: 100, y: 100 },
    uniqueToken: "groups",
  });
  const pastedGroup = pasted.nodes.find((node) => node.type === "group");
  const pastedMembers = pasted.nodes
    .filter((node) => node.type !== "group")
    .map((node) => node.id);
  assert.deepEqual(pastedGroup?.data.memberNodeIds, pastedMembers);
});
