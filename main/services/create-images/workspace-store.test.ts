import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AssetMetadataDto } from "./asset-store-core.js";
import {
  CreateImagesWorkspaceError,
  CreateImagesWorkspaceStore,
  createImagesWorkspaceRelativePath,
} from "./workspace-store.js";

interface FakeAsset extends AssetMetadataDto {
  sourcePath: string;
  bytes: Uint8Array;
}

class FakeAssetStore {
  private readonly items = new Map<string, FakeAsset>();

  constructor(private readonly sourceRoot: string) {}

  async add(
    label: string,
    input: { displayName?: string; origin: AssetMetadataDto["origin"] },
  ): Promise<AssetMetadataDto> {
    const bytes = new TextEncoder().encode(label);
    const assetId = createHash("sha256").update(bytes).digest("hex");
    const sourcePath = path.join(this.sourceRoot, `${assetId}.source`);
    await fs.writeFile(sourcePath, bytes, { mode: 0o600 });
    const asset: FakeAsset = {
      assetId,
      mediaType: "image/png",
      byteLength: bytes.byteLength,
      width: 1,
      height: 1,
      createdAt: new Date(1_700_000_000_000).toISOString(),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      origin: input.origin,
      referenceCount: 0,
      thumbnailSizes: [],
      sourcePath,
      bytes,
    };
    this.items.set(assetId, asset);
    return structuredClone(asset);
  }

  async list(): Promise<AssetMetadataDto[]> {
    return [...this.items.values()].map((asset) => structuredClone(asset));
  }

  async get(assetId: string): Promise<AssetMetadataDto | undefined> {
    const asset = this.items.get(assetId);
    return asset ? structuredClone(asset) : undefined;
  }

  async withAssetFile<Result>(
    assetId: string,
    callback: (input: {
      filePath: string;
      asset: AssetMetadataDto;
      byteLength: number;
      mediaType: AssetMetadataDto["mediaType"];
    }) => Promise<Result>,
  ): Promise<Result> {
    const asset = this.items.get(assetId);
    if (!asset) throw new Error("asset missing");
    return callback({
      filePath: asset.sourcePath,
      asset: structuredClone(asset),
      byteLength: asset.byteLength,
      mediaType: asset.mediaType,
    });
  }
}

async function withRoots(
  run: (roots: { internal: string; external: string }) => Promise<void>,
): Promise<void> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-create-images-workspace-test-"));
  const roots = {
    internal: path.join(base, "internal"),
    external: path.join(base, "external"),
  };
  await fs.mkdir(roots.internal);
  await fs.mkdir(roots.external);
  try {
    await run(roots);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

function readPath(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

test("configures a Finder-visible root, auto-syncs assets, and keeps status path-free", async () => {
  await withRoots(async ({ internal, external }) => {
    const assets = new FakeAssetStore(path.join(internal, "sources"));
    await fs.mkdir(path.join(internal, "sources"));
    const imported = await assets.add("import-bytes", {
      displayName: "family photo.jpg",
      origin: { kind: "import" },
    });
    const generated = await assets.add("generated-bytes", {
      displayName: "sunset.png",
      origin: { kind: "provider", providerId: "provider", modelId: "model", runId: "run" },
    });
    const workspace = new CreateImagesWorkspaceStore(internal, assets);

    assert.equal((await workspace.status()).state, "unconfigured");
    const configured = await workspace.configureChosenDirectory(external);
    assert.equal(configured.state, "ready");
    assert.equal(configured.displayName, path.basename(external));
    assert.equal(configured.importedCount, 1);
    assert.equal(configured.generatedCount, 1);
    assert.equal(configured.lastSyncedAt !== undefined, true);
    assert.equal(JSON.stringify(configured).includes(external), false);
    assert.equal(JSON.stringify(configured).includes(internal), false);

    const importedRelative = createImagesWorkspaceRelativePath(imported);
    const generatedRelative = createImagesWorkspaceRelativePath(generated);
    assert.match(importedRelative, /^Imports\/family-photo-[a-f0-9]{64}\.png$/u);
    assert.match(generatedRelative, /^Generated\/sunset-[a-f0-9]{64}\.png$/u);
    assert.deepEqual(
      new Uint8Array(await fs.readFile(readPath(external, importedRelative))),
      new TextEncoder().encode("import-bytes"),
    );
    assert.deepEqual(
      new Uint8Array(await fs.readFile(readPath(external, generatedRelative))),
      new TextEncoder().encode("generated-bytes"),
    );
    assert.equal(
      (await fs.lstat(path.join(external, ".aiden-create-images-workspace.json"))).isFile(),
      true,
    );
    assert.match(await fs.readFile(path.join(external, "README.txt"), "utf8"), /source of truth/u);

    const reopened = new CreateImagesWorkspaceStore(internal, assets);
    assert.equal((await reopened.status()).state, "ready");
    const openRoot = await reopened.openRoot();
    assert.equal(openRoot.filePath, await fs.realpath(external));
    assert.equal(openRoot.displayName, path.basename(external));
    assert.equal((await reopened.openTarget(imported.assetId)).relativePath, importedRelative);
    await reopened.syncAsset(imported.assetId);
    assert.equal((await reopened.status()).generatedCount, 1);
    const repeat = await reopened.syncAll();
    assert.deepEqual(repeat.materializedAssetIds, []);
    assert.deepEqual(
      repeat.alreadyMaterializedAssetIds.sort(),
      [imported.assetId, generated.assetId].sort(),
    );
  });
});

test("never overwrites an arbitrary existing target", async () => {
  await withRoots(async ({ internal, external }) => {
    const assets = new FakeAssetStore(path.join(internal, "sources"));
    await fs.mkdir(path.join(internal, "sources"));
    const asset = await assets.add("canonical", {
      displayName: "same-name.png",
      origin: { kind: "import" },
    });
    const workspace = new CreateImagesWorkspaceStore(internal, assets);
    await workspace.configureChosenDirectory(external);
    const target = readPath(external, createImagesWorkspaceRelativePath(asset));
    await fs.writeFile(target, "user-owned", { mode: 0o600 });

    const result = await workspace.syncAll();
    assert.equal(result.state, "conflict");
    assert.deepEqual(result.conflictedAssetIds, [asset.assetId]);
    assert.equal(await fs.readFile(target, "utf8"), "user-owned");
    await assert.rejects(
      workspace.openTarget(asset.assetId),
      (error: unknown) =>
        error instanceof CreateImagesWorkspaceError && error.code === "workspace_target_conflict",
    );
  });
});

test("rejects symlinked roots and refuses a symlink target without touching its destination", async () => {
  await withRoots(async ({ internal, external }) => {
    const assets = new FakeAssetStore(path.join(internal, "sources"));
    await fs.mkdir(path.join(internal, "sources"));
    const asset = await assets.add("safe-bytes", {
      displayName: "safe.png",
      origin: { kind: "provider", providerId: "provider", modelId: "model", runId: "run" },
    });
    const linkRoot = path.join(path.dirname(external), "external-link");
    await fs.symlink(external, linkRoot, "dir");
    const workspace = new CreateImagesWorkspaceStore(internal, assets);
    await assert.rejects(
      workspace.configureChosenDirectory(linkRoot),
      (error: unknown) =>
        error instanceof CreateImagesWorkspaceError && error.code === "workspace_root_unsafe",
    );

    await workspace.configureChosenDirectory(external);
    const outside = path.join(path.dirname(external), "outside");
    await fs.mkdir(outside);
    const target = readPath(external, createImagesWorkspaceRelativePath(asset));
    const outsideTarget = path.join(outside, "should-stay-empty.png");
    await fs.rm(target);
    await fs.symlink(outsideTarget, target, "file");
    const result = await workspace.syncAll();
    assert.equal(result.state, "conflict");
    assert.deepEqual(result.conflictedAssetIds, [asset.assetId]);
    await assert.rejects(fs.access(outsideTarget));
  });
});

test("reports replacement/drift after restart and fails closed on corrupt internal config", async () => {
  await withRoots(async ({ internal, external }) => {
    const assets = new FakeAssetStore(path.join(internal, "sources"));
    await fs.mkdir(path.join(internal, "sources"));
    const workspace = new CreateImagesWorkspaceStore(internal, assets);
    await workspace.configureChosenDirectory(external);
    const moved = path.join(path.dirname(external), "external-moved");
    await fs.rename(external, moved);
    const restarted = new CreateImagesWorkspaceStore(internal, assets);
    assert.equal((await restarted.status()).state, "drifted");
    const preflight = await restarted.preflight();
    assert.equal(preflight.ok, false);
    assert.deepEqual(preflight.issues, [{ code: "root_missing" }]);

    const corruptRoot = path.join(path.dirname(internal), "corrupt-internal");
    await fs.mkdir(corruptRoot);
    await fs.writeFile(path.join(corruptRoot, "workspace.json"), "{not-json", { mode: 0o600 });
    const corrupt = new CreateImagesWorkspaceStore(corruptRoot, assets);
    assert.equal((await corrupt.status()).state, "repair_required");
    assert.equal((await corrupt.configureChosenDirectory(moved)).state, "ready");
    const corruptBackups = (await fs.readdir(corruptRoot)).filter((name) =>
      name.includes("workspace.json.invalid-"),
    );
    assert.equal(corruptBackups.length, 1);
  });
});
