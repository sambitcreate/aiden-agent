import assert from "node:assert/strict";
import test from "node:test";
import type { CreateImagesAssetGrantView } from "../shared/create-images/ipc.js";
import {
  AssetPreviewLifecycleManager,
  AssetPreviewLoadError,
  deferAssetPreviewLifecycleDisposal,
} from "./asset-preview-lifecycle-core.js";

const NO_TIMERS = {
  set: () => 0,
  clear: () => undefined,
};

function grant(assetId: string, token: string, expiresAt: number): CreateImagesAssetGrantView {
  return {
    token,
    expiresAt,
    url: `aiden-asset://asset/${token}`,
    asset: {
      assetId,
      mediaType: "image/png",
      byteLength: 128,
      width: 1,
      height: 1,
      importedAt: "2026-08-11T12:00:00.000Z",
    },
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("preview requests are per-asset single-flight and concurrency bounded", async () => {
  const releases: Array<(value: CreateImagesAssetGrantView) => void> = [];
  const calls: string[] = [];
  const manager = new AssetPreviewLifecycleManager({
    maxConcurrent: 2,
    timers: NO_TIMERS,
    load: (assetId) => {
      calls.push(assetId);
      return new Promise((resolve) => releases.push(resolve));
    },
    revoke: async () => undefined,
  });

  manager.setAssets(["asset-1", "asset-2", "asset-3"]);
  manager.retain("asset-1");
  manager.retain("asset-2");
  manager.retain("asset-3");
  manager.setAssets(["asset-1", "asset-2", "asset-3"]);
  assert.deepEqual(calls, ["asset-1", "asset-2"]);
  assert.equal(manager.status("asset-1"), "loading");
  assert.equal(manager.status("asset-3"), "loading");
  releases[0]?.(grant("asset-1", "token-1", Date.now() + 60_000));
  await settle();
  assert.deepEqual(calls, ["asset-1", "asset-2", "asset-3"]);
  releases[1]?.(grant("asset-2", "token-2", Date.now() + 60_000));
  releases[2]?.(grant("asset-3", "token-3", Date.now() + 60_000));
  await settle();
  await manager.dispose();
});

test("renewal keeps the old preview until an atomic swap and revokes every superseded token", async () => {
  let now = 1_000;
  const loads: Array<(value: CreateImagesAssetGrantView) => void> = [];
  const revoked: string[] = [];
  const manager = new AssetPreviewLifecycleManager({
    now: () => now,
    timers: NO_TIMERS,
    load: () => new Promise((resolve) => loads.push(resolve)),
    revoke: async (token) => {
      revoked.push(token);
    },
  });

  manager.setAssets(["asset-1"]);
  manager.retain("asset-1");
  loads[0]?.(grant("asset-1", "old-token", 61_000));
  await settle();
  assert.equal(manager.snapshot()["asset-1"]?.token, "old-token");

  now = 50_000;
  manager.refresh();
  assert.equal(loads.length, 2);
  assert.equal(manager.snapshot()["asset-1"]?.token, "old-token");
  loads[1]?.(grant("asset-1", "new-token", 110_000));
  await settle();
  assert.equal(manager.snapshot()["asset-1"]?.token, "new-token");
  assert.deepEqual(revoked, ["old-token"]);

  manager.reportLoadError("asset-1", "new-token");
  assert.equal(manager.snapshot()["asset-1"], undefined);
  assert.equal(loads.length, 2);
  assert.deepEqual(revoked, ["old-token", "new-token"]);
  now = 51_000;
  manager.refresh();
  assert.equal(loads.length, 3);
  loads[2]?.(grant("asset-1", "recovered-token", 120_000));
  await settle();
  await manager.dispose();
  assert.deepEqual(revoked, ["old-token", "new-token", "recovered-token"]);
});

test("pruning and disposal revoke late in-flight grants without resurrecting previews", async () => {
  let resolveLoad: ((value: CreateImagesAssetGrantView) => void) | undefined;
  const revoked: string[] = [];
  const manager = new AssetPreviewLifecycleManager({
    timers: NO_TIMERS,
    load: () => new Promise((resolve) => (resolveLoad = resolve)),
    revoke: async (token) => {
      revoked.push(token);
    },
  });

  manager.setAssets(["asset-1"]);
  manager.retain("asset-1");
  manager.setAssets([]);
  resolveLoad?.(grant("asset-1", "late-token", Date.now() + 60_000));
  await settle();
  assert.deepEqual(manager.snapshot(), {});
  assert.deepEqual(revoked, ["late-token"]);
  await manager.dispose();
});

test("retry backoff is bounded and a wake after expiry renews a sleeping canvas", async () => {
  let now = 1_000;
  let calls = 0;
  const revoked: string[] = [];
  const manager = new AssetPreviewLifecycleManager({
    now: () => now,
    retryBaseMs: 1_000,
    retryMaxMs: 4_000,
    timers: NO_TIMERS,
    load: async (assetId) => {
      calls += 1;
      if (calls === 1) throw new AssetPreviewLoadError("temporary", true);
      return grant(assetId, `token-${calls}`, now + 60_000);
    },
    revoke: async (token) => {
      revoked.push(token);
    },
  });

  manager.setAssets(["asset-1"]);
  manager.retain("asset-1");
  await settle();
  assert.equal(manager.status("asset-1"), "retrying");
  manager.refresh();
  assert.equal(calls, 1);
  now = 2_000;
  manager.refresh();
  await settle();
  assert.equal(calls, 2);
  assert.equal(manager.snapshot()["asset-1"]?.token, "token-2");
  assert.equal(manager.status("asset-1"), "ready");

  now = 70_000;
  manager.refresh();
  await settle();
  assert.equal(calls, 3);
  assert.equal(manager.snapshot()["asset-1"]?.token, "token-3");
  assert.deepEqual(revoked, ["token-2"]);
  await manager.dispose();
});

test("preview status distinguishes terminal failure from loading and retrying", async () => {
  const manager = new AssetPreviewLifecycleManager({
    timers: NO_TIMERS,
    load: async () => {
      throw new AssetPreviewLoadError("forbidden", false);
    },
    revoke: async () => undefined,
  });
  manager.setAssets(["asset-1"]);
  manager.retain("asset-1");
  assert.equal(manager.status("asset-1"), "loading");
  await settle();
  assert.equal(manager.status("asset-1"), "unavailable");
  await manager.dispose();
});

test("a wedged grant request times out, retries, and revokes a late token", async () => {
  let now = 1_000;
  const timers: Array<() => void> = [];
  const lateLoads: Array<(value: CreateImagesAssetGrantView) => void> = [];
  const revoked: string[] = [];
  let calls = 0;
  const manager = new AssetPreviewLifecycleManager({
    now: () => now,
    loadTimeoutMs: 1_000,
    retryBaseMs: 1_000,
    retryMaxMs: 1_000,
    timers: {
      set: (callback) => {
        timers.push(callback);
        return callback;
      },
      clear: () => undefined,
    },
    load: async (assetId) => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => lateLoads.push(resolve));
      return grant(assetId, "retry-token", now + 60_000);
    },
    revoke: async (token) => {
      revoked.push(token);
    },
  });

  manager.setAssets(["asset-1"]);
  manager.retain("asset-1");
  assert.equal(manager.status("asset-1"), "loading");
  timers.shift()?.();
  await settle();
  assert.equal(manager.status("asset-1"), "retrying");

  now = 2_000;
  manager.refresh();
  await settle();
  assert.equal(calls, 2);
  assert.equal(manager.snapshot()["asset-1"]?.token, "retry-token");

  lateLoads[0]?.(grant("asset-1", "late-token", now + 60_000));
  await settle();
  assert.deepEqual(revoked, ["late-token"]);
  await manager.dispose();
});

test("development effect replay cancels deferred preview disposal", async () => {
  const revoked: string[] = [];
  const manager = new AssetPreviewLifecycleManager({
    timers: NO_TIMERS,
    load: async (assetId) => grant(assetId, "live-token", Date.now() + 60_000),
    revoke: async (token) => {
      revoked.push(token);
    },
  });

  const cancelReplayCleanup = deferAssetPreviewLifecycleDisposal(manager);
  cancelReplayCleanup();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  manager.setAssets(["asset-1"]);
  manager.retain("asset-1");
  await settle();

  assert.equal(manager.snapshot()["asset-1"]?.token, "live-token");
  assert.deepEqual(revoked, []);
  await manager.dispose();
  assert.deepEqual(revoked, ["live-token"]);
});

test("a terminal renewal failure keeps the usable URL but still prunes it at expiry", async () => {
  let now = 1_000;
  let calls = 0;
  const revoked: string[] = [];
  const manager = new AssetPreviewLifecycleManager({
    now: () => now,
    timers: NO_TIMERS,
    load: async (assetId) => {
      calls += 1;
      if (calls > 1) throw new AssetPreviewLoadError("forbidden", false);
      return grant(assetId, "usable-token", 61_000);
    },
    revoke: async (token) => {
      revoked.push(token);
    },
  });

  manager.setAssets(["asset-1"]);
  manager.retain("asset-1");
  await settle();
  now = 50_000;
  manager.refresh();
  await settle();
  assert.equal(manager.snapshot()["asset-1"]?.token, "usable-token");
  now = 61_000;
  manager.refresh();
  assert.equal(manager.snapshot()["asset-1"], undefined);
  assert.equal(calls, 2);
  assert.deepEqual(revoked, ["usable-token"]);
  await manager.dispose();
});

test("an adopted import grant is pruned and revoked when its asset leaves the draft", async () => {
  const revoked: string[] = [];
  const manager = new AssetPreviewLifecycleManager({
    timers: NO_TIMERS,
    load: async () => {
      throw new Error("not expected");
    },
    revoke: async (token) => {
      revoked.push(token);
    },
  });
  manager.adopt("asset-1", grant("asset-1", "import-token", Date.now() + 60_000));
  assert.equal(manager.snapshot()["asset-1"]?.token, "import-token");
  manager.setAssets([]);
  assert.deepEqual(manager.snapshot(), {});
  assert.deepEqual(revoked, ["import-token"]);
  await manager.dispose();
});

test("same-digest adoption hands ownership to an existing mounted node", async () => {
  const revoked: string[] = [];
  const manager = new AssetPreviewLifecycleManager({
    timers: NO_TIMERS,
    load: async (assetId) => grant(assetId, "loaded-token", Date.now() + 60_000),
    revoke: async (token) => {
      revoked.push(token);
    },
  });
  manager.setAssets(["asset-1"]);
  const release = manager.retain("asset-1");
  await settle();

  manager.adopt("asset-1", grant("asset-1", "same-digest-token", Date.now() + 60_000));
  assert.equal(manager.snapshot()["asset-1"]?.token, "same-digest-token");
  assert.deepEqual(revoked, ["loaded-token"]);

  release();
  assert.deepEqual(manager.snapshot(), {});
  assert.deepEqual(revoked, ["loaded-token", "same-digest-token"]);
  await manager.dispose();
});

test("repeated image delivery failures back off until a confirmed image load", async () => {
  let now = 1_000;
  let calls = 0;
  const manager = new AssetPreviewLifecycleManager({
    now: () => now,
    timers: NO_TIMERS,
    retryBaseMs: 1_000,
    retryMaxMs: 4_000,
    load: async (assetId) => grant(assetId, `token-${++calls}`, now + 60_000),
    revoke: async () => undefined,
  });
  manager.setAssets(["asset-1"]);
  manager.retain("asset-1");
  await settle();

  manager.reportLoadError("asset-1", "token-1");
  manager.refresh();
  assert.equal(calls, 1);
  now = 2_000;
  manager.refresh();
  await settle();
  assert.equal(calls, 2);

  manager.reportLoadError("asset-1", "token-2");
  now = 3_999;
  manager.refresh();
  assert.equal(calls, 2);
  now = 4_000;
  manager.refresh();
  await settle();
  assert.equal(calls, 3);

  manager.reportLoadSuccess("asset-1", "token-3");
  manager.reportLoadError("asset-1", "token-3");
  now = 4_999;
  manager.refresh();
  assert.equal(calls, 3);
  now = 5_000;
  manager.refresh();
  await settle();
  assert.equal(calls, 4);
  await manager.dispose();
});

test("virtualized node release revokes its grant and remount requests one replacement", async () => {
  let calls = 0;
  const revoked: string[] = [];
  const manager = new AssetPreviewLifecycleManager({
    timers: NO_TIMERS,
    load: async (assetId) => grant(assetId, `token-${++calls}`, Date.now() + 60_000),
    revoke: async (token) => {
      revoked.push(token);
    },
  });
  manager.setAssets(["asset-1"]);
  const release = manager.retain("asset-1");
  await settle();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(revoked, ["token-1"]);
  assert.deepEqual(manager.snapshot(), {});

  manager.retain("asset-1");
  await settle();
  assert.equal(calls, 2);
  assert.equal(manager.snapshot()["asset-1"]?.token, "token-2");
  await manager.dispose();
});
