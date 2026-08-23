import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBotAvatarApplicationAdapter } from "./bot-avatar-application-adapter.js";
import { projectBotAvatarForRenderer } from "./bot-avatar-renderer-projection.js";
import type { BotDefinition } from "../../renderer/shared/bots.js";
import {
  BOT_AVATAR_ASSETS_DIRECTORY,
  BOT_AVATAR_MANIFEST,
  createFileBotAvatarStore,
  createFileBotAvatarStorage,
} from "./bot-avatar-store.js";
import {
  BOT_AVATAR_SOURCE_MAX_BYTES,
  BOT_AVATAR_STORE_VERSION,
  BotAvatarInputError,
  BotAvatarReplayError,
  BotAvatarRevisionConflictError,
  BotAvatarStateError,
  BotAvatarUnavailableError,
  inspectBotAvatarSource,
  type BotAvatarNormalizer,
} from "./bot-avatar-store-core.js";

const OWNER_A = "owner:local-aiden";
const OWNER_B = "owner:other-aiden";
const BOT_A = "bot:alpha";
const BOT_B = "bot:beta";
const ASSET_A = "10000000-0000-4000-8000-000000000001";
const ASSET_B = "20000000-0000-4000-8000-000000000002";
const REVISION_A = "avatar_revision_10000000000040008000000000000001";
const REVISION_B = "avatar_revision_20000000000040008000000000000002";

function png(width: number, height: number, tail = 0): Buffer {
  const bytes = Buffer.alloc(33 + tail);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function jpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff,
    1, 1, 0x11, 0, 0xff, 0xd9,
  ]);
}

const normalizer: BotAvatarNormalizer = {
  async normalize() { return png(512, 512, 8); },
};

function mode(info: { mode: number }): number { return info.mode & 0o777; }

async function temporaryRoot(prefix: string): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  return { parent, root: join(parent, "private-bot-avatars") };
}

test("source inspection accepts only matching bounded PNG/JPEG containers", () => {
  assert.deepEqual(inspectBotAvatarSource({ mimeType: "image/png", bytes: png(640, 480) }), { width: 640, height: 480 });
  assert.deepEqual(inspectBotAvatarSource({ mimeType: "image/jpeg", bytes: jpeg(320, 200) }), { width: 320, height: 200 });
  assert.throws(() => inspectBotAvatarSource({ mimeType: "image/png", bytes: jpeg(10, 10) }), BotAvatarInputError);
  assert.throws(() => inspectBotAvatarSource({ mimeType: "image/jpeg", bytes: png(10, 10) }), BotAvatarInputError);
  assert.throws(() => inspectBotAvatarSource({ mimeType: "image/png", bytes: png(4_097, 1) }), /dimensions/u);
  assert.throws(() => inspectBotAvatarSource({ mimeType: "image/png", bytes: png(4_000, 4_001) }), /dimensions/u);
  assert.throws(() => inspectBotAvatarSource({
    mimeType: "image/png",
    bytes: Buffer.concat([png(1, 1), Buffer.alloc(BOT_AVATAR_SOURCE_MAX_BYTES)]),
  }), /bounded/u);
});

test("canonical avatar persists privately and survives restart with exact scope binding", async () => {
  const paths = await temporaryRoot("aiden-bot-avatar-");
  try {
    const service = createFileBotAvatarStore({
      root: () => paths.root, normalizer, now: () => 42,
      mintAssetId: () => ASSET_A, mintAssetRevision: () => REVISION_A,
    });
    const metadata = await service.put({
      ownerId: OWNER_A, botId: BOT_A, expectedAssetRevision: null,
      operationId: "device-1:avatar-1", source: { mimeType: "image/jpeg", bytes: jpeg(640, 480) },
    });
    assert.deepEqual(metadata, {
      assetRevision: REVISION_A, mimeType: "image/png", width: 512, height: 512, byteSize: 41,
    });
    assert.deepEqual((await service.read(OWNER_A, BOT_A, REVISION_A)).bytes, png(512, 512, 8));
    await assert.rejects(service.read(OWNER_B, BOT_A, REVISION_A), BotAvatarUnavailableError);
    await assert.rejects(service.read(OWNER_A, BOT_B, REVISION_A), BotAvatarUnavailableError);
    await assert.rejects(service.read(OWNER_A, BOT_A, REVISION_B), BotAvatarUnavailableError);
    const restarted = createFileBotAvatarStore({ root: () => paths.root, normalizer });
    assert.deepEqual(await restarted.metadata(OWNER_A, BOT_A), metadata);
    assert.equal(mode(await lstat(paths.root)), 0o700);
    assert.equal(mode(await lstat(join(paths.root, BOT_AVATAR_ASSETS_DIRECTORY))), 0o700);
    assert.equal(mode(await lstat(join(paths.root, BOT_AVATAR_MANIFEST))), 0o600);
    const names = await readdir(join(paths.root, BOT_AVATAR_ASSETS_DIRECTORY));
    assert.deepEqual(names, [`avatar-${ASSET_A}.png`]);
    assert.equal(mode(await lstat(join(paths.root, BOT_AVATAR_ASSETS_DIRECTORY, names[0]!))), 0o600);
    const manifest = await readFile(join(paths.root, BOT_AVATAR_MANIFEST), "utf8");
    assert.equal(manifest.includes(paths.parent), false);
    assert.equal(manifest.includes(".png"), false);
  } finally { await rm(paths.parent, { recursive: true, force: true }); }
});

test("stale updates and operation replay fail closed", async () => {
  const paths = await temporaryRoot("aiden-bot-avatar-replay-");
  try {
    const ids = [ASSET_A, ASSET_B];
    const revisions = [REVISION_A, REVISION_B];
    const service = createFileBotAvatarStore({
      root: () => paths.root, normalizer,
      mintAssetId: () => ids.shift()!, mintAssetRevision: () => revisions.shift()!,
    });
    const first = {
      ownerId: OWNER_A, botId: BOT_A, expectedAssetRevision: null,
      operationId: "device-1:avatar-1", source: { mimeType: "image/png" as const, bytes: png(300, 300) },
    };
    assert.equal((await service.put(first)).assetRevision, REVISION_A);
    assert.equal((await service.put(first)).assetRevision, REVISION_A);
    await assert.rejects(service.put({ ...first, botId: BOT_B }), BotAvatarReplayError);
    await assert.rejects(service.put({ ...first, operationId: "device-1:stale" }),
      (error: unknown) => error instanceof BotAvatarRevisionConflictError && error.currentAssetRevision === REVISION_A);
    assert.equal((await service.put({ ...first, expectedAssetRevision: REVISION_A, operationId: "device-1:avatar-2" })).assetRevision, REVISION_B);
    await assert.rejects(service.put(first), BotAvatarReplayError);
    await assert.rejects(service.read(OWNER_A, BOT_A, REVISION_A), BotAvatarUnavailableError);
    assert.deepEqual(await readdir(join(paths.root, BOT_AVATAR_ASSETS_DIRECTORY)), [`avatar-${ASSET_B}.png`]);
  } finally { await rm(paths.parent, { recursive: true, force: true }); }
});

test("delete is revision-checked, durable, and idempotent", async () => {
  const paths = await temporaryRoot("aiden-bot-avatar-delete-");
  try {
    const service = createFileBotAvatarStore({
      root: () => paths.root, normalizer,
      mintAssetId: () => ASSET_A, mintAssetRevision: () => REVISION_A,
    });
    await service.put({ ownerId: OWNER_A, botId: BOT_A, expectedAssetRevision: null,
      operationId: "put-1", source: { mimeType: "image/png", bytes: png(512, 512) } });
    await assert.rejects(service.delete({ ownerId: OWNER_A, botId: BOT_A,
      expectedAssetRevision: null, operationId: "delete-stale" }), BotAvatarRevisionConflictError);
    const deletion = { ownerId: OWNER_A, botId: BOT_A, expectedAssetRevision: REVISION_A, operationId: "delete-1" };
    await service.delete(deletion);
    await service.delete(deletion);
    assert.equal(await service.metadata(OWNER_A, BOT_A), null);
    assert.deepEqual(await readdir(join(paths.root, BOT_AVATAR_ASSETS_DIRECTORY)), []);
    assert.equal(await createFileBotAvatarStore({ root: () => paths.root, normalizer }).metadata(OWNER_A, BOT_A), null);
  } finally { await rm(paths.parent, { recursive: true, force: true }); }
});

test("invalid normalized output is rejected before publication", async () => {
  const paths = await temporaryRoot("aiden-bot-avatar-normalizer-");
  try {
    const service = createFileBotAvatarStore({
      root: () => paths.root, normalizer: { async normalize() { return png(511, 512); } },
      mintAssetId: () => ASSET_A, mintAssetRevision: () => REVISION_A,
    });
    await assert.rejects(service.put({ ownerId: OWNER_A, botId: BOT_A,
      expectedAssetRevision: null, operationId: "put-invalid",
      source: { mimeType: "image/png", bytes: png(20, 20) } }), /normalized/u);
    assert.deepEqual(await readdir(join(paths.root, BOT_AVATAR_ASSETS_DIRECTORY)), []);
  } finally { await rm(paths.parent, { recursive: true, force: true }); }
});

test("failed manifest publication removes new bytes and preserves current bytes", async () => {
  const paths = await temporaryRoot("aiden-bot-avatar-atomic-");
  try {
    await createFileBotAvatarStore({ root: () => paths.root, normalizer,
      mintAssetId: () => ASSET_A, mintAssetRevision: () => REVISION_A }).put({
      ownerId: OWNER_A, botId: BOT_A, expectedAssetRevision: null,
      operationId: "put-1", source: { mimeType: "image/png", bytes: png(32, 32) },
    });
    const failing = createFileBotAvatarStore({ root: () => paths.root, normalizer,
      mintAssetId: () => ASSET_B, mintAssetRevision: () => REVISION_B,
      beforeManifestPublish: async () => { throw new Error("disk publication failed"); } });
    await assert.rejects(failing.put({ ownerId: OWNER_A, botId: BOT_A,
      expectedAssetRevision: REVISION_A, operationId: "put-2",
      source: { mimeType: "image/png", bytes: png(32, 32) } }), /disk publication failed/u);
    const restarted = createFileBotAvatarStore({ root: () => paths.root, normalizer });
    assert.equal((await restarted.metadata(OWNER_A, BOT_A))?.assetRevision, REVISION_A);
    assert.deepEqual(await readdir(join(paths.root, BOT_AVATAR_ASSETS_DIRECTORY)), [`avatar-${ASSET_A}.png`]);
  } finally { await rm(paths.parent, { recursive: true, force: true }); }
});

test("corrupt descriptors and symlinked private directories fail closed", async () => {
  const paths = await temporaryRoot("aiden-bot-avatar-corrupt-");
  try {
    await mkdir(join(paths.root, BOT_AVATAR_ASSETS_DIRECTORY), { recursive: true, mode: 0o700 });
    await writeFile(join(paths.root, BOT_AVATAR_MANIFEST), JSON.stringify({
      version: BOT_AVATAR_STORE_VERSION,
      records: [{ ownerId: OWNER_A, botId: BOT_A, assetRevision: REVISION_A,
        asset: { assetId: "../../outside", byteSize: 33, digest: "0".repeat(64),
          incarnation: { device: "0", inode: "1" } }, updatedAt: 1 }], receipts: [],
    }), { mode: 0o600 });
    await assert.rejects(createFileBotAvatarStore({ root: () => paths.root, normalizer }).initialize(), BotAvatarStateError);
  } finally { await rm(paths.parent, { recursive: true, force: true }); }

  const linked = await temporaryRoot("aiden-bot-avatar-symlink-");
  const outside = await mkdtemp(join(tmpdir(), "aiden-bot-avatar-outside-"));
  try {
    await mkdir(linked.root, { mode: 0o700 });
    await symlink(outside, join(linked.root, BOT_AVATAR_ASSETS_DIRECTORY));
    await assert.rejects(createFileBotAvatarStorage({ root: () => linked.root }).readManifest(), /privately owned/u);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(linked.parent, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("manifest publication revalidates parent identity and never cleans through a swapped root", async () => {
  const paths = await temporaryRoot("aiden-bot-avatar-swap-");
  const outside = await mkdtemp(join(tmpdir(), "aiden-bot-avatar-swap-outside-"));
  const displaced = `${paths.root}-displaced`;
  try {
    const service = createFileBotAvatarStore({
      root: () => paths.root, normalizer,
      mintAssetId: () => ASSET_A, mintAssetRevision: () => REVISION_A,
      beforeManifestPublish: async () => {
        await rename(paths.root, displaced);
        await symlink(outside, paths.root);
      },
    });
    await assert.rejects(service.put({
      ownerId: OWNER_A, botId: BOT_A, expectedAssetRevision: null,
      operationId: "put-during-swap", source: { mimeType: "image/png", bytes: png(64, 64) },
    }), /directory changed/u);
    assert.deepEqual(await readdir(outside), []);
    assert.deepEqual(await readdir(join(displaced, BOT_AVATAR_ASSETS_DIRECTORY)), [
      `avatar-${ASSET_A}.png`,
    ], "uncertain bytes stay in the pinned old store for restart reconciliation");
  } finally {
    await rm(paths.parent, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("restart reconciliation removes only store-shaped orphan assets", async () => {
  const paths = await temporaryRoot("aiden-bot-avatar-orphan-");
  try {
    const storage = createFileBotAvatarStorage({ root: () => paths.root });
    await storage.writeAsset(ASSET_A, png(512, 512));
    await writeFile(join(paths.root, BOT_AVATAR_ASSETS_DIRECTORY, "do-not-touch.txt"), "owned elsewhere", { mode: 0o600 });
    await createFileBotAvatarStore({ root: () => paths.root, normalizer }).initialize();
    assert.deepEqual(await readdir(join(paths.root, BOT_AVATAR_ASSETS_DIRECTORY)), ["do-not-touch.txt"]);
  } finally { await rm(paths.parent, { recursive: true, force: true }); }
});

test("application adapter projects semantic fallback and exposes only canonical content", async () => {
  const paths = await temporaryRoot("aiden-bot-avatar-adapter-");
  try {
    const store = createFileBotAvatarStore({
      root: () => paths.root, normalizer,
      mintAssetId: () => ASSET_A, mintAssetRevision: () => REVISION_A,
    });
    const adapter = createBotAvatarApplicationAdapter({ store, ownerId: OWNER_A });
    assert.deepEqual(await adapter.view(BOT_A, "spark"), { semantic: "spark" });
    const asset = await adapter.put({
      botId: BOT_A, expectedAssetRevision: null, operationId: "remote-operation-1",
    }, {
      mimeType: "image/jpeg",
      data: jpeg(100, 80).toString("base64"),
    });
    assert.deepEqual(await adapter.view(BOT_A, "spark"), { semantic: "spark", asset });
    assert.deepEqual((await adapter.content(BOT_A, REVISION_A)).bytes, png(512, 512, 8));
    await adapter.delete({
      botId: BOT_A, expectedAssetRevision: REVISION_A, operationId: "remote-operation-2",
    });
    assert.deepEqual(await adapter.view(BOT_A, "spark"), { semantic: "spark" });
  } finally { await rm(paths.parent, { recursive: true, force: true }); }
});

test("renderer projection returns exact canonical bytes without exposing private store paths", async () => {
  const paths = await temporaryRoot("aiden-bot-avatar-renderer-");
  try {
    const store = createFileBotAvatarStore({
      root: () => paths.root, normalizer,
      mintAssetId: () => ASSET_A, mintAssetRevision: () => REVISION_A,
    });
    const adapter = createBotAvatarApplicationAdapter({ store, ownerId: OWNER_A });
    await adapter.put({
      botId: BOT_A, expectedAssetRevision: null, operationId: "renderer-projection-put",
    }, { mimeType: "image/png", data: png(512, 512).toString("base64") });
    const bot: BotDefinition = {
      id: BOT_A,
      revision: "bot-revision-a",
      name: "Planner",
      instructions: "Plan carefully.",
      avatar: "spark",
      createdAt: 1,
      updatedAt: 1,
    };
    const projected = await projectBotAvatarForRenderer(BOT_A, {
      bots: { get: async () => bot },
      avatar: adapter,
    });
    assert.deepEqual(projected, {
      assetRevision: REVISION_A,
      dataUrl: `data:image/png;base64,${png(512, 512, 8).toString("base64")}`,
    });
    assert.doesNotMatch(JSON.stringify(projected), /bot-avatar-store|assetfilename|private\//u);
  } finally { await rm(paths.parent, { recursive: true, force: true }); }
});

test("renderer projection preserves the semantic fallback for missing or stale raster state", async () => {
  const bot: BotDefinition = {
    id: BOT_A,
    revision: "bot-revision-a",
    name: "Planner",
    instructions: "Plan carefully.",
    avatar: "spark",
    createdAt: 1,
    updatedAt: 1,
  };
  assert.equal(await projectBotAvatarForRenderer(BOT_A, {
    bots: { get: async () => null },
    avatar: {
      view: async () => ({ semantic: "spark" }),
      content: async () => { throw new Error("must not read"); },
    },
  }), null);
  assert.equal(await projectBotAvatarForRenderer(BOT_A, {
    bots: { get: async () => bot },
    avatar: {
      view: async () => ({
        semantic: "spark",
        asset: { assetRevision: REVISION_A, mimeType: "image/png", width: 512, height: 512, byteSize: 1 },
      }),
      content: async () => { throw new Error("concurrently replaced"); },
    },
  }), null);
});

test("renderer projection reconciles one concurrent canonical-photo replacement", async () => {
  const replacementRevision = "avatar_revision_20000000000040008000000000000002";
  const bytes = Buffer.from("replacement");
  let views = 0;
  const projected = await projectBotAvatarForRenderer(BOT_A, {
    bots: { get: async () => ({
      id: BOT_A,
      revision: "bot-revision-a",
      name: "Planner",
      instructions: "Plan carefully.",
      avatar: "spark",
      createdAt: 1,
      updatedAt: 1,
    }) },
    avatar: {
      view: async () => {
        views += 1;
        return {
          semantic: "spark",
          asset: {
            assetRevision: views === 1 ? REVISION_A : replacementRevision,
            mimeType: "image/png",
            width: 512,
            height: 512,
            byteSize: bytes.length,
          },
        };
      },
      content: async (_botId, assetRevision) => {
        if (assetRevision === REVISION_A) throw new Error("concurrently replaced");
        return {
          metadata: {
            assetRevision: replacementRevision,
            mimeType: "image/png",
            width: 512,
            height: 512,
            byteSize: bytes.length,
          },
          bytes,
        };
      },
    },
  });
  assert.equal(views, 2);
  assert.deepEqual(projected, {
    assetRevision: replacementRevision,
    dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
  });
});
