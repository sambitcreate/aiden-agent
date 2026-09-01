import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DesignReferenceAssetStore,
  MAX_DESIGN_REFERENCE_ASSET_BYTES,
} from "./design-reference-asset-store.js";

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

test("deduplicates identical bytes and survives restart without exposing base64 in descriptors", async () => {
  const directory = await root();
  const store = new DesignReferenceAssetStore({ root: () => directory, now: () => 42 });
  await store.initialize();

  const first = await store.put({ name: "reference.png", mimeType: "image/png", bytes: PNG });
  const second = await store.put({ name: "renamed.png", mimeType: "image/png", bytes: PNG });
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
  const store = new DesignReferenceAssetStore({ root: () => awaitRootSyncError() });
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
  const kept = await store.put({ name: "keep.png", mimeType: "image/png", bytes: PNG });
  const duplicate = await store.put({ name: "duplicate.png", mimeType: "image/png", bytes: PNG });
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
  const first = await store.put({ name: "first.png", mimeType: "image/png", bytes: PNG });
  assert.equal(await store.deleteUnreferencedCandidates([first.id], new Set([first.id])), 0);
  assert.equal((await store.list()).length, 1);
  assert.equal(await store.deleteUnreferencedCandidates([first.id], new Set()), 1);
  assert.equal(await store.deleteUnreferencedCandidates([first.id], new Set()), 0);
  await assert.rejects(store.deleteUnreferencedCandidates(["../bad"], new Set()), /identity/u);
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
