import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DesignReferenceAssetStore,
  MAX_DESIGN_REFERENCE_ASSET_BYTES,
  pruneUnreferencedDesignAssetsAtStartup,
} from "./design-reference-asset-store.js";
import { DesignReferenceRecoveryService } from "./design-reference-recovery.js";
import { DesignProjectStore } from "./design-project-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function root(): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), "aiden-design-reference-assets-"));
  roots.push(created);
  return created;
}

// 1x1 opaque PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const OTHER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==",
  "base64",
);

test("deduplicates identical bytes and survives restart without exposing base64 in descriptors", async () => {
  const directory = await root();
  const store = new DesignReferenceAssetStore({
    root: () => directory,
    now: () => 42,
  });
  await store.initialize();

  const first = await store.put({
    name: "reference.png",
    mimeType: "image/png",
    bytes: PNG,
  });
  const second = await store.put({
    name: "renamed.png",
    mimeType: "image/png",
    bytes: PNG,
  });
  assert.deepEqual(second, first);
  assert.equal(first.createdAt, 42);
  assert.equal("data" in first, false);
  assert.equal((await store.list()).length, 1);

  const restarted = new DesignReferenceAssetStore({ root: () => directory });
  await restarted.initialize();
  const read = await restarted.read(first.id);
  assert.deepEqual(read?.asset, first);
  assert.deepEqual(read?.bytes, PNG);
});

test("rejects invalid metadata, mismatched media, and oversized images", async () => {
  const store = new DesignReferenceAssetStore({
    root: () => awaitRootSyncError(),
  });
  await assert.rejects(
    store.put({ name: "x.png", mimeType: "image/png", bytes: PNG }),
    /not initialized/u,
  );

  const directory = await root();
  const initialized = new DesignReferenceAssetStore({ root: () => directory });
  await initialized.initialize();
  await assert.rejects(
    initialized.put({ name: " ../x.png", mimeType: "image/png", bytes: PNG }),
    /metadata/u,
  );
  await assert.rejects(
    initialized.put({ name: "x.jpg", mimeType: "image/jpeg", bytes: PNG }),
    /JPEG|image/u,
  );
  await assert.rejects(
    initialized.put({
      name: "large.png",
      mimeType: "image/png",
      bytes: new Uint8Array(MAX_DESIGN_REFERENCE_ASSET_BYTES + 1),
    }),
    /8 MB/u,
  );
});

test("garbage collection keeps only project-referenced content identities", async () => {
  const directory = await root();
  const store = new DesignReferenceAssetStore({ root: () => directory });
  await store.initialize();
  const kept = await store.put({
    name: "keep.png",
    mimeType: "image/png",
    bytes: PNG,
  });
  const duplicate = await store.put({
    name: "duplicate.png",
    mimeType: "image/png",
    bytes: PNG,
  });
  assert.equal(duplicate.id, kept.id);
  assert.equal(await store.collectGarbage(new Set([kept.id])), 0);
  assert.equal(await store.collectGarbage(new Set()), 1);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.collectGarbage(new Set(["../bad"])), /identity/u);
});

test("cascade cleanup removes only confirmed candidates that are still unreferenced", async () => {
  const directory = await root();
  const store = new DesignReferenceAssetStore({ root: () => directory });
  await store.initialize();
  const first = await store.put({
    name: "first.png",
    mimeType: "image/png",
    bytes: PNG,
  });
  assert.equal(await store.deleteUnreferencedCandidates([first.id], new Set([first.id])), 0);
  assert.equal((await store.list()).length, 1);
  assert.equal(await store.deleteUnreferencedCandidates([first.id], new Set()), 1);
  assert.equal(await store.deleteUnreferencedCandidates([first.id], new Set()), 0);
  await assert.rejects(store.deleteUnreferencedCandidates(["../bad"], new Set()), /identity/u);
});

test("missing reference recovery proves absence and removes the exact project reference under CAS", async () => {
  const directory = await root();
  const assets = new DesignReferenceAssetStore({ root: () => directory });
  const projects = new DesignProjectStore({ root: () => directory });
  await assets.initialize();
  await projects.initialize();
  const asset = await assets.put({
    name: "reference.png",
    mimeType: "image/png",
    bytes: PNG,
  });
  const project = await projects.create({
    chatId: "chat:reference-repair",
    title: "Reference repair",
    connectionState: "prototype-only",
    canvas: {
      viewport: "desktop",
      flowViewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: "node:missing-reference",
          kind: "reference-image",
          canonicalOrigin: "reference-asset",
          assetId: asset.id,
          x: 10,
          y: 20,
        },
      ],
    },
    referenceAssetIds: [asset.id],
  });
  const recovery = new DesignReferenceRecoveryService({ projects, assets });

  await assert.rejects(
    recovery.removeMissing({
      projectId: project.id,
      expectedRevision: project.revision,
      assetId: asset.id,
    }),
    /available again/iu,
  );

  assert.equal(await assets.collectGarbage(new Set()), 1);
  const repaired = await recovery.removeMissing({
    projectId: project.id,
    expectedRevision: project.revision,
    assetId: asset.id,
  });
  assert.equal(repaired.status, "updated");
  if (repaired.status !== "updated") return;
  assert.equal(repaired.project.revision, project.revision + 1);
  assert.deepEqual(repaired.project.referenceAssetIds, []);
  assert.deepEqual(repaired.project.canvas.nodes, []);

  assert.deepEqual(
    await recovery.removeMissing({
      projectId: project.id,
      expectedRevision: project.revision,
      assetId: asset.id,
    }),
    { status: "conflict", current: repaired.project },
  );
});

test("a concurrent reference restoration wins before missing-reference repair", async () => {
  const directory = await root();
  const assets = new DesignReferenceAssetStore({ root: () => directory });
  const projects = new DesignProjectStore({ root: () => directory });
  await assets.initialize();
  await projects.initialize();
  const asset = await assets.put({
    name: "reference.png",
    mimeType: "image/png",
    bytes: PNG,
  });
  const project = await projects.create({
    chatId: "chat:reference-restore-race",
    title: "Reference restore race",
    connectionState: "prototype-only",
    canvas: {
      viewport: "desktop",
      flowViewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: "node:restored-reference",
          kind: "reference-image",
          canonicalOrigin: "reference-asset",
          assetId: asset.id,
          x: 0,
          y: 0,
        },
      ],
    },
    referenceAssetIds: [asset.id],
  });
  assert.equal(await assets.collectGarbage(new Set()), 1);
  const recovery = new DesignReferenceRecoveryService({ projects, assets });

  // put() enters the asset writer queue synchronously. Repair must wait for it
  // and observe the restored content instead of detaching its project owner.
  const restoring = assets.put({
    name: "restored.png",
    mimeType: "image/png",
    bytes: PNG,
  });
  const repairing = recovery.removeMissing({
    projectId: project.id,
    expectedRevision: project.revision,
    assetId: asset.id,
  });

  assert.equal((await restoring).id, asset.id);
  await assert.rejects(repairing, /available again/iu);
  assert.ok(await assets.read(asset.id));
  assert.deepEqual(await projects.get(project.id), project);
});

test("startup recovery prunes only assets absent from the complete persisted project graph", async () => {
  const directory = await root();
  const store = new DesignReferenceAssetStore({ root: () => directory });
  await store.initialize();
  const shared = await store.put({
    name: "shared.png",
    mimeType: "image/png",
    bytes: PNG,
  });
  const orphan = await store.put({
    name: "orphan.png",
    mimeType: "image/png",
    bytes: OTHER_PNG,
  });
  const projects = new Map([
    ["project:one", { referenceAssetIds: [shared.id] }],
    ["project:two", { referenceAssetIds: [shared.id] }],
  ]);

  assert.deepEqual(
    await pruneUnreferencedDesignAssetsAtStartup({
      assets: store,
      projects: {
        availability: () => ({ available: true }),
        list: async () => [...projects.keys()].map((id) => ({ id })),
        get: async (id) => projects.get(id),
      },
    }),
    { status: "completed", removed: 1 },
  );
  assert.ok(await store.read(shared.id));
  assert.equal(await store.read(orphan.id), undefined);
});

test("startup recovery preserves every asset when project ownership is unavailable", async () => {
  let collected = false;
  const result = await pruneUnreferencedDesignAssetsAtStartup({
    assets: {
      async collectGarbage() {
        collected = true;
        return 0;
      },
    },
    projects: {
      availability: () => ({
        available: false,
        reason: "Project storage needs repair.",
      }),
      list: async () => [],
      get: async () => undefined,
    },
  });
  assert.deepEqual(result, {
    status: "skipped",
    reason: "Project storage needs repair.",
  });
  assert.equal(collected, false);
});

test("startup recovery aborts when it cannot prove one listed project's references", async () => {
  let collected = false;
  await assert.rejects(
    pruneUnreferencedDesignAssetsAtStartup({
      assets: {
        async collectGarbage() {
          collected = true;
          return 0;
        },
      },
      projects: {
        availability: () => ({ available: true }),
        list: async () => [{ id: "project:missing" }],
        get: async () => undefined,
      },
    }),
    /inventory changed/u,
  );
  assert.equal(collected, false);
});

test("unsafe persisted content fails closed and remains available for repair", async () => {
  const directory = await root();
  const file = path.join(directory, "design-reference-assets.json");
  await writeFile(file, JSON.stringify({ version: 1, revision: 0, records: [{ bad: true }] }), {
    mode: 0o600,
  });
  const store = new DesignReferenceAssetStore({ root: () => directory });
  await store.initialize();
  assert.deepEqual(store.availability(), {
    available: false,
    reason: "Design reference asset storage has an unsupported shape.",
  });
  await assert.rejects(store.list(), /unsupported shape/u);
  assert.match(await readFile(file, "utf8"), /"bad":true/u);
});

function awaitRootSyncError(): string {
  throw new Error("root should not resolve before initialization");
}
