import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_DESIGN_PROJECT_NODES,
  MAX_DESIGN_PROJECT_SNAPSHOT_BYTES,
  MAX_DESIGN_PROJECT_STORE_BYTES,
  parseDesignProjectDatabaseV1,
  parseDesignProjectSnapshotV1,
  type DesignProjectSnapshotV1,
} from "./design-project-contract.js";
import {
  designProjectDatabaseV2StorePolicy,
  emptyDesignProjectDatabaseV2,
  migrateDesignProjectDatabaseV1ToV2,
  migrateDesignProjectSnapshotV1ToV2,
  parseDesignProjectDatabaseV2,
  parseDesignProjectSnapshotV2,
  readDesignProjectDatabaseV2,
  type DesignProjectV2MigrationPolicy,
} from "./design-project-contract-v2.js";
import { DataStore } from "./data-store.js";

const migrationPolicy: DesignProjectV2MigrationPolicy = {
  titlePolicy: () => ({ state: "manual" }),
  screenPresentation: (viewport) =>
    viewport === "desktop"
      ? { surface: "web", frame: { preset: "desktop", width: 1_200, height: 760 } }
      : viewport === "tablet"
        ? { surface: "app", frame: { preset: "tablet", width: 768, height: 900 } }
        : { surface: "app", frame: { preset: "phone", width: 390, height: 844 } },
};

function legacySnapshot(): DesignProjectSnapshotV1 {
  return {
    version: 1,
    id: "project:one",
    revision: 7,
    title: "Manually named project",
    chatId: "chat:one",
    workspaceId: "workspace:one",
    connectionState: "connected",
    createdAt: 10,
    updatedAt: 20,
    canvas: {
      viewport: "phone",
      flowViewport: { x: 12.5, y: -3, zoom: 0.75 },
      nodes: [
        {
          id: "node:screen",
          kind: "artboard",
          canonicalOrigin: "generated-artifact",
          x: 100,
          y: 200,
          lineageId: "lineage:screen",
          artifactMediaIds: ["design:one", "design:two"],
          activeMediaId: "design:two",
        },
        {
          id: "node:reference",
          kind: "reference-image",
          canonicalOrigin: "reference-asset",
          x: 300,
          y: 400,
          assetId: "asset:one",
        },
        {
          id: "node:source",
          kind: "source-preview",
          canonicalOrigin: "connected-app",
          x: 500,
          y: 600,
        },
      ],
    },
    referenceAssetIds: ["asset:one"],
    designSystemBinding: { id: "design-system:one", revision: 4 },
    previewScriptId: "script:dev",
  };
}

function nearLimitLegacySnapshot(projectIndex: number): DesignProjectSnapshotV1 {
  const nodes = Array.from({ length: MAX_DESIGN_PROJECT_NODES }, (_, nodeIndex) => {
    const artifactMediaIds = Array.from(
      { length: 6 },
      (_, revisionIndex) =>
        `design:${projectIndex}:${nodeIndex}:${revisionIndex}:${"x".repeat(100)}`,
    );
    return {
      id: `node:${projectIndex}:${nodeIndex}`,
      kind: "artboard" as const,
      canonicalOrigin: "generated-artifact" as const,
      x: nodeIndex,
      y: projectIndex,
      lineageId: `lineage:${projectIndex}:${nodeIndex}`,
      artifactMediaIds,
      activeMediaId: artifactMediaIds[artifactMediaIds.length - 1]!,
    };
  });
  return {
    version: 1,
    id: `project:${projectIndex}`,
    revision: 1,
    title: `Legacy project ${projectIndex}`,
    chatId: `chat:${projectIndex}`,
    connectionState: "prototype-only",
    createdAt: 1,
    updatedAt: 1,
    canvas: {
      viewport: "desktop",
      flowViewport: { x: 0, y: 0, zoom: 1 },
      nodes,
    },
    referenceAssetIds: [],
  };
}

test("V1 to V2 migration preserves every durable fact and adds conservative semantics", () => {
  const legacy = legacySnapshot();
  const before = structuredClone(legacy);
  const migrated = migrateDesignProjectSnapshotV1ToV2(legacy, migrationPolicy);
  assert.ok(migrated);
  assert.deepEqual(legacy, before, "migration must not mutate the source snapshot");
  assert.equal(migrated.version, 2);
  assert.equal(migrated.revision, legacy.revision);
  assert.equal(migrated.title, legacy.title);
  assert.deepEqual(migrated.titlePolicy, { state: "manual" });
  assert.deepEqual(migrated.canvas.nodes[0], {
    ...legacy.canvas.nodes[0],
    presentation: {
      surface: "app",
      frame: { preset: "phone", width: 390, height: 844 },
    },
  });
  assert.deepEqual(migrated.canvas.nodes.slice(1), legacy.canvas.nodes.slice(1));
  const { version: _legacyVersion, canvas: _legacyCanvas, ...legacyRest } = legacy;
  const {
    version: _v2Version,
    canvas: _v2Canvas,
    titlePolicy: _titlePolicy,
    ...migratedRest
  } = migrated;
  assert.deepEqual(migratedRest, legacyRest);
  assert.deepEqual(migrated.canvas.flowViewport, legacy.canvas.flowViewport);
  assert.equal(migrated.canvas.viewport, legacy.canvas.viewport);
});

test("V2 parser is exact, bounded, and requires presentation only on Screens", () => {
  const valid = migrateDesignProjectSnapshotV1ToV2(legacySnapshot(), migrationPolicy)!;
  assert.deepEqual(parseDesignProjectSnapshotV2(valid), valid);
  assert.equal(parseDesignProjectSnapshotV2({ ...valid, prompt: "hidden" }), undefined);
  assert.equal(parseDesignProjectSnapshotV2({ ...valid, version: 3 }), undefined);
  const inheritedTitle = Object.assign(
    Object.create({ title: valid.title }) as Record<string, unknown>,
    (({ title: _title, ...rest }) => rest)(valid),
  );
  assert.equal(
    parseDesignProjectSnapshotV2(inheritedTitle),
    undefined,
    "required properties must be owned rather than inherited",
  );
  assert.equal(
    parseDesignProjectSnapshotV2({
      ...valid,
      title: "Named project",
      titlePolicy: { state: "auto-eligible" },
    }),
    undefined,
    "auto eligibility is valid only for the blank placeholder title",
  );
  assert.equal(
    parseDesignProjectSnapshotV2({
      ...valid,
      canvas: {
        ...valid.canvas,
        nodes: valid.canvas.nodes.map((node) =>
          node.kind === "artboard"
            ? (({ presentation: _presentation, ...rest }) => rest)(node)
            : node,
        ),
      },
    }),
    undefined,
  );
  assert.equal(
    parseDesignProjectSnapshotV2({
      ...valid,
      canvas: {
        ...valid.canvas,
        nodes: valid.canvas.nodes.map((node) =>
          node.kind === "reference-image"
            ? {
                ...node,
                presentation: {
                  surface: "web",
                  frame: { preset: "desktop", width: 1200, height: 760 },
                },
              }
            : node,
        ),
      },
    }),
    undefined,
  );
  const malformedFrame = structuredClone(valid);
  const screen = malformedFrame.canvas.nodes[0]!;
  if (screen.kind !== "artboard") throw new Error("Fixture Screen missing.");
  screen.presentation.frame.width = 16_385;
  assert.equal(parseDesignProjectSnapshotV2(malformedFrame), undefined);

  assert.ok(
    parseDesignProjectSnapshotV2({
      ...valid,
      titlePolicy: {
        state: "auto-applied",
        sourceLineageId: "lineage:screen",
        sourceMediaId: "design:two",
      },
    }),
  );
  assert.equal(
    parseDesignProjectSnapshotV2({
      ...valid,
      titlePolicy: {
        state: "auto-applied",
        sourceLineageId: "lineage:screen",
        sourceMediaId: "design:unowned",
      },
    }),
    undefined,
    "automatic title provenance must resolve to one owned Screen revision",
  );
});

test("migration headroom accepts every near-limit V1 snapshot and store without data loss", () => {
  const one = nearLimitLegacySnapshot(0);
  const oneBytes = Buffer.byteLength(JSON.stringify(one), "utf8");
  assert.ok(oneBytes > MAX_DESIGN_PROJECT_SNAPSHOT_BYTES - 64 * 1024);
  assert.ok(oneBytes <= MAX_DESIGN_PROJECT_SNAPSHOT_BYTES);
  assert.ok(parseDesignProjectSnapshotV1(one));
  const migratedOne = migrateDesignProjectSnapshotV1ToV2(one);
  assert.ok(migratedOne);
  assert.ok(Buffer.byteLength(JSON.stringify(migratedOne), "utf8") > oneBytes);
  assert.equal(migratedOne.canvas.nodes.length, one.canvas.nodes.length);

  const projects: DesignProjectSnapshotV1[] = [];
  let encodedBytes = Buffer.byteLength(
    JSON.stringify({ version: 1, revision: 1, projects: [] }),
    "utf8",
  );
  for (let index = 0; index < 250; index += 1) {
    const project = nearLimitLegacySnapshot(index);
    const projectBytes =
      Buffer.byteLength(JSON.stringify(project), "utf8") + (projects.length === 0 ? 0 : 1);
    if (encodedBytes + projectBytes > MAX_DESIGN_PROJECT_STORE_BYTES) break;
    projects.push(project);
    encodedBytes += projectBytes;
  }
  const legacyDatabase = { version: 1 as const, revision: 1, projects };
  assert.ok(encodedBytes > MAX_DESIGN_PROJECT_STORE_BYTES - oneBytes * 2);
  assert.ok(parseDesignProjectDatabaseV1(legacyDatabase));
  const migratedDatabase = migrateDesignProjectDatabaseV1ToV2(legacyDatabase);
  assert.ok(migratedDatabase);
  assert.equal(migratedDatabase.projects.length, projects.length);
  assert.equal(migratedDatabase.projects[0]?.canvas.nodes.length, MAX_DESIGN_PROJECT_NODES);
});

test("database dual reader migrates V1, accepts V2, and rejects mixed or future stores", () => {
  const legacy = { version: 1, revision: 9, projects: [legacySnapshot()] };
  const migrated = readDesignProjectDatabaseV2(legacy, migrationPolicy);
  assert.equal(migrated?.sourceVersion, 1);
  assert.equal(migrated?.migrated, true);
  assert.equal(migrated?.database.revision, 9);
  assert.equal(migrated?.database.projects[0]?.version, 2);
  assert.deepEqual(readDesignProjectDatabaseV2(migrated?.database, migrationPolicy), {
    sourceVersion: 2,
    migrated: false,
    database: migrated?.database,
  });
  assert.equal(readDesignProjectDatabaseV2({ ...legacy, version: 3 }, migrationPolicy), undefined);
  assert.equal(
    parseDesignProjectDatabaseV2({
      version: 2,
      revision: 1,
      projects: [
        migrated?.database.projects[0],
        { ...migrated?.database.projects[0], id: "project:two" },
      ],
    }),
    undefined,
    "chat and artifact ownership remain globally unique",
  );
});

test("V2 DataStore policy reads V1 safely and writes canonical V2 on the next mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aiden-design-v2-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "design-projects.json");
  await writeFile(
    path,
    JSON.stringify({ version: 1, revision: 9, projects: [legacySnapshot()] }),
    "utf8",
  );
  const storePolicy = designProjectDatabaseV2StorePolicy(migrationPolicy);
  const store = new DataStore("design-projects.json", emptyDesignProjectDatabaseV2(), () => root, {
    ...storePolicy,
    rejectUnsafeWrite: true,
    reloadBeforeWrite: true,
  });
  assert.equal((await store.load()).version, 2);
  assert.equal(await store.loadedFromUnsafeFile(), false);
  await store.update((database) => {
    database.revision += 1;
  });
  const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.equal(persisted.version, 2);
  assert.equal(persisted.revision, 10);
  assert.ok(parseDesignProjectDatabaseV2(persisted));
});
