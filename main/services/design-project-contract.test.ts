import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_DESIGN_PROJECT_ARTIFACT_REVISIONS_PER_ARTBOARD,
  MAX_DESIGN_PROJECT_COORDINATE,
  MAX_DESIGN_PROJECT_NODES,
  normalizeDesignProjectCoordinate,
  parseDesignProjectDatabaseV1,
  parseDesignProjectSnapshotV1,
  type DesignProjectSnapshotV1,
} from "./design-project-contract.js";

function snapshot(): DesignProjectSnapshotV1 {
  return {
    version: 1,
    id: "project:one",
    revision: 1,
    title: "Checkout concept",
    chatId: "chat:one",
    connectionState: "prototype-only",
    createdAt: 10,
    updatedAt: 10,
    canvas: {
      viewport: "desktop",
      flowViewport: { x: 12.34567, y: -0, zoom: 0.87654 },
      nodes: [
        {
          id: "node:artboard",
          kind: "artboard",
          canonicalOrigin: "generated-artifact",
          lineageId: "lineage:checkout",
          artifactMediaIds: ["design:revision-a", "design:revision-b"],
          activeMediaId: "design:revision-b",
          x: 1.2344,
          y: -0,
        },
        {
          id: "node:reference",
          kind: "reference-image",
          canonicalOrigin: "reference-asset",
          assetId: "asset:reference",
          x: 40,
          y: 50,
        },
      ],
    },
    referenceAssetIds: ["asset:reference"],
  };
}

test("DesignProjectSnapshotV1 normalizes bounded coordinates and preserves explicit lineage", () => {
  const parsed = parseDesignProjectSnapshotV1(snapshot());
  assert.ok(parsed);
  assert.equal(parsed.canvas.nodes[0]?.x, 1.234);
  assert.equal(parsed.canvas.nodes[0]?.y, 0);
  assert.deepEqual(parsed.canvas.flowViewport, { x: 12.346, y: 0, zoom: 0.8765 });
  assert.deepEqual(parsed.canvas.nodes[0]?.artifactMediaIds, [
    "design:revision-a",
    "design:revision-b",
  ]);
  assert.equal(normalizeDesignProjectCoordinate(-0), 0);
});

test("DesignProjectSnapshotV1 rejects renderer-crafted coordinate and count bounds", () => {
  for (const x of [Number.NaN, Number.POSITIVE_INFINITY, MAX_DESIGN_PROJECT_COORDINATE + 1]) {
    const value = snapshot();
    value.canvas.nodes[0]!.x = x;
    assert.equal(parseDesignProjectSnapshotV1(value), undefined);
  }

  for (const flowViewport of [
    { x: Number.NaN, y: 0, zoom: 1 },
    { x: 0, y: Number.POSITIVE_INFINITY, zoom: 1 },
    { x: 0, y: 0, zoom: 0.01 },
    { x: 0, y: 0, zoom: 5 },
  ]) {
    const flow = snapshot();
    flow.canvas.flowViewport = flowViewport;
    assert.equal(parseDesignProjectSnapshotV1(flow), undefined);
  }

  const value = snapshot();
  value.canvas.nodes = Array.from({ length: MAX_DESIGN_PROJECT_NODES + 1 }, (_, index) => ({
    id: `node:${index}`,
    kind: "source-preview" as const,
    canonicalOrigin: "connected-app" as const,
    x: index,
    y: 0,
  }));
  value.connectionState = "connected";
  value.workspaceId = "workspace:one";
  value.referenceAssetIds = [];
  assert.equal(parseDesignProjectSnapshotV1(value), undefined);
});

test("DesignProjectSnapshotV1 rejects hidden content, paths, and connection ambiguity", () => {
  assert.equal(parseDesignProjectSnapshotV1({ ...snapshot(), prompt: "secret prompt" }), undefined);
  assert.equal(
    parseDesignProjectSnapshotV1({ ...snapshot(), sourceCode: "const secret = true" }),
    undefined,
  );
  assert.equal(
    parseDesignProjectSnapshotV1({
      ...snapshot(),
      connectionState: "connected",
      workspaceId: "/Users/example/source",
    }),
    undefined,
  );
  assert.equal(
    parseDesignProjectSnapshotV1({ ...snapshot(), connectionState: "connected" }),
    undefined,
  );
  assert.equal(
    parseDesignProjectSnapshotV1({
      ...snapshot(),
      workspaceId: "workspace:one",
    }),
    undefined,
  );
});

test("artboard lineage is unique, bounded, and independent from display titles", () => {
  const badActive = snapshot();
  badActive.canvas.nodes[0]!.activeMediaId = "design:not-in-lineage";
  assert.equal(parseDesignProjectSnapshotV1(badActive), undefined);

  const duplicateRevision = snapshot();
  duplicateRevision.canvas.nodes.push({
    id: "node:other",
    kind: "artboard",
    canonicalOrigin: "generated-artifact",
    lineageId: "lineage:other",
    artifactMediaIds: ["design:revision-a"],
    activeMediaId: "design:revision-a",
    x: 2,
    y: 2,
  });
  assert.equal(parseDesignProjectSnapshotV1(duplicateRevision), undefined);

  const duplicateLineage = snapshot();
  duplicateLineage.canvas.nodes.push({
    id: "node:other",
    kind: "artboard",
    canonicalOrigin: "generated-artifact",
    lineageId: "lineage:checkout",
    artifactMediaIds: ["design:revision-c"],
    activeMediaId: "design:revision-c",
    x: 2,
    y: 2,
  });
  assert.equal(parseDesignProjectSnapshotV1(duplicateLineage), undefined);

  const tooManyRevisions = snapshot();
  tooManyRevisions.canvas.nodes[0]!.artifactMediaIds = Array.from(
    { length: MAX_DESIGN_PROJECT_ARTIFACT_REVISIONS_PER_ARTBOARD + 1 },
    (_, index) => `design:revision-${index}`,
  );
  tooManyRevisions.canvas.nodes[0]!.activeMediaId = "design:revision-0";
  assert.equal(parseDesignProjectSnapshotV1(tooManyRevisions), undefined);
});

test("reference assets must be opaque IDs exactly reflected by reference nodes", () => {
  const base64 = snapshot();
  base64.referenceAssetIds = ["data:image/png;base64,abc"];
  base64.canvas.nodes[1]!.assetId = base64.referenceAssetIds[0];
  assert.equal(parseDesignProjectSnapshotV1(base64), undefined);

  const hidden = snapshot();
  hidden.referenceAssetIds.push("asset:hidden");
  assert.equal(parseDesignProjectSnapshotV1(hidden), undefined);

  const untracked = snapshot();
  untracked.referenceAssetIds = [];
  assert.equal(parseDesignProjectSnapshotV1(untracked), undefined);
});

test("Design Project database rejects duplicate project and chat ownership", () => {
  const first = snapshot();
  const valid = parseDesignProjectDatabaseV1({ version: 1, revision: 1, projects: [first] });
  assert.ok(valid);
  assert.equal(
    parseDesignProjectDatabaseV1({
      version: 1,
      revision: 2,
      projects: [first, { ...first, chatId: "chat:two" }],
    }),
    undefined,
  );
  assert.equal(
    parseDesignProjectDatabaseV1({
      version: 1,
      revision: 2,
      projects: [first, { ...first, id: "project:two" }],
    }),
    undefined,
  );
  assert.equal(
    parseDesignProjectDatabaseV1({
      version: 1,
      revision: 2,
      projects: [first, { ...first, id: "project:two", chatId: "chat:two" }],
    }),
    undefined,
    "artifact revisions cannot be owned by two projects",
  );
});
