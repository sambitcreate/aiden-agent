import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createStarterWorkflow } from "../../../renderer/shared/create-images/schema.js";
import {
  ContentAddressedAssetStore,
  type AssetReferenceAuthority,
  type AssetReferenceSnapshot,
} from "./asset-store-core.js";
import { CreateImagesService } from "./create-images-service.js";
import { WorkflowManifestStore } from "./workflow-manifest-store.js";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function u32(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const checksum = concat(typeBytes, data);
  return concat(u32(data.byteLength), checksum, u32(crc32(checksum)));
}

function largeStaticPng(payloadBytes = 20 * 1024 * 1024): Uint8Array {
  const header = new Uint8Array(13);
  header.set(u32(1));
  header.set(u32(1), 4);
  header[8] = 8;
  header[9] = 6;
  return concat(
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("tEXt", new Uint8Array(payloadBytes)),
    pngChunk("IDAT", Uint8Array.from([0x78, 0x9c, 0, 0, 0, 0, 0, 1])),
    pngChunk("IEND", new Uint8Array()),
  );
}

async function* imageChunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  const chunkSize = 256 * 1024;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    yield bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
  }
}

class IntegrationReferenceAuthority implements AssetReferenceAuthority {
  snapshot: AssetReferenceSnapshot = {
    epoch: "0",
    completeKinds: ["workflow", "run", "export"],
    records: [],
  };

  async withSnapshot<Result>(
    callback: (snapshot: AssetReferenceSnapshot) => Promise<Result>,
  ): Promise<Result> {
    return callback(structuredClone(this.snapshot));
  }
}

test("large content-addressed images and workflows survive restart and recovery without graph bytes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-create-images-phase-two-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const authority = new IntegrationReferenceAuthority();
  const thumbnail = largeStaticPng(0);
  const options = {
    deepValidator: {
      async validate({ descriptor }: { descriptor: { width: number; height: number } }) {
        return { width: descriptor.width, height: descriptor.height };
      },
    },
    thumbnailGenerator: {
      async generate() {
        return {
          bytes: thumbnail,
          width: 1,
          height: 1,
          mediaType: "image/png" as const,
        };
      },
    },
  };

  const largeImage = largeStaticPng();
  const firstAssets = new ContentAddressedAssetStore(root, authority, options);
  const imported = await firstAssets.ingest(imageChunks(largeImage), {
    origin: { kind: "import" },
    declaredMimeType: "image/png",
    displayName: "twenty-megabyte-reference.png",
  });
  assert.ok(imported.asset.byteLength > 20 * 1024 * 1024);
  assert.equal(Object.prototype.hasOwnProperty.call(imported.asset, "filePath"), false);

  const now = "2026-08-11T12:00:00.000Z";
  const workflow = createStarterWorkflow({
    workflowId: "durable-large-image",
    promptNodeId: "prompt-1",
    generationNodeId: "generate-1",
    outputNodeId: "output-1",
    promptEdgeId: "edge-1",
    outputEdgeId: "edge-2",
    now,
  });
  workflow.nodes.push({
    id: "image-1",
    type: "image-input",
    position: { x: 20, y: 340 },
    data: { assetId: imported.asset.assetId, label: "Large local reference" },
  });
  workflow.assetRefs = [imported.asset.assetId];
  const firstWorkflows = new WorkflowManifestStore(() => root);
  await firstWorkflows.create(workflow);
  authority.snapshot = {
    epoch: "1",
    completeKinds: ["workflow", "run", "export"],
    records: [{ kind: "workflow", id: workflow.id, assetIds: [imported.asset.assetId] }],
  };
  await firstAssets.rebuildReferenceAccounting();

  const workflowPath = path.join(root, "workflows", workflow.id, "workflow.json");
  const graphText = await fs.readFile(workflowPath, "utf8");
  assert.ok(Buffer.byteLength(graphText) < 64 * 1024);
  assert.doesNotMatch(graphText, /data:image|;base64,/u);
  assert.notEqual(path.join(root, "index.json"), path.join(root, "asset-index.json"));

  const restartedWorkflows = new WorkflowManifestStore(() => root);
  const restartedAssets = new ContentAddressedAssetStore(root, authority, options);
  const reopenedWorkflow = await restartedWorkflows.get(workflow.id);
  const reopenedAsset = await restartedAssets.get(imported.asset.assetId);
  assert.equal(reopenedWorkflow?.assetRefs[0], imported.asset.assetId);
  assert.equal(reopenedAsset?.byteLength, largeImage.byteLength);
  const generatedThumbnail = await restartedAssets.getThumbnail(imported.asset.assetId, 512);
  assert.ok(generatedThumbnail.byteLength < 4 * 1024 * 1024);
  assert.ok(restartedAssets.thumbnailCacheStatus().byteLength < 64 * 1024 * 1024);
  assert.deepEqual((await restartedAssets.planGarbageCollection(0)).candidateAssetIds, []);

  await fs.writeFile(workflowPath, "{corrupt", "utf8");
  const recoveryStore = new WorkflowManifestStore(() => root);
  const recovery = await recoveryStore.inspect(workflow.id);
  assert.equal(recovery.status, "recovery-required");
  const restored = await recoveryStore.recover(
    workflow.id,
    "last-known-good",
    workflow.revision,
    "2026-08-11T12:01:00.000Z",
  );
  assert.deepEqual(restored.assetRefs, [imported.asset.assetId]);
  assert.equal(
    (await restartedAssets.get(imported.asset.assetId))?.assetId,
    imported.asset.assetId,
  );
});

test("asset protocol falls back to the validated source when thumbnail generation is unavailable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-create-images-preview-fallback-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = largeStaticPng(0);
  const service = new CreateImagesService(root, {
    assetStore: {
      deepValidator: {
        async validate({ descriptor }) {
          return { width: descriptor.width, height: descriptor.height };
        },
      },
      thumbnailGenerator: {
        async generate() {
          return {
            bytes: Uint8Array.from([0]),
            width: 1,
            height: 1,
            mediaType: "image/png" as const,
          };
        },
      },
    },
  });
  const imported = await service.assets.ingest(imageChunks(source), {
    origin: { kind: "import" },
    declaredMimeType: "image/png",
    displayName: "fallback-reference.png",
  });

  const response = await service.assetResponse(imported.asset.assetId);
  assert.equal(response?.status, 200);
  assert.equal(response?.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await response!.arrayBuffer()), source);
});

test("durable journal references survive renderer loss, lease expiry, GC, and recovery", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-create-images-journal-gc-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = Date.parse("2026-08-11T12:00:00.000Z");
  let rendererAlive = true;
  let failAfterJournal = false;
  const thumbnail = largeStaticPng(0);
  const service = new CreateImagesService(root, {
    workflowDurability: {
      async afterJournalPublished() {
        if (failAfterJournal) rendererAlive = false;
      },
    },
    assetStore: {
      now: () => now,
      deepValidator: {
        async validate({ descriptor }) {
          return { width: descriptor.width, height: descriptor.height };
        },
      },
      thumbnailGenerator: {
        async generate() {
          return {
            bytes: thumbnail,
            width: 1,
            height: 1,
            mediaType: "image/png" as const,
          };
        },
      },
    },
  });
  await service.initialize();
  const imported = await service.assets.ingest(imageChunks(thumbnail), {
    origin: { kind: "import" },
    declaredMimeType: "image/png",
    displayName: "pending-journal-reference.png",
  });
  const workflow = createStarterWorkflow({
    workflowId: "journal-reference-recovery",
    promptNodeId: "prompt-1",
    generationNodeId: "generate-1",
    outputNodeId: "output-1",
    promptEdgeId: "edge-1",
    outputEdgeId: "edge-2",
    now: "2026-08-11T12:00:00.000Z",
  });
  await service.mutateWorkflow(workflow.id, [], () => service.workflows.create(workflow));
  const lease = await service.assets.acquirePreviewLease(
    imported.asset.assetId,
    "journal-regression",
    1_000,
  );
  const pending = structuredClone(workflow);
  pending.revision = 2;
  pending.updatedAt = "2026-08-11T12:01:00.000Z";
  pending.nodes.push({
    id: "image-1",
    type: "image-input",
    position: { x: 20, y: 340 },
    data: { assetId: imported.asset.assetId, label: "Pending durable reference" },
  });
  pending.assetRefs = [imported.asset.assetId];
  failAfterJournal = true;

  await assert.rejects(
    () =>
      service.mutateWorkflow(workflow.id, pending.assetRefs, () =>
        service.workflows.save(pending, 1, () => rendererAlive),
      ),
    /renderer document is no longer active/u,
  );
  assert.equal((await service.workflows.autosaveStatus(workflow.id)).state, "pending");

  now = lease.expiresAt + 1;
  const pendingPlan = await service.assets.planGarbageCollection(0);
  assert.deepEqual(pendingPlan.candidateAssetIds, []);
  assert.deepEqual(
    (await service.assets.applyGarbageCollection(pendingPlan.planId)).deletedAssetIds,
    [],
  );
  assert.equal((await service.assets.get(imported.asset.assetId))?.assetId, imported.asset.assetId);

  const recovered = await service.workflows.recover(
    workflow.id,
    "autosave",
    pending.revision,
    "2026-08-11T12:02:00.000Z",
  );
  await service.refreshReferenceAuthority();
  assert.deepEqual(recovered.assetRefs, [imported.asset.assetId]);
  const recoveredPlan = await service.assets.planGarbageCollection(0);
  assert.deepEqual(recoveredPlan.candidateAssetIds, []);
  assert.deepEqual(
    (await service.assets.applyGarbageCollection(recoveredPlan.planId)).deletedAssetIds,
    [],
  );
  assert.equal((await service.assets.get(imported.asset.assetId))?.assetId, imported.asset.assetId);
});

test("missing workflow assets remain editable but surface deterministic integrity diagnostics", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-create-images-missing-asset-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const missingAssetId = "a".repeat(64);
  const workflow = createStarterWorkflow({
    workflowId: "missing-asset-diagnostic",
    promptNodeId: "prompt-1",
    generationNodeId: "generate-1",
    outputNodeId: "output-1",
    promptEdgeId: "edge-1",
    outputEdgeId: "edge-2",
    now: "2026-08-11T12:00:00.000Z",
  });
  workflow.nodes.push({
    id: "missing-image-1",
    type: "image-input",
    position: { x: 20, y: 340 },
    data: { assetId: missingAssetId, label: "Missing local reference" },
  });
  workflow.assetRefs = [missingAssetId];

  const service = new CreateImagesService(root, {
    assetStore: {
      deepValidator: {
        async validate({ descriptor }) {
          return { width: descriptor.width, height: descriptor.height };
        },
      },
      thumbnailGenerator: {
        async generate() {
          return {
            bytes: largeStaticPng(0),
            width: 1,
            height: 1,
            mediaType: "image/png" as const,
          };
        },
      },
    },
  });
  await service.workflows.create(workflow);
  await service.initialize();

  assert.equal((await service.workflows.list())[0]?.health, "healthy");
  assert.equal((await service.assets.status()).healthy, true);
  assert.deepEqual(service.missingAssetIdsForWorkflow(workflow.id), [missingAssetId]);
  assert.equal(service.missingAssetCount(), 1);

  const retained = structuredClone(workflow);
  retained.revision = 2;
  retained.updatedAt = "2026-08-11T12:01:00.000Z";
  retained.title = "Editable despite a diagnosed missing image";
  await service.mutateWorkflow(workflow.id, retained.assetRefs, () =>
    service.workflows.save(retained, 1),
  );
  assert.deepEqual(service.missingAssetIdsForWorkflow(workflow.id), [missingAssetId]);
  assert.equal(service.missingAssetCount(), 1);

  let introducedMissingAssetPublished = false;
  await assert.rejects(
    () =>
      service.mutateWorkflow(workflow.id, [missingAssetId, "b".repeat(64)], async () => {
        introducedMissingAssetPublished = true;
      }),
    /does not exist/u,
  );
  assert.equal(introducedMissingAssetPublished, false);

  const repaired = structuredClone(retained);
  repaired.revision = 3;
  repaired.updatedAt = "2026-08-11T12:02:00.000Z";
  repaired.nodes = repaired.nodes.filter((node) => node.id !== "missing-image-1");
  repaired.assetRefs = [];
  await service.mutateWorkflow(workflow.id, repaired.assetRefs, () =>
    service.workflows.save(repaired, 2),
  );
  assert.deepEqual(service.missingAssetIdsForWorkflow(workflow.id), []);
  assert.equal(service.missingAssetCount(), 0);
});

test("an indexed asset whose source disappears is diagnosed after restart", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-create-images-missing-source-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = {
    assetStore: {
      deepValidator: {
        async validate({ descriptor }: { descriptor: { width: number; height: number } }) {
          return { width: descriptor.width, height: descriptor.height };
        },
      },
      thumbnailGenerator: {
        async generate() {
          return {
            bytes: largeStaticPng(0),
            width: 1,
            height: 1,
            mediaType: "image/png" as const,
          };
        },
      },
    },
  };
  const service = new CreateImagesService(root, options);
  const imported = await service.assets.ingest(imageChunks(largeStaticPng(0)), {
    origin: { kind: "import" },
    declaredMimeType: "image/png",
  });
  const workflow = createStarterWorkflow({
    workflowId: "missing-published-source",
    promptNodeId: "prompt-1",
    generationNodeId: "generate-1",
    outputNodeId: "output-1",
    promptEdgeId: "edge-1",
    outputEdgeId: "edge-2",
    now: "2026-08-11T12:00:00.000Z",
  });
  workflow.nodes.push({
    id: "image-1",
    type: "image-input",
    position: { x: 0, y: 340 },
    data: { assetId: imported.asset.assetId },
  });
  workflow.assetRefs = [imported.asset.assetId];
  await service.mutateWorkflow(workflow.id, workflow.assetRefs, () =>
    service.workflows.create(workflow),
  );
  await fs.rm(
    path.join(
      root,
      "assets",
      "sha256",
      imported.asset.assetId.slice(0, 2),
      `${imported.asset.assetId}.png`,
    ),
  );

  const restarted = new CreateImagesService(root, options);
  await restarted.initialize();
  assert.deepEqual(restarted.missingAssetIdsForWorkflow(workflow.id), [imported.asset.assetId]);
  assert.equal(restarted.missingAssetCount(), 1);
  assert.equal(await restarted.assets.getAvailable(imported.asset.assetId), undefined);
});
