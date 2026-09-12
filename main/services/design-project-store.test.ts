import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { type DesignProjectCanvasV1 } from "./design-project-contract.js";
import {
  designProjectDatabaseV2StorePolicy,
  emptyDesignProjectDatabaseV2,
  parseDesignProjectDatabaseV2,
  type DesignProjectDatabaseV2,
} from "./design-project-contract-v2.js";
import { DataStore } from "./data-store.js";
import type { ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import { GenerativeUiArtifactStore } from "./generative-ui-artifact-store.js";
import { inspectDesignProjectHealth } from "./design-project-health.js";
import { DesignReferenceAssetStore } from "./design-reference-asset-store.js";
import { SourceDesignPreviewService } from "./source-design-preview.js";
import {
  DesignProjectConflictError,
  DesignProjectMigrationBlockedError,
  DesignProjectPublicationUncertainError,
  DesignProjectRevisionConflictError,
  DesignProjectStore,
  DesignProjectUnavailableError,
  type DesignProjectDuplicatePort,
  type LegacyDesignChatFacts,
} from "./design-project-store.js";

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aiden-design-project-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function canvas(): DesignProjectCanvasV1 {
  return {
    viewport: "desktop",
    flowViewport: { x: 4, y: 5, zoom: 0.75 },
    nodes: [
      {
        id: "node:checkout",
        kind: "artboard",
        canonicalOrigin: "generated-artifact",
        lineageId: "lineage:checkout",
        artifactMediaIds: ["design:checkout-a", "design:checkout-b"],
        activeMediaId: "design:checkout-b",
        x: 10,
        y: 20,
      },
      {
        id: "node:reference",
        kind: "reference-image",
        canonicalOrigin: "reference-asset",
        assetId: "asset:reference-a",
        x: 50,
        y: 60,
      },
    ],
  };
}

function failpointProjectDataStore(
  root: string,
  afterDestinationPublish: () => Promise<void>,
): DataStore<DesignProjectDatabaseV2> {
  const policy = designProjectDatabaseV2StorePolicy();
  return new DataStore("design-projects.json", emptyDesignProjectDatabaseV2(), () => root, {
    normalize: policy.normalize,
    isSafe: policy.isSafe,
    rejectCorruptWrite: true,
    rejectUnsafeWrite: true,
    rejectExternalChanges: true,
    reloadBeforeWrite: true,
    afterDestinationPublish,
  });
}

// 1x1 opaque PNG. A bounded ancillary chunk makes each fixture content-address unique.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function referencePng(index: number): Buffer {
  const iendOffset = PNG.byteLength - 12;
  const fixtureChunk = Buffer.alloc(13);
  fixtureChunk.writeUInt32BE(1, 0);
  fixtureChunk.write("tEXt", 4, "ascii");
  fixtureChunk[8] = index;
  // The raster validator intentionally checks bounded structure, not PNG CRCs.
  return Buffer.concat([PNG.subarray(0, iendOffset), fixtureChunk, PNG.subarray(iendOffset)]);
}

function htmlArtifact(mediaId: string, html: string, title: string): ChatHtmlArtifactV1 {
  return {
    version: 1,
    kind: "html",
    id: createHash("sha256").update(html).digest("hex"),
    title,
    mimeType: "text/html",
    size: Buffer.byteLength(html, "utf8"),
    mediaId,
  };
}

test("owner-only store supports create, list, get, update, rename, and CAS", async (t) => {
  const root = await temporaryRoot(t);
  let now = 100;
  let id = 0;
  const store = new DesignProjectStore({
    root: () => root,
    now: () => now,
    mintProjectId: () => `project:${++id}`,
  });
  await store.initialize();

  const created = await store.create({
    chatId: "chat:one",
    title: "  Checkout  ",
    connectionState: "prototype-only",
    canvas: canvas(),
    referenceAssetIds: ["asset:reference-a"],
  });
  assert.equal(created.title, "Checkout");
  assert.equal(created.revision, 1);
  assert.equal((await stat(join(root, "design-projects.json"))).mode & 0o777, 0o600);
  assert.deepEqual(await store.get(created.id), created);
  assert.deepEqual(await store.getByChatId(created.chatId), created);
  assert.equal((await store.list())[0]?.artboardCount, 1);

  now = 100;
  const moved = canvas();
  moved.nodes[0]!.x = 12.34567;
  const updated = await store.update({
    id: created.id,
    expectedRevision: created.revision,
    canvas: moved,
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.updatedAt, 101, "timestamps remain monotonic when the wall clock stalls");
  assert.equal(updated.canvas.nodes[0]?.x, 12.346);

  await assert.rejects(
    store.update({
      id: created.id,
      expectedRevision: created.revision,
      canvas: moved,
    }),
    (error: unknown) =>
      error instanceof DesignProjectRevisionConflictError && error.currentRevision === 2,
  );

  const renamed = await store.rename({
    id: created.id,
    expectedRevision: updated.revision,
    title: "Payment flow",
  });
  assert.equal(renamed.title, "Payment flow");
  assert.equal(renamed.revision, 3);
  await assert.rejects(
    store.rename({ id: created.id, expectedRevision: 2, title: "Stale" }),
    DesignProjectRevisionConflictError,
  );
});

test("canonical V2 writes preserve Screen semantics and use dedicated CAS operations", async (t) => {
  const root = await temporaryRoot(t);
  let now = 100;
  const store = new DesignProjectStore({
    root: () => root,
    now: () => ++now,
    mintProjectId: () => "project:v2-semantics",
  });
  await store.initialize();
  const blank = await store.create({
    chatId: "chat:v2-semantics",
    title: "Untitled Design",
    titleOrigin: "blank",
    connectionState: "prototype-only",
    canvas: {
      viewport: "phone",
      flowViewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
    },
  });
  assert.equal(blank.version, 2);
  assert.deepEqual(blank.titlePolicy, { state: "auto-eligible" });

  const first = await store.publishGeneratedRevisions({
    projectId: blank.id,
    chatId: blank.chatId,
    revisions: [
      {
        mediaId: "design:first",
        candidateTitle: "Checkout flow",
        ownership: {
          version: 1,
          kind: "new-artboard",
          projectId: blank.id,
          lineageId: "lineage:first",
          presentation: {
            surface: "web",
            frame: { preset: "desktop", width: 1_200, height: 760 },
          },
        },
      },
    ],
  });
  assert.equal(first.title, "Checkout flow");
  assert.deepEqual(first.titlePolicy, {
    state: "auto-applied",
    sourceLineageId: "lineage:first",
    sourceMediaId: "design:first",
  });
  assert.deepEqual(first.canvas.nodes[0]?.presentation, {
    surface: "web",
    frame: { preset: "desktop", width: 1_200, height: 760 },
  });
  assert.equal(first.canvas.viewport, "phone", "preview preference remains independent");

  const framed = await store.setScreenPresentation({
    id: first.id,
    expectedRevision: first.revision,
    lineageId: "lineage:first",
    presentation: {
      surface: "web",
      frame: { preset: "custom", width: 1_440, height: 900 },
    },
  });
  const requested = structuredClone(framed.canvas);
  const requestedScreen = requested.nodes[0];
  if (requestedScreen?.kind !== "artboard") throw new Error("Screen fixture missing.");
  requestedScreen.presentation = {
    surface: "app",
    frame: { preset: "phone", width: 390, height: 844 },
  };
  await assert.rejects(
    store.update({
      id: framed.id,
      expectedRevision: framed.revision,
      canvas: requested,
    }),
    /semantics.*immutable/iu,
  );
  const movedCanvas = structuredClone(framed.canvas);
  movedCanvas.nodes[0]!.x += 24;
  const layoutOnly = await store.update({
    id: framed.id,
    expectedRevision: framed.revision,
    canvas: movedCanvas,
  });
  assert.deepEqual(layoutOnly.canvas.nodes[0]?.presentation, framed.canvas.nodes[0]?.presentation);

  const secondRevision = await store.publishGeneratedRevisions({
    projectId: layoutOnly.id,
    chatId: layoutOnly.chatId,
    revisions: [
      {
        mediaId: "design:second",
        ownership: {
          version: 1,
          kind: "revision",
          projectId: layoutOnly.id,
          lineageId: "lineage:first",
          baseMediaId: "design:first",
        },
      },
    ],
  });
  const forgedActiveCanvas = structuredClone(secondRevision.canvas);
  const forgedActiveScreen = forgedActiveCanvas.nodes[0];
  if (forgedActiveScreen?.kind !== "artboard") throw new Error("Screen fixture missing.");
  forgedActiveScreen.activeMediaId = "design:first";
  await assert.rejects(
    store.update({
      id: secondRevision.id,
      expectedRevision: secondRevision.revision,
      canvas: forgedActiveCanvas,
    }),
    /semantics.*immutable/iu,
  );
  const restoredFirst = await store.setActiveRevision({
    id: secondRevision.id,
    expectedRevision: secondRevision.revision,
    lineageId: "lineage:first",
    mediaId: "design:first",
  });
  assert.equal(restoredFirst.canvas.nodes[0]?.activeMediaId, "design:first");
  await assert.rejects(
    store.setActiveRevision({
      id: restoredFirst.id,
      expectedRevision: restoredFirst.revision,
      lineageId: "lineage:first",
      mediaId: "design:unowned",
    }),
    DesignProjectConflictError,
  );

  const disk = parseDesignProjectDatabaseV2(
    JSON.parse(await readFile(join(root, "design-projects.json"), "utf8")),
  );
  assert.equal(disk?.projects[0]?.version, 2);
});

test("an unusable first Screen title consumes automatic eligibility permanently", async (t) => {
  const root = await temporaryRoot(t);
  const store = new DesignProjectStore({
    root: () => root,
    mintProjectId: () => "project:title-consumed",
  });
  await store.initialize();
  const blank = await store.create({
    chatId: "chat:title-consumed",
    title: "Untitled Design",
    titleOrigin: "blank",
    connectionState: "prototype-only",
  });
  const first = await store.publishGeneratedRevisions({
    projectId: blank.id,
    chatId: blank.chatId,
    revisions: [
      {
        mediaId: "design:invalid-title",
        candidateTitle: "bad\nname",
        ownership: {
          version: 1,
          kind: "new-artboard",
          projectId: blank.id,
          lineageId: "lineage:invalid-title",
        },
      },
    ],
  });
  assert.equal(first.title, "Untitled Design");
  assert.deepEqual(first.titlePolicy, { state: "manual" });

  const removed = await store.removeMissingGeneratedArtboard({
    projectId: first.id,
    expectedRevision: first.revision,
    lineageId: "lineage:invalid-title",
    activeMediaId: "design:invalid-title",
  });
  const later = await store.publishGeneratedRevisions({
    projectId: removed.id,
    chatId: removed.chatId,
    revisions: [
      {
        mediaId: "design:later-valid",
        candidateTitle: "Later valid title",
        ownership: {
          version: 1,
          kind: "new-artboard",
          projectId: removed.id,
          lineageId: "lineage:later-valid",
        },
      },
    ],
  });
  assert.equal(later.title, "Untitled Design");
  assert.deepEqual(later.titlePolicy, { state: "manual" });
});

test("V1 stores dual-read losslessly and canonicalize on the next mutation", async (t) => {
  const root = await temporaryRoot(t);
  const legacy = {
    version: 1 as const,
    revision: 4,
    projects: [
      {
        version: 1 as const,
        id: "project:legacy",
        revision: 7,
        title: "Legacy title",
        chatId: "chat:legacy",
        connectionState: "prototype-only" as const,
        createdAt: 10,
        updatedAt: 20,
        canvas: canvas(),
        referenceAssetIds: ["asset:reference-a"],
      },
    ],
  };
  await writeFile(join(root, "design-projects.json"), JSON.stringify(legacy), "utf8");
  const store = new DesignProjectStore({ root: () => root, now: () => 30 });
  await store.initialize();
  const migrated = await store.get("project:legacy");
  assert.ok(migrated);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.revision, 7);
  assert.equal(migrated.title, "Legacy title");
  assert.deepEqual(migrated.titlePolicy, { state: "manual" });
  assert.deepEqual(migrated.canvas.nodes[0]?.presentation, {
    surface: "unknown",
    frame: { preset: "desktop", width: 1_200, height: 760 },
  });
  const renamed = await store.rename({
    id: migrated.id,
    expectedRevision: migrated.revision,
    title: "Renamed legacy title",
  });
  assert.equal(renamed.revision, 8);
  const disk = parseDesignProjectDatabaseV2(
    JSON.parse(await readFile(join(root, "design-projects.json"), "utf8")),
  );
  assert.equal(disk?.revision, 5);
  assert.equal(disk?.projects[0]?.title, "Renamed legacy title");
});

test("generic canvas updates cannot invent or rewrite generated lineage ownership", async (t) => {
  const root = await temporaryRoot(t);
  const store = new DesignProjectStore({ root: () => root });
  await store.initialize();
  const project = await store.create({
    chatId: "chat:immutable-lineage",
    title: "Immutable lineage",
    connectionState: "prototype-only",
    canvas: canvas(),
    referenceAssetIds: ["asset:reference-a"],
  });
  await assert.rejects(
    store.update({
      id: project.id,
      expectedRevision: project.revision,
      canvas: {
        ...project.canvas,
        nodes: project.canvas.nodes.map((node) =>
          node.kind === "artboard"
            ? {
                ...node,
                artifactMediaIds: [...(node.artifactMediaIds ?? []), "design:forged"],
                activeMediaId: "design:forged",
              }
            : node,
        ),
      },
    }),
    /semantics.*lineage.*immutable/iu,
  );
  const moved = await store.update({
    id: project.id,
    expectedRevision: project.revision,
    canvas: {
      ...project.canvas,
      nodes: project.canvas.nodes.map((node) => ({ ...node, x: node.x + 12 })),
    },
  });
  assert.equal(moved.canvas.nodes[0]?.x, project.canvas.nodes[0]!.x + 12);
});

test("main-owned missing-artboard repair removes only one exact generated lineage under CAS", async (t) => {
  const root = await temporaryRoot(t);
  const store = new DesignProjectStore({ root: () => root });
  await store.initialize();
  const project = await store.create({
    chatId: "chat:missing-repair",
    title: "Missing repair",
    connectionState: "prototype-only",
    canvas: canvas(),
    referenceAssetIds: ["asset:reference-a"],
  });
  await assert.rejects(
    store.removeMissingGeneratedArtboard({
      projectId: project.id,
      expectedRevision: project.revision,
      lineageId: "lineage:checkout",
      activeMediaId: "design:not-active",
    }),
    /changed before it could be removed/iu,
  );
  const repaired = await store.removeMissingGeneratedArtboard({
    projectId: project.id,
    expectedRevision: project.revision,
    lineageId: "lineage:checkout",
    activeMediaId: "design:checkout-b",
  });
  assert.equal(repaired.revision, project.revision + 1);
  assert.equal(
    repaired.canvas.nodes.some(({ kind }) => kind === "artboard"),
    false,
  );
  assert.equal(
    repaired.canvas.nodes.some(({ kind }) => kind === "reference-image"),
    true,
  );
  await assert.rejects(
    store.removeMissingGeneratedArtboard({
      projectId: project.id,
      expectedRevision: project.revision,
      lineageId: "lineage:checkout",
      activeMediaId: "design:checkout-b",
    }),
    DesignProjectRevisionConflictError,
  );
});

test("main-owned history repair prunes only an exact missing non-active revision", async (t) => {
  const root = await temporaryRoot(t);
  const store = new DesignProjectStore({ root: () => root });
  await store.initialize();
  const project = await store.create({
    chatId: "chat:missing-history",
    title: "Missing history",
    connectionState: "prototype-only",
    canvas: canvas(),
    referenceAssetIds: ["asset:reference-a"],
  });
  await assert.rejects(
    store.removeMissingGeneratedRevision({
      projectId: project.id,
      expectedRevision: project.revision,
      lineageId: "lineage:checkout",
      missingMediaId: "design:checkout-b",
      expectedActiveMediaId: "design:checkout-b",
    }),
    /active generated revision cannot be pruned/iu,
  );
  await assert.rejects(
    store.removeMissingGeneratedRevision({
      projectId: project.id,
      expectedRevision: project.revision,
      lineageId: "lineage:checkout",
      missingMediaId: "design:checkout-a",
      expectedActiveMediaId: "design:not-active",
    }),
    /changed before it could be pruned/iu,
  );
  const repaired = await store.removeMissingGeneratedRevision({
    projectId: project.id,
    expectedRevision: project.revision,
    lineageId: "lineage:checkout",
    missingMediaId: "design:checkout-a",
    expectedActiveMediaId: "design:checkout-b",
  });
  const artboard = repaired.canvas.nodes.find((node) => node.kind === "artboard");
  assert.deepEqual(artboard?.artifactMediaIds, ["design:checkout-b"]);
  assert.equal(artboard?.activeMediaId, "design:checkout-b");
  await assert.rejects(
    store.removeMissingGeneratedRevision({
      projectId: project.id,
      expectedRevision: project.revision,
      lineageId: "lineage:checkout",
      missingMediaId: "design:checkout-a",
      expectedActiveMediaId: "design:checkout-b",
    }),
    DesignProjectRevisionConflictError,
  );
});

test("create enforces one durable project per chat", async (t) => {
  const root = await temporaryRoot(t);
  let id = 0;
  const store = new DesignProjectStore({
    root: () => root,
    now: () => 1,
    mintProjectId: () => `project:${++id}`,
  });
  await store.initialize();
  await store.create({
    chatId: "chat:one",
    title: "One",
    connectionState: "prototype-only",
  });
  await assert.rejects(
    store.create({
      chatId: "chat:one",
      title: "Other",
      connectionState: "prototype-only",
    }),
    /already owns/u,
  );
});

test("create retains an exact row installed before a durability failure", async (t) => {
  const root = await temporaryRoot(t);
  let failPublication = true;
  const store = new DesignProjectStore({
    dataStore: failpointProjectDataStore(root, async () => {
      if (!failPublication) return;
      failPublication = false;
      throw new Error("injected directory sync failure");
    }),
    now: () => 10,
    mintProjectId: () => "project:ambiguous-create",
  });
  await store.initialize();

  await assert.rejects(
    store.create({
      chatId: "chat:ambiguous-create",
      title: "Ambiguous create",
      connectionState: "prototype-only",
    }),
    DesignProjectPublicationUncertainError,
  );

  const installed = await store.get("project:ambiguous-create");
  assert.equal(installed?.chatId, "chat:ambiguous-create");
  const persisted = parseDesignProjectDatabaseV2(
    JSON.parse(await readFile(join(root, "design-projects.json"), "utf8")),
  );
  assert.deepEqual(persisted?.projects, [installed]);
});

test("create reports uncertainty when a published row cannot be read safely", async (t) => {
  const root = await temporaryRoot(t);
  const store = new DesignProjectStore({
    dataStore: failpointProjectDataStore(root, async () => {
      await writeFile(join(root, "design-projects.json"), "{not-json", "utf8");
      throw new Error("injected unreadable publication");
    }),
    mintProjectId: () => "project:uncertain-create",
  });
  await store.initialize();

  await assert.rejects(
    store.create({
      chatId: "chat:uncertain-create",
      title: "Uncertain create",
      connectionState: "prototype-only",
    }),
    DesignProjectPublicationUncertainError,
  );
});

test("connect preserves Prototype identity, chat, artboards, references, and history under CAS", async (t) => {
  const root = await temporaryRoot(t);
  const store = new DesignProjectStore({
    root: () => root,
    now: () => 100,
    mintProjectId: () => "project:connect",
  });
  await store.initialize();
  const prototype = await store.create({
    chatId: "chat:connect",
    title: "Checkout",
    connectionState: "prototype-only",
    canvas: canvas(),
    referenceAssetIds: ["asset:reference-a"],
  });
  const connected = await store.connect({
    id: prototype.id,
    expectedRevision: prototype.revision,
    workspaceId: "workspace-1",
  });
  assert.equal(connected.id, prototype.id);
  assert.equal(connected.chatId, prototype.chatId);
  assert.equal(connected.title, prototype.title);
  assert.deepEqual(connected.canvas, prototype.canvas);
  assert.deepEqual(connected.referenceAssetIds, prototype.referenceAssetIds);
  assert.equal(connected.createdAt, prototype.createdAt);
  assert.equal(connected.connectionState, "connected");
  assert.equal(connected.workspaceId, "workspace-1");
  assert.equal(connected.revision, prototype.revision + 1);
  await assert.rejects(
    store.connect({
      id: prototype.id,
      expectedRevision: prototype.revision,
      workspaceId: "workspace-2",
    }),
    DesignProjectRevisionConflictError,
  );
});

test("rebind preserves Prototype history but clears old Connected App authority", async (t) => {
  const root = await temporaryRoot(t);
  const store = new DesignProjectStore({
    root: () => root,
    now: () => 100,
    mintProjectId: () => "project:rebind",
  });
  await store.initialize();
  const connected = await store.create({
    chatId: "chat:rebind",
    title: "Checkout",
    connectionState: "connected",
    workspaceId: "workspace-1",
    previewScriptId: "dev",
    designSystemBinding: { id: "design-system:one", revision: 2 },
    canvas: {
      ...canvas(),
      nodes: [
        ...canvas().nodes,
        {
          id: "source-preview:one",
          kind: "source-preview",
          canonicalOrigin: "connected-app",
          x: 100,
          y: 200,
        },
      ],
    },
    referenceAssetIds: ["asset:reference-a"],
  });
  const rebound = await store.connect({
    id: connected.id,
    expectedRevision: connected.revision,
    workspaceId: "workspace-2",
  });
  assert.equal(rebound.id, connected.id);
  assert.equal(rebound.chatId, connected.chatId);
  assert.equal(rebound.workspaceId, "workspace-2");
  assert.equal(rebound.previewScriptId, undefined);
  assert.equal(rebound.designSystemBinding, undefined);
  assert.equal(
    rebound.canvas.nodes.some(({ kind }) => kind === "source-preview"),
    false,
  );
  assert.deepEqual(
    rebound.canvas.nodes.filter(({ kind }) => kind !== "source-preview"),
    connected.canvas.nodes.filter(({ kind }) => kind !== "source-preview"),
  );
  assert.deepEqual(rebound.referenceAssetIds, connected.referenceAssetIds);
});

test("preview setup publishes the exact Connected App node through a dedicated CAS mutation", async (t) => {
  const root = await temporaryRoot(t);
  const store = new DesignProjectStore({
    root: () => root,
    mintProjectId: () => "project:preview-node",
  });
  await store.initialize();
  const project = await store.create({
    chatId: "chat:preview-node",
    title: "Preview node",
    connectionState: "connected",
    workspaceId: "workspace:preview-node",
  });

  const configured = await store.setPreviewScript({
    id: project.id,
    expectedRevision: project.revision,
    previewScriptId: "dev",
  });
  assert.equal(configured.previewScriptId, "dev");
  assert.deepEqual(configured.canvas.nodes, [
    {
      id: "source-preview:workspace:preview-node",
      kind: "source-preview",
      canonicalOrigin: "connected-app",
      x: 0,
      y: 0,
    },
  ]);
  await assert.rejects(
    store.setPreviewScript({
      id: project.id,
      expectedRevision: project.revision,
      previewScriptId: "preview",
    }),
    DesignProjectRevisionConflictError,
  );

  const unchanged = await store.setPreviewScript({
    id: configured.id,
    expectedRevision: configured.revision,
    previewScriptId: "dev",
  });
  assert.deepEqual(unchanged, configured);
});

test("duplicate remaps complete artifact history, assets, nodes, and lineage", async (t) => {
  const root = await temporaryRoot(t);
  let id = 0;
  const duplicatePort: DesignProjectDuplicatePort = {
    async prepareDuplicate() {
      return {
        targetChatId: "chat:copy",
        artifactMediaIds: [
          { from: "design:checkout-a", to: "design:copy-a" },
          { from: "design:checkout-b", to: "design:copy-b" },
        ],
        referenceAssetIds: [{ from: "asset:reference-a", to: "asset:copy-a" }],
        async rollback() {
          assert.fail("a committed duplicate must not roll back");
        },
      };
    },
  };
  const store = new DesignProjectStore({
    root: () => root,
    now: () => 10,
    mintProjectId: () => `project:${++id}`,
    duplicatePort,
  });
  await store.initialize();
  let source = await store.create({
    chatId: "chat:source",
    title: "Checkout",
    connectionState: "prototype-only",
    canvas: canvas(),
    referenceAssetIds: ["asset:reference-a"],
  });
  source = await store.saveDesignLanguage({projectId:source.id,expectedRevision:source.revision,document:{version:1,name:"Copied language",guidance:"",tokens:{colors:{},spacing:{},typography:{},radii:{}}},provenance:{kind:"derived",lineageId:"lineage:checkout",mediaId:"design:checkout-b",contentHash:"a".repeat(64)}});
  source = await store.applyDesignLanguage({projectId:source.id,expectedRevision:source.revision,languageId:source.designLanguages![0]!.id});
  const copy = await store.duplicate({ id: source.id, expectedRevision: source.revision });
  assert.equal(copy.designLanguages!.length,1);
  assert.notEqual(copy.designLanguages![0]!.id,source.designLanguages![0]!.id);
  assert.equal(copy.designLanguages![0]!.contentHash,source.designLanguages![0]!.contentHash);
  assert.deepEqual(copy.designLanguages![0]!.provenance,{kind:"derived",lineageId:copy.canvas.nodes[0]!.lineageId,mediaId:"design:copy-b",contentHash:"a".repeat(64)});
  assert.equal(copy.activeDesignLanguage!.id,copy.designLanguages![0]!.id);
  assert.equal(copy.title, "Checkout Copy");
  assert.equal(copy.chatId, "chat:copy");
  assert.notEqual(copy.id, source.id);
  assert.notEqual(copy.canvas.nodes[0]?.id, source.canvas.nodes[0]?.id);
  assert.notEqual(copy.canvas.nodes[0]?.lineageId, source.canvas.nodes[0]?.lineageId);
  assert.deepEqual(copy.canvas.nodes[0]?.artifactMediaIds, ["design:copy-a", "design:copy-b"]);
  assert.equal(copy.canvas.nodes[0]?.activeMediaId, "design:copy-b");
  assert.deepEqual(copy.referenceAssetIds, ["asset:copy-a"]);
  assert.equal(copy.canvas.nodes[1]?.assetId, "asset:copy-a");
});

test("duplicate rolls back preparation if source CAS becomes stale", async (t) => {
  const root = await temporaryRoot(t);
  let id = 0;
  let rolledBack = 0;
  let store: DesignProjectStore;
  const duplicatePort: DesignProjectDuplicatePort = {
    async prepareDuplicate({ source }) {
      await store.rename({
        id: source.id,
        expectedRevision: source.revision,
        title: "Changed concurrently",
      });
      return {
        targetChatId: "chat:copy",
        artifactMediaIds: [],
        referenceAssetIds: [],
        async rollback() {
          rolledBack += 1;
        },
      };
    },
  };
  store = new DesignProjectStore({
    root: () => root,
    now: () => 10,
    mintProjectId: () => `project:${++id}`,
    duplicatePort,
  });
  await store.initialize();
  const source = await store.create({
    chatId: "chat:source",
    title: "Empty",
    connectionState: "prototype-only",
  });
  await assert.rejects(
    store.duplicate({ id: source.id, expectedRevision: source.revision }),
    DesignProjectRevisionConflictError,
  );
  assert.equal(rolledBack, 1);
  assert.equal((await store.list()).length, 1);
});

test("duplicate preserves prepared backing data when an installed row reports failure", async (t) => {
  const root = await temporaryRoot(t);
  let failPublication = false;
  let rolledBack = 0;
  let id = 0;
  const duplicatePort: DesignProjectDuplicatePort = {
    async prepareDuplicate() {
      return {
        targetChatId: "chat:ambiguous-copy",
        artifactMediaIds: [],
        referenceAssetIds: [],
        async rollback() {
          rolledBack += 1;
        },
      };
    },
  };
  const store = new DesignProjectStore({
    dataStore: failpointProjectDataStore(root, async () => {
      if (!failPublication) return;
      failPublication = false;
      throw new Error("injected directory sync failure");
    }),
    now: () => 10,
    mintProjectId: () => `project:${++id}`,
    duplicatePort,
  });
  await store.initialize();
  const source = await store.create({
    chatId: "chat:ambiguous-source",
    title: "Ambiguous source",
    connectionState: "prototype-only",
  });
  failPublication = true;

  await assert.rejects(
    store.duplicate({ id: source.id, expectedRevision: source.revision }),
    DesignProjectPublicationUncertainError,
  );

  assert.equal(rolledBack, 0);
  assert.equal((await store.getByChatId("chat:ambiguous-copy"))?.title, "Ambiguous source Copy");
});

test("duplicate does not roll back preparation when publication cannot be classified", async (t) => {
  const root = await temporaryRoot(t);
  let corruptPublication = false;
  let rolledBack = 0;
  let id = 0;
  const duplicatePort: DesignProjectDuplicatePort = {
    async prepareDuplicate() {
      return {
        targetChatId: "chat:uncertain-copy",
        artifactMediaIds: [],
        referenceAssetIds: [],
        async rollback() {
          rolledBack += 1;
        },
      };
    },
  };
  const store = new DesignProjectStore({
    dataStore: failpointProjectDataStore(root, async () => {
      if (!corruptPublication) return;
      await writeFile(join(root, "design-projects.json"), "{not-json", "utf8");
      throw new Error("injected unreadable publication");
    }),
    now: () => 10,
    mintProjectId: () => `project:${++id}`,
    duplicatePort,
  });
  await store.initialize();
  const source = await store.create({
    chatId: "chat:uncertain-source",
    title: "Uncertain source",
    connectionState: "prototype-only",
  });
  corruptPublication = true;

  await assert.rejects(
    store.duplicate({ id: source.id, expectedRevision: source.revision }),
    DesignProjectPublicationUncertainError,
  );
  assert.equal(rolledBack, 0);
});

test("delete plans the whole lineage and rejects stale CAS", async (t) => {
  const root = await temporaryRoot(t);
  let id = 0;
  const store = new DesignProjectStore({
    root: () => root,
    now: () => 10,
    mintProjectId: () => `project:${++id}`,
    cascadePlanner: {
      async inspect() {
        return {
          commentIds: ["comment:b", "comment:a"],
          designerActionIds: ["action:a"],
        };
      },
    },
  });
  await store.initialize();
  const project = await store.create({
    chatId: "chat:one",
    title: "Checkout",
    connectionState: "prototype-only",
    canvas: canvas(),
    referenceAssetIds: ["asset:reference-a"],
  });
  await store.create({
    chatId: "chat:two",
    title: "Shared reference",
    connectionState: "prototype-only",
    canvas: {
      viewport: "desktop",
      flowViewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: "node:shared-reference",
          kind: "reference-image",
          canonicalOrigin: "reference-asset",
          assetId: "asset:reference-a",
          x: 0,
          y: 0,
        },
      ],
    },
    referenceAssetIds: ["asset:reference-a"],
  });
  const plan = await store.planDelete({ id: project.id, expectedRevision: 1 });
  assert.deepEqual(plan.artifactMediaIds, ["design:checkout-a", "design:checkout-b"]);
  assert.deepEqual(plan.detachedReferenceAssetIds, ["asset:reference-a"]);
  assert.deepEqual(plan.unreferencedReferenceAssetIds, []);
  assert.deepEqual(plan.commentIds, ["comment:a", "comment:b"]);

  const renamed = await store.rename({
    id: project.id,
    expectedRevision: 1,
    title: "New",
  });
  await assert.rejects(store.delete(plan), DesignProjectRevisionConflictError);
  const staleDatabasePlan = await store.planDelete({
    id: project.id,
    expectedRevision: renamed.revision,
  });
  await store.create({
    chatId: "chat:three",
    title: "Concurrent project",
    connectionState: "prototype-only",
  });
  await assert.rejects(store.delete(staleDatabasePlan), DesignProjectConflictError);
  const currentPlan = await store.planDelete({
    id: project.id,
    expectedRevision: renamed.revision,
  });
  const receipt = await store.delete(currentPlan);
  assert.equal(receipt.projectId, project.id);
  assert.equal(await store.get(project.id), undefined);
});

test("delete reconciliation reloads a post-publication disk snapshot instead of trusting its cached predecessor", async (t) => {
  const root = await temporaryRoot(t);
  let failPublication = false;
  const store = new DesignProjectStore({
    dataStore: failpointProjectDataStore(root, async () => {
      if (!failPublication) return;
      failPublication = false;
      throw new Error("injected directory sync failure");
    }),
    mintProjectId: () => "project:ambiguous-delete",
    now: () => 10,
  });
  await store.initialize();
  const project = await store.create({
    chatId: "chat:ambiguous-delete",
    title: "Ambiguous delete",
    connectionState: "prototype-only",
  });
  const plan = await store.planDelete({
    id: project.id,
    expectedRevision: project.revision,
  });
  assert.equal(await store.reconcileDeletePublication(plan), "present");
  failPublication = true;

  await assert.rejects(store.delete(plan), /injected directory sync failure/u);
  assert.equal((await store.get(project.id))?.id, project.id);
  const disk = parseDesignProjectDatabaseV2(
    JSON.parse(await readFile(join(root, "design-projects.json"), "utf8")),
  );
  assert.equal(disk?.revision, plan.expectedDatabaseRevision + 1);
  assert.equal(
    disk?.projects.some(({ id }) => id === project.id),
    false,
  );

  assert.equal(await store.reconcileDeletePublication(plan), "deleted");
  assert.equal(await store.get(project.id), undefined);
});

test("a main-store restart restores 20 artboards, 10 hydrated references, preview configuration, and repair health", async (t) => {
  const root = await temporaryRoot(t);
  const workspaceRoot = join(root, "connected-workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, "package.json"),
    JSON.stringify({ scripts: { dev: "vite" } }),
    "utf8",
  );
  const chatId = "chat:restart-proof";
  const artifacts = new GenerativeUiArtifactStore({
    root: () => root,
    now: () => 122,
  });
  const references = new DesignReferenceAssetStore({
    root: () => root,
    now: () => 122,
  });
  await artifacts.initialize();
  await references.initialize();
  const referenceRecords = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      references.put({
        name: `reference-${index}.png`,
        mimeType: "image/png",
        bytes: referencePng(index),
      }),
    ),
  );
  const mediaIds: string[] = [];
  for (let index = 0; index < 20; index += 1) {
    for (const revision of ["a", "b"] as const) {
      const mediaId = `design:revision-${index}-${revision}`;
      const html = `<!doctype html><html><body><main data-index="${index}" data-revision="${revision}">Artboard ${index}</main></body></html>`;
      await artifacts.stage({
        chatId,
        generationId: `generation:${index}:${revision}`,
        model: "acceptance-model",
        artifact: htmlArtifact(mediaId, html, `Artboard ${index}`),
        html,
      });
      mediaIds.push(mediaId);
    }
  }
  await artifacts.commit(chatId, mediaIds);
  const exactCanvas = {
    viewport: "phone" as const,
    flowViewport: { x: -431.25, y: 208.5, zoom: 0.625 },
    nodes: [
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `node:artboard-${index}`,
        kind: "artboard" as const,
        canonicalOrigin: "generated-artifact" as const,
        lineageId: `lineage:${index}`,
        artifactMediaIds: [`design:revision-${index}-a`, `design:revision-${index}-b`],
        activeMediaId: `design:revision-${index}-b`,
        x: index * 411.5 - 2_000,
        y: (index % 4) * 287.25 - 500,
      })),
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `node:reference-${index}`,
        kind: "reference-image" as const,
        canonicalOrigin: "reference-asset" as const,
        assetId: referenceRecords[index]!.id,
        x: index * 173.75,
        y: 1_250 + index * 19.5,
      })),
      {
        id: "source-preview:workspace-restart-proof",
        kind: "source-preview" as const,
        canonicalOrigin: "connected-app" as const,
        x: -2_700,
        y: -500,
      },
    ],
  };
  const first = new DesignProjectStore({
    root: () => root,
    now: () => 123,
    mintProjectId: () => "project:restart-proof",
  });
  await first.initialize();
  const created = await first.create({
    chatId,
    title: "Restart proof",
    connectionState: "connected",
    workspaceId: "workspace-restart-proof",
    previewScriptId: "dev",
    canvas: exactCanvas,
    referenceAssetIds: referenceRecords.map(({ id }) => id),
  });

  // Fresh instances model a lost renderer and main process reading only atomic disk state.
  const restarted = new DesignProjectStore({
    root: () => root,
    now: () => 999,
  });
  const restartedArtifacts = new GenerativeUiArtifactStore({
    root: () => root,
  });
  const restartedReferences = new DesignReferenceAssetStore({
    root: () => root,
  });
  await restarted.initialize();
  await restartedArtifacts.initialize();
  await restartedReferences.initialize();
  const restored = await restarted.get(created.id);
  assert.ok(restored);
  assert.deepEqual(restored?.canvas, created.canvas);
  assert.deepEqual(restored?.referenceAssetIds, created.referenceAssetIds);
  assert.equal(restored?.revision, created.revision);
  assert.equal(restored?.previewScriptId, "dev");
  assert.deepEqual(
    await Promise.all(
      referenceRecords.map(async ({ id }, index) => ({
        id,
        bytes: (await restartedReferences.read(id))?.bytes,
        expected: referencePng(index),
      })),
    ).then((values) =>
      values.map(({ id, bytes, expected }) => ({
        id,
        hydrated: bytes?.equals(expected),
      })),
    ),
    referenceRecords.map(({ id }) => ({ id, hydrated: true })),
  );
  for (const mediaId of mediaIds) {
    assert.ok(await restartedArtifacts.committedSourceFor(chatId, mediaId));
  }
  assert.deepEqual(
    await inspectDesignProjectHealth(restored, {
      hasReferenceAsset: async (assetId) => Boolean(await restartedReferences.read(assetId)),
      artifactSource: (ownedChatId, mediaId) =>
        restartedArtifacts.committedSourceFor(ownedChatId, mediaId),
    }),
    { health: "ready" },
  );

  const restartedPreview = new SourceDesignPreviewService();
  const previewState = await restartedPreview.state(
    {
      id: 1,
      documentId: "renderer-after-restart",
      isDestroyed: () => false,
      send: () => undefined,
      onInvalidated: () => () => undefined,
    },
    restored.id,
    workspaceRoot,
  );
  assert.equal(previewState.status, "ready", "saved configuration never restores a process");
  if (previewState.status === "ready") {
    assert.equal(
      previewState.scripts.some(({ id }) => id === restored.previewScriptId),
      true,
    );
  }
  assert.equal("sessionId" in previewState, false);
  assert.equal("capability" in previewState, false);
  assert.equal("src" in previewState, false);

  await restartedReferences.deleteUnreferencedCandidates(
    [referenceRecords[0]!.id],
    new Set(referenceRecords.slice(1).map(({ id }) => id)),
  );
  assert.deepEqual(
    await inspectDesignProjectHealth(restored, {
      hasReferenceAsset: async (assetId) => Boolean(await restartedReferences.read(assetId)),
      artifactSource: (ownedChatId, mediaId) =>
        restartedArtifacts.committedSourceFor(ownedChatId, mediaId),
    }),
    {
      health: "needs-repair",
      recoveryMessage: "A saved reference image is missing. Open the project to remove it safely.",
      recoveryAction: "open-project",
    },
  );
});

function legacyFacts(overrides: Partial<LegacyDesignChatFacts> = {}): LegacyDesignChatFacts {
  return {
    chatId: "chat:legacy",
    title: "Legacy checkout",
    connectionState: "prototype-only",
    createdAt: 10,
    updatedAt: 20,
    isDesignChat: true,
    artifactState: "available",
    committedArtifacts: [
      { mediaId: "design:checkout-a" },
      { mediaId: "design:checkout-b" },
      { mediaId: "design:settings-a" },
    ],
    ...overrides,
  };
}

test("legacy migration is lazy, deterministic, concurrent-safe, and idempotent", async (t) => {
  const root = await temporaryRoot(t);
  let loads = 0;
  const store = new DesignProjectStore({
    root: () => root,
    legacySource: {
      async loadDesignChatFacts() {
        loads += 1;
        await Promise.resolve();
        return legacyFacts();
      },
    },
  });
  await store.initialize();
  const [first, concurrent] = await Promise.all([
    store.getOrMigrateLegacyChat("chat:legacy"),
    store.getOrMigrateLegacyChat("chat:legacy"),
  ]);
  assert.ok(first);
  assert.deepEqual(concurrent, first);
  assert.equal((await store.list()).length, 1);
  assert.equal(first.id.startsWith("project:"), true);
  assert.deepEqual(first.canvas.nodes[0]?.artifactMediaIds, ["design:checkout-a"]);
  assert.equal(first.canvas.nodes[0]?.activeMediaId, "design:checkout-a");
  assert.equal(first.canvas.nodes[0]?.lineageId?.startsWith("lineage:"), true);
  assert.equal(first.canvas.nodes[1]?.x, 1_320);

  const again = await store.getOrMigrateLegacyChat("chat:legacy");
  assert.deepEqual(again, first);
  assert.ok(loads === 1 || loads === 2, "parallel first opens may both read, but install once");
});

test("legacy migration fails closed on corrupt artifacts and does not seed a project", async (t) => {
  const root = await temporaryRoot(t);
  const store = new DesignProjectStore({
    root: () => root,
    legacySource: {
      async loadDesignChatFacts() {
        return legacyFacts({ artifactState: "corrupt" });
      },
    },
  });
  await store.initialize();
  await assert.rejects(
    store.getOrMigrateLegacyChat("chat:legacy"),
    DesignProjectMigrationBlockedError,
  );
  assert.deepEqual(await store.list(), []);
});

test("deleted legacy chats do not create projects", async (t) => {
  const root = await temporaryRoot(t);
  const store = new DesignProjectStore({
    root: () => root,
    legacySource: {
      async loadDesignChatFacts() {
        return undefined;
      },
    },
  });
  await store.initialize();
  assert.equal(await store.getOrMigrateLegacyChat("chat:deleted"), undefined);
  assert.deepEqual(await store.list(), []);
});

test("named migration fixtures have one explicit deterministic outcome", async (t) => {
  await t.test("generated-only-chat", async (t) => {
    const root = await temporaryRoot(t);
    const store = new DesignProjectStore({
      root: () => root,
      legacySource: {
        async loadDesignChatFacts() {
          return legacyFacts({
            chatId: "chat:fixture-generated",
            committedArtifacts: [{ mediaId: "design:fixture-generated" }],
          });
        },
      },
    });
    await store.initialize();
    const migrated = await store.getOrMigrateLegacyChat("chat:fixture-generated");
    assert.equal(migrated?.connectionState, "prototype-only");
    assert.deepEqual(
      migrated?.canvas.nodes.map(({ canonicalOrigin }) => canonicalOrigin),
      ["generated-artifact"],
    );
  });

  await t.test("mixed-generated-source-project", async (t) => {
    const root = await temporaryRoot(t);
    const store = new DesignProjectStore({
      root: () => root,
      legacySource: {
        async loadDesignChatFacts() {
          return legacyFacts({
            chatId: "chat:fixture-mixed",
            connectionState: "connected",
            workspaceId: "workspace:fixture-mixed",
            committedArtifacts: [{ mediaId: "design:fixture-mixed" }],
          });
        },
      },
    });
    await store.initialize();
    const migrated = await store.getOrMigrateLegacyChat("chat:fixture-mixed");
    assert.ok(migrated);
    const mixed = await store.setPreviewScript({
      id: migrated.id,
      expectedRevision: migrated.revision,
      previewScriptId: "dev",
    });
    assert.deepEqual(mixed.canvas.nodes.map(({ canonicalOrigin }) => canonicalOrigin).sort(), [
      "connected-app",
      "generated-artifact",
    ]);
    assert.equal(mixed.previewScriptId, "dev");
    assert.equal(
      mixed.canvas.nodes.find(({ kind }) => kind === "source-preview")?.id,
      "source-preview:workspace:fixture-mixed",
    );
  });

  await t.test("copied-chat", async (t) => {
    const root = await temporaryRoot(t);
    const store = new DesignProjectStore({
      root: () => root,
      legacySource: {
        async loadDesignChatFacts(chatId) {
          return legacyFacts({
            chatId,
            title: "Copied checkout",
            committedArtifacts: [{ mediaId: "design:fixture-copy" }],
          });
        },
      },
    });
    await store.initialize();
    const first = await store.getOrMigrateLegacyChat("chat:fixture-copy");
    const restarted = new DesignProjectStore({ root: () => root });
    await restarted.initialize();
    assert.deepEqual(await restarted.getOrMigrateLegacyChat("chat:fixture-copy"), first);
  });

  await t.test("deleted-chat", async (t) => {
    const root = await temporaryRoot(t);
    const store = new DesignProjectStore({
      root: () => root,
      legacySource: {
        async loadDesignChatFacts() {
          return undefined;
        },
      },
    });
    await store.initialize();
    assert.equal(await store.getOrMigrateLegacyChat("chat:fixture-deleted"), undefined);
    assert.deepEqual(await store.list(), []);
  });

  await t.test("corrupt-artifact-store", async (t) => {
    const root = await temporaryRoot(t);
    const store = new DesignProjectStore({
      root: () => root,
      legacySource: {
        async loadDesignChatFacts() {
          return legacyFacts({
            chatId: "chat:fixture-corrupt",
            artifactState: "corrupt",
          });
        },
      },
    });
    await store.initialize();
    await assert.rejects(
      store.getOrMigrateLegacyChat("chat:fixture-corrupt"),
      DesignProjectMigrationBlockedError,
    );
    assert.deepEqual(await store.list(), []);
  });

  await t.test("interrupted-first-read", async (t) => {
    const root = await temporaryRoot(t);
    let interrupted = true;
    const source = {
      async loadDesignChatFacts() {
        if (interrupted) {
          interrupted = false;
          throw new Error("simulated migration interruption");
        }
        return legacyFacts({
          chatId: "chat:fixture-interrupted",
          committedArtifacts: [{ mediaId: "design:fixture-interrupted" }],
        });
      },
    };
    const first = new DesignProjectStore({
      root: () => root,
      legacySource: source,
    });
    await first.initialize();
    await assert.rejects(
      first.getOrMigrateLegacyChat("chat:fixture-interrupted"),
      /simulated migration interruption/u,
    );
    assert.deepEqual(await first.list(), []);

    const restarted = new DesignProjectStore({
      root: () => root,
      legacySource: source,
    });
    await restarted.initialize();
    const migrated = await restarted.getOrMigrateLegacyChat("chat:fixture-interrupted");
    assert.equal(migrated?.chatId, "chat:fixture-interrupted");
    assert.equal((await restarted.list()).length, 1);
  });
});

test("corrupt and unsafe stores stay unavailable without overwriting original bytes", async (t) => {
  for (const [name, contents] of [
    ["corrupt", "{not-json"],
    ["unsafe", JSON.stringify({ version: 1, revision: 0, projects: [], extra: true })],
    ["future", JSON.stringify({ version: 3, revision: 0, projects: [] })],
  ] as const) {
    await t.test(name, async (t) => {
      const root = await temporaryRoot(t);
      const file = join(root, "design-projects.json");
      await writeFile(file, contents, "utf8");
      const store = new DesignProjectStore({ root: () => root });
      await store.initialize();
      assert.equal(store.availability().available, false);
      await assert.rejects(
        store.create({
          chatId: "chat:one",
          title: "One",
          connectionState: "prototype-only",
        }),
        DesignProjectUnavailableError,
      );
      assert.equal(await readFile(file, "utf8"), contents);
    });
  }
});

test("generation intent and partial direction sets survive restart, retries are bounded and atomic", async t => {
  const root=await temporaryRoot(t);
  const store=new DesignProjectStore({root:()=>root}); await store.initialize();
  let project=await store.create({chatId:"chat:directions",title:"Directions",connectionState:"prototype-only"});
  const request={version:1,operation:"explore",count:2,creativeRange:"balanced",aspects:["layout"]} as const;
  const begin=()=>store.beginGeneration({projectId:project.id,expectedRevision:project.revision,turnId:"turn:one",request:{...request,aspects:[...request.aspects]}});
  project=await begin();
  assert.equal(project.canvas.nodes.length,0);
  const unchanged=await begin(); assert.equal(unchanged.revision,project.revision);
  const intent=project.generationIntents![0]!;
  const revision={mediaId:"design:direction-one",ownership:{version:1,kind:"new-artboard",projectId:project.id,lineageId:"lineage:direction-one",generationIntentId:intent.id}} as const;
  project=await store.publishGeneratedRevisions({projectId:project.id,chatId:project.chatId,revisions:[revision]});
  assert.equal(project.directionSets![0]!.status,"partial");
  const restarted=new DesignProjectStore({root:()=>root}); await restarted.initialize();
  assert.deepEqual(await restarted.get(project.id),project);
  const idempotent=await restarted.publishGeneratedRevisions({projectId:project.id,chatId:project.chatId,revisions:[revision]});
  assert.equal(idempotent.revision,project.revision);
  project=await restarted.beginGeneration({projectId:project.id,expectedRevision:project.revision,turnId:"turn:retry",request:{...request,aspects:[...request.aspects],retryDirectionSetId:intent.directionSetId}});
  const retry=project.generationIntents![1]!;
  project=await restarted.publishGeneratedRevisions({projectId:project.id,chatId:project.chatId,revisions:[{mediaId:"design:direction-two",ownership:{...revision.ownership,lineageId:"lineage:direction-two",generationIntentId:retry.id}}]});
  assert.equal(project.directionSets![0]!.actualCount,2);
  assert.equal(project.directionSets![0]!.status,"complete");
  await assert.rejects(restarted.publishGeneratedRevisions({projectId:project.id,chatId:project.chatId,revisions:[{mediaId:"design:direction-three",ownership:{...revision.ownership,lineageId:"lineage:direction-three",generationIntentId:retry.id}}]}),DesignProjectConflictError);
  project=await restarted.chooseDirection({projectId:project.id,expectedRevision:project.revision,directionSetId:intent.directionSetId!,member:{lineageId:revision.ownership.lineageId,mediaId:revision.mediaId}});
  await assert.rejects(restarted.archiveDirectionSet({projectId:project.id,expectedRevision:project.revision-1,directionSetId:intent.directionSetId!,archived:true}),DesignProjectRevisionConflictError);
  project=await restarted.archiveDirectionSet({projectId:project.id,expectedRevision:project.revision,directionSetId:intent.directionSetId!,archived:true});
  assert.equal(project.directionSets![0]!.archived,true);
});

test("historical refine records exact base and compares captured current revision", async t=>{
  const root=await temporaryRoot(t);const store=new DesignProjectStore({root:()=>root});await store.initialize();
  let project=await store.create({chatId:"chat:historical",title:"Historical",connectionState:"prototype-only",canvas:canvas(),referenceAssetIds:["asset:reference-a"]});
  await assert.rejects(store.beginGeneration({projectId:project.id,expectedRevision:project.revision,turnId:"turn:bad",request:{version:1,operation:"refine",base:{lineageId:"lineage:checkout",mediaId:"design:missing"}}}),DesignProjectRevisionConflictError);
  project=await store.beginGeneration({projectId:project.id,expectedRevision:project.revision,turnId:"turn:historical",request:{version:1,operation:"refine",base:{lineageId:"lineage:checkout",mediaId:"design:checkout-a"}}});
  const intent=project.generationIntents![0]!;assert.equal(intent.expectedCurrentMediaId,"design:checkout-b");
  project=await store.publishGeneratedRevisions({projectId:project.id,chatId:project.chatId,revisions:[{mediaId:"design:checkout-c",ownership:{version:1,kind:"revision",projectId:project.id,lineageId:"lineage:checkout",baseMediaId:"design:checkout-a",generationIntentId:intent.id}}]});
  assert.equal(project.canvas.nodes[0]!.activeMediaId,"design:checkout-c");
  await assert.rejects(store.publishGeneratedRevisions({projectId:project.id,chatId:project.chatId,revisions:[{mediaId:"design:checkout-d",ownership:{version:1,kind:"revision",projectId:project.id,lineageId:"lineage:checkout",baseMediaId:"design:checkout-a",generationIntentId:intent.id}}]}),DesignProjectRevisionConflictError);
});

test("generation reconciliation prunes only absent unpublished intents after restart", async t => {
  const root = await temporaryRoot(t);
  let store = new DesignProjectStore({ root: () => root });
  await store.initialize();
  let project = await store.create({ chatId: "chat:reconcile", title: "Reconcile", connectionState: "prototype-only", canvas: canvas(), referenceAssetIds: ["asset:reference-a"] });
  const request = { version: 1, operation: "explore", count: 2, creativeRange: "balanced", aspects: [] } as const;
  const begin = async (turnId: string, retryDirectionSetId?: string) => {
    project = await store.beginGeneration({ projectId: project.id, expectedRevision: project.revision, turnId, request: { ...request, aspects: [], ...(retryDirectionSetId ? { retryDirectionSetId } : {}) } });
    return project.generationIntents![project.generationIntents!.length - 1]!;
  };
  await begin("turn:absent");
  await begin("turn:present");
  const source = await begin("turn:source-absent");
  await begin("turn:retry-present", source.directionSetId);
  const partial = await begin("turn:partial-absent");
  project = await store.publishGeneratedRevisions({ projectId: project.id, chatId: project.chatId, revisions: [{ mediaId: "design:partial", ownership: { version: 1, kind: "new-artboard", projectId: project.id, lineageId: "lineage:partial", generationIntentId: partial.id } }] });
  project = await store.beginGeneration({ projectId: project.id, expectedRevision: project.revision, turnId: "turn:refine-absent", request: { version: 1, operation: "refine", base: { lineageId: "lineage:checkout", mediaId: "design:checkout-b" } } });
  project = await store.beginGeneration({ projectId: project.id, expectedRevision: project.revision, turnId: "turn:refine-published", request: { version: 1, operation: "refine", base: { lineageId: "lineage:checkout", mediaId: "design:checkout-b" } } });
  const refine = project.generationIntents![project.generationIntents!.length - 1]!;
  project = await store.publishGeneratedRevisions({ projectId: project.id, chatId: project.chatId, revisions: [{ mediaId: "design:refined", ownership: { version: 1, kind: "revision", projectId: project.id, lineageId: "lineage:checkout", baseMediaId: "design:checkout-b", generationIntentId: refine.id } }] });
  store = new DesignProjectStore({ root: () => root });
  await store.initialize();
  assert.deepEqual(await store.get(project.id), project);
  const persistedUserMessageIds = ["turn:present", "turn:retry-present"];
  project = await store.reconcileGenerationIntents({ projectId: project.id, persistedUserMessageIds });
  assert.deepEqual(project.generationIntents!.map(intent => intent.turnId), ["turn:present", "turn:source-absent", "turn:retry-present", "turn:partial-absent", "turn:refine-published"]);
  assert.equal(project.directionSets!.length, 3);
  assert.equal(project.directionSets!.find(set => set.id === partial.directionSetId)!.actualCount, 1);
  assert.equal(project.canvas.nodes.find(node => node.lineageId === "lineage:checkout")!.activeMediaId, "design:refined");
  const unchanged = await store.reconcileGenerationIntents({ projectId: project.id, persistedUserMessageIds });
  assert.equal(unchanged.revision, project.revision);
  const restarted = new DesignProjectStore({ root: () => root });
  await restarted.initialize();
  assert.deepEqual(await restarted.get(project.id), project);
  // Once the retry is absent too, its empty source/set can be removed together.
  const cleaned = await restarted.reconcileGenerationIntents({ projectId: project.id, persistedUserMessageIds: ["turn:present"] });
  assert.equal(cleaned.generationIntents!.some(intent => intent.id === source.id), false);
  assert.equal(cleaned.directionSets!.some(set => set.id === source.directionSetId), false);
});

test("generation reconciliation retains legacy publication uncertainty", async t => {
  const root = await temporaryRoot(t);
  const store = new DesignProjectStore({ root: () => root });
  await store.initialize();
  let project = await store.create({ chatId: "chat:legacy-intent", title: "Legacy", connectionState: "prototype-only" });
  project = await store.beginGeneration({ projectId: project.id, expectedRevision: project.revision, turnId: "turn:legacy", request: { version: 1, operation: "explore", count: 2, creativeRange: "close", aspects: [] } });
  const filename = join(root, "design-projects.json");
  const database = JSON.parse(await readFile(filename, "utf8"));
  delete database.projects[0].generationIntents[0].published;
  await writeFile(filename, JSON.stringify(database));
  const restarted = new DesignProjectStore({ root: () => root });
  await restarted.initialize();
  const retained = await restarted.reconcileGenerationIntents({ projectId: project.id, persistedUserMessageIds: [] });
  assert.equal(retained.generationIntents!.length, 1);
  assert.equal(retained.directionSets!.length, 1);
  assert.equal(retained.revision, project.revision);
});

test("Design Language history is immutable and exact binding fences publication", async t => {
  const root = await temporaryRoot(t);
  const store = new DesignProjectStore({ root: () => root }); await store.initialize();
  let project = await store.create({chatId:"chat:language",title:"Language",connectionState:"prototype-only"});
  const document = {version:1 as const,name:"Language",guidance:"Use clear hierarchy.",tokens:{colors:{text:"#000000"},spacing:{},typography:{},radii:{}}};
  project = await store.saveDesignLanguage({projectId:project.id,expectedRevision:project.revision,document,provenance:{kind:"authored"}});
  const original = structuredClone(project.designLanguages![0]!);
  assert.equal(project.activeDesignLanguage,undefined);
  project = await store.applyDesignLanguage({projectId:project.id,expectedRevision:project.revision,languageId:original.id});
  project = await store.beginGeneration({projectId:project.id,expectedRevision:project.revision,turnId:"turn:language",request:{version:1,operation:"explore",count:2,creativeRange:"close",aspects:[]}});
  const intent=project.generationIntents![0]!;
  assert.deepEqual(intent.designLanguage,project.activeDesignLanguage);
  project=await store.saveDesignLanguage({projectId:project.id,expectedRevision:project.revision,document:{...document,name:"Next",tokens:{...document.tokens,colors:{text:"#ffffff"}}},provenance:{kind:"authored"}});
  assert.deepEqual(project.designLanguages![0],original);
  assert.equal(project.activeDesignLanguage!.id,original.id);
  project=await store.applyDesignLanguage({projectId:project.id,expectedRevision:project.revision,languageId:project.designLanguages![1]!.id});
  const revisions=[{mediaId:"design:language",ownership:{version:1 as const,kind:"new-artboard" as const,projectId:project.id,lineageId:"lineage:language",generationIntentId:intent.id}}];
  await assert.rejects(store.publishGeneratedRevisions({projectId:project.id,chatId:project.chatId,revisions}),/Design Language changed/);
  assert.equal((await store.get(project.id))!.canvas.nodes.length,0);
  project=await store.applyDesignLanguage({projectId:project.id,expectedRevision:project.revision,languageId:original.id});
  project=await store.publishGeneratedRevisions({projectId:project.id,chatId:project.chatId,revisions});
  project=await store.detachDesignLanguage({projectId:project.id,expectedRevision:project.revision});
  assert.equal(project.activeDesignLanguage,undefined);
  assert.equal((await store.publishGeneratedRevisions({projectId:project.id,chatId:project.chatId,revisions})).revision,project.revision);
  assert.deepEqual(project.designLanguages![0],original);
  await assert.rejects(store.applyDesignLanguage({projectId:project.id,expectedRevision:project.revision-1,languageId:original.id}),DesignProjectRevisionConflictError);
  const restarted=new DesignProjectStore({root:()=>root});await restarted.initialize();assert.deepEqual(await restarted.get(project.id),project);
});


test("duplicate retains stale workspace Design Language provenance after workspace refresh", async t => {
  const root = await temporaryRoot(t);
  let sequence = 0;
  const store = new DesignProjectStore({root:()=>root,mintProjectId:()=>`project:workspace-copy-${++sequence}`,duplicatePort:{
    async prepareDuplicate() { return {targetChatId:"chat:workspace-copy",artifactMediaIds:[],referenceAssetIds:[],async rollback(){assert.fail("successful duplicate should not roll back");}}; },
  }});
  await store.initialize();
  let source = await store.create({chatId:"chat:workspace-source",title:"Workspace",connectionState:"connected",workspaceId:"workspace:one",designSystemBinding:{id:"snapshot:one",revision:1}});
  const document = {version:1 as const,name:"Workspace language",guidance:"Use clear hierarchy.",tokens:{colors:{},spacing:{},typography:{},radii:{}}};
  const provenance = {kind:"workspace-snapshot" as const,id:"snapshot:one",revision:1,contentHash:"a".repeat(64)};
  source = await store.saveDesignLanguage({projectId:source.id,expectedRevision:source.revision,document,provenance});
  const workspaceLanguageId = source.designLanguages![0]!.id;
  source = await store.applyDesignLanguage({projectId:source.id,expectedRevision:source.revision,languageId:workspaceLanguageId});
  source = await store.saveDesignLanguage({projectId:source.id,expectedRevision:source.revision,document:{...document,name:"Authored"},provenance:{kind:"authored"}});
  source = await store.saveDesignLanguage({projectId:source.id,expectedRevision:source.revision,document:{...document,name:"Imported"},provenance:{kind:"imported"}});
  source = await store.setDesignSystemBinding({id:source.id,expectedRevision:source.revision,binding:{id:"snapshot:one",revision:2}});
  const copy = await store.duplicate({id:source.id,expectedRevision:source.revision});
  assert.deepEqual(copy.designSystemBinding,{id:"snapshot:one",revision:2});
  assert.deepEqual(copy.designLanguages!.map(language=>language.provenance),[provenance,{kind:"authored"},{kind:"imported"}]);
  assert.equal(copy.activeDesignLanguage!.id,copy.designLanguages![0]!.id);
  assert.notEqual(copy.activeDesignLanguage!.id,workspaceLanguageId);
  const {currentDesignLanguageModelContext} = await import("./design-language-service.js");
  const current = {id:"snapshot:one",revision:2,contentHash:"b".repeat(64)} as import("./design-system-snapshot-core.js").DesignSystemSnapshotV1;
  await assert.rejects(currentDesignLanguageModelContext(copy,"/workspace",undefined,{currentWorkspaceSnapshot:async()=>current}),/stale workspace/);
});

test("duplicate fails closed when a derived language source cannot be remapped", async t => {
  const root = await temporaryRoot(t);
  let sequence = 0;
  let rolledBack = false;
  const store = new DesignProjectStore({root:()=>root,mintProjectId:()=>`project:missing-copy-${++sequence}`,duplicatePort:{
    async prepareDuplicate() {return {targetChatId:"chat:missing-copy",artifactMediaIds:[{from:"design:checkout-b",to:"design:copy-b"}],referenceAssetIds:[{from:"asset:reference-a",to:"asset:copy-a"}],async rollback(){rolledBack=true;}};},
  }});
  await store.initialize();
  let source=await store.create({chatId:"chat:missing-source",title:"Missing",connectionState:"prototype-only",canvas:canvas(),referenceAssetIds:["asset:reference-a"]});
  const provenance={kind:"derived" as const,lineageId:"lineage:checkout",mediaId:"design:checkout-a",contentHash:"a".repeat(64)};
  source=await store.saveDesignLanguage({projectId:source.id,expectedRevision:source.revision,document:{version:1,name:"Derived",guidance:"",tokens:{colors:{},spacing:{},typography:{},radii:{}}},provenance});
  source=await store.removeMissingGeneratedRevision({projectId:source.id,expectedRevision:source.revision,lineageId:"lineage:checkout",missingMediaId:"design:checkout-a",expectedActiveMediaId:"design:checkout-b"});
  await assert.rejects(store.duplicate({id:source.id,expectedRevision:source.revision}),/unavailable derived source/);
  assert.equal(rolledBack,true);
  assert.deepEqual((await store.get(source.id))!.designLanguages![0]!.provenance,provenance);
  assert.equal(await store.getByChatId("chat:missing-copy"),undefined);
});
