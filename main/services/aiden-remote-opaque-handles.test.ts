import assert from "node:assert/strict";
import test from "node:test";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AidenOpaqueHandleError,
  AidenOpaqueHandleStore,
  inspectAidenFilesystemIdentity,
  type AidenOpaqueHandleClaims,
} from "./aiden-remote-opaque-handles.js";

const claims = (overrides: Partial<AidenOpaqueHandleClaims> = {}): AidenOpaqueHandleClaims => ({
  instanceId: "instance-1",
  deviceId: "device-1",
  workspaceId: "workspace-1",
  rootId: "root-1",
  policyRevision: "policy-1",
  canonicalRootPath: "/approved/root",
  canonicalPath: "/approved/root/project/file.swift",
  filesystemDevice: "device-volume-1",
  filesystemInode: "inode-1",
  expiresAt: 2_000,
  depth: 2,
  snapshotId: "snapshot-1",
  kind: "file",
  ...overrides,
});

function rejectsCode(action: () => unknown, code: string): void {
  assert.throws(action, (error) => error instanceof AidenOpaqueHandleError && error.code === code);
}

test("opaque handles store only a digest and bind identity, root policy, path identity, and snapshot", () => {
  const store = new AidenOpaqueHandleStore({ now: () => 1_000 });
  const token = store.issue("file", claims());
  assert.match(token, /^file_[A-Za-z0-9_-]{43}$/);
  assert.equal(store.storedTokenMaterialForTesting().includes(token), false);
  assert.deepEqual(store.resolve(token, "file", claims(), { now: 1_000 }), claims());
  rejectsCode(() => store.resolve(token, "file", claims({ deviceId: "device-2" }), { now: 1_000 }), "handle_wrong_device");
  rejectsCode(() => store.resolve(token, "file", claims({ workspaceId: "workspace-2" }), { now: 1_000 }), "root_policy_changed");
  rejectsCode(() => store.resolve(token, "file", claims({ workspaceId: undefined }), { now: 1_000 }), "root_policy_changed");
  rejectsCode(() => store.resolve(token, "file", claims({ policyRevision: "policy-2" }), { now: 1_000 }), "root_policy_changed");
  rejectsCode(() => store.resolve(token, "file", claims({ filesystemInode: "inode-2" }), { now: 1_000 }), "filesystem_identity_changed");
  rejectsCode(() => store.resolve(token, "file", claims({ canonicalPath: "/outside/file.swift" }), { now: 1_000 }), "path_outside_root");
  rejectsCode(() => store.resolve(token, "file", claims(), { now: 2_000 }), "handle_expired");
  rejectsCode(() => store.issue("file", claims({ workspaceId: undefined, expiresAt: 3_000 })), "handle_invalid");
});

test("filesystem inspection canonicalizes roots and rejects symlink escapes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiden-handle-root-"));
  const root = path.join(directory, "root");
  const outside = path.join(directory, "outside");
  try {
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(root, "safe.txt"), "safe");
    await writeFile(path.join(outside, "secret.txt"), "secret");
    const safe = await inspectAidenFilesystemIdentity(root, path.join(root, "safe.txt"));
    assert.equal(safe.canonicalPath.startsWith(`${safe.canonicalRootPath}${path.sep}`), true);
    await symlink(path.join(outside, "secret.txt"), path.join(root, "escape.txt"));
    await assert.rejects(() => inspectAidenFilesystemIdentity(root, path.join(root, "escape.txt")), (error) => error instanceof AidenOpaqueHandleError && error.code === "path_outside_root");
    await link(path.join(outside, "secret.txt"), path.join(root, "hardlink.txt"));
    await assert.rejects(() => inspectAidenFilesystemIdentity(root, path.join(root, "hardlink.txt")), (error) => error instanceof AidenOpaqueHandleError && error.code === "path_outside_root");
    const directoryIdentity = await inspectAidenFilesystemIdentity(root, root);
    assert.equal(directoryIdentity.kind, "directory");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("selection handles are atomic single-use even under concurrent consumers", async () => {
  const store = new AidenOpaqueHandleStore({ now: () => 1_000 });
  const selectionClaims = claims({ workspaceId: undefined, snapshotId: undefined, kind: "directory" });
  const token = store.issue("sel", selectionClaims);
  const attempts = await Promise.allSettled([
    Promise.resolve().then(() => store.consumeSelection(token, selectionClaims, () => "workspace-1", 1_000)),
    Promise.resolve().then(() => store.consumeSelection(token, selectionClaims, () => "workspace-2", 1_000)),
  ]);
  assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((entry) => entry.status === "rejected").length, 1);
  const retryStore = new AidenOpaqueHandleStore({ now: () => 1_000 });
  const retryToken = retryStore.issue("sel", selectionClaims);
  assert.throws(() => retryStore.consumeSelection(retryToken, selectionClaims, () => { throw new Error("workspace write failed"); }, 1_000), /workspace write failed/);
  rejectsCode(() => retryStore.consumeSelection(retryToken, selectionClaims, () => "workspace-retried", 1_000), "handle_invalid");
  const fileSelection = claims({ snapshotId: undefined, kind: "file" });
  const fileToken = retryStore.issue("sel", fileSelection);
  rejectsCode(() => retryStore.consumeSelection(fileToken, fileSelection, () => "bad", 1_000), "handle_invalid");
});

test("selection transactions reject async callbacks before invocation and consume promise escape attempts", async () => {
  const selectionClaims = claims({ workspaceId: undefined, snapshotId: undefined, kind: "directory" });
  const asyncStore = new AidenOpaqueHandleStore({ now: () => 1_000 });
  const asyncToken = asyncStore.issue("sel", selectionClaims);
  let invoked = false;
  const asyncMutation = async () => {
    invoked = true;
    return "workspace-async";
  };
  rejectsCode(
    () => asyncStore.consumeSelection(asyncToken, selectionClaims, asyncMutation as unknown as () => never, 1_000),
    "handle_invalid",
  );
  assert.equal(invoked, false);
  assert.equal(asyncStore.consumeSelection(asyncToken, selectionClaims, () => "workspace-sync", 1_000), "workspace-sync");

  const escapedStore = new AidenOpaqueHandleStore({ now: () => 1_000 });
  const escapedToken = escapedStore.issue("sel", selectionClaims);
  const promiseReturningMutation = (() => Promise.resolve("workspace-escaped")) as unknown as () => never;
  rejectsCode(
    () => escapedStore.consumeSelection(escapedToken, selectionClaims, promiseReturningMutation, 1_000),
    "handle_invalid",
  );
  rejectsCode(
    () => escapedStore.consumeSelection(escapedToken, selectionClaims, () => "must-not-retry", 1_000),
    "handle_invalid",
  );
});

test("opaque handle storage prunes consumed and expired entries and fails closed at capacity", () => {
  let now = 1_000;
  const store = new AidenOpaqueHandleStore({ maxEntries: 2, now: () => now });
  const first = store.issue("file", claims({ filesystemInode: "inode-1" }));
  const secondClaims = claims({ filesystemInode: "inode-2" });
  const second = store.issue("file", secondClaims);
  rejectsCode(() => store.issue("file", claims({ filesystemInode: "inode-3" })), "handle_capacity");

  store.resolve(first, "file", claims({ filesystemInode: "inode-1" }), { now, consume: true });
  assert.doesNotThrow(() => store.issue("file", claims({ filesystemInode: "inode-3" })));
  now = 2_000;
  rejectsCode(() => store.resolve(second, "file", secondClaims, { now }), "handle_expired");
  assert.doesNotThrow(() => store.issue("file", claims({ filesystemInode: "inode-4", expiresAt: 3_000 })));
  assert.equal(store.storedTokenMaterialForTesting().length <= 2, true);
});

test("failed identity inspection drains its other path lookup before releasing metadata admission", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-identity-drain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = fsPromises.realpath;
  let release!: () => void;
  let failed!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const failedLookup = new Promise<void>(resolve => { failed = resolve; });
  fsPromises.realpath = (async (...args: Parameters<typeof fsPromises.realpath>) => {
    if (args[0] === root) await held;
    try { return await original(...args); }
    catch (error) { failed(); throw error; }
  }) as typeof fsPromises.realpath;
  syncBuiltinESMExports();
  t.after(() => { fsPromises.realpath = original; syncBuiltinESMExports(); });
  let settled = false;
  const inspection = inspectAidenFilesystemIdentity(root, path.join(root, "missing")).finally(() => { settled = true; });
  const rejection = assert.rejects(inspection, (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  try {
    await failedLookup;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false, "failed candidate must not leave the root lookup detached");
  } finally { release(); }
  await rejection;
});

test("one device cannot take the whole handle store from other paired devices", () => {
  const now = 1_000;
  const store = new AidenOpaqueHandleStore({ maxEntries: 4, maxEntriesPerDevice: 2, now: () => now });
  const phone = (inode: string) => claims({ deviceId: "phone", filesystemInode: inode });
  store.issue("file", phone("1"), { listing: "phone:workspace" });
  store.issue("file", phone("2"), { listing: "phone:workspace" });
  rejectsCode(() => store.issue("file", phone("3")), "handle_capacity");

  const tablet = claims({ deviceId: "tablet", filesystemInode: "t" });
  assert.doesNotThrow(() => store.issue("file", tablet));
  assert.doesNotThrow(() => store.issue("file", { ...tablet, filesystemInode: "t2" }));

  // Re-listing frees the phone's own superseded, never-opened handles.
  store.supersedeListing("phone:workspace");
  const fresh = store.issue("file", phone("3"), { listing: "phone:workspace" });
  assert.deepEqual(store.resolve(fresh, "file", phone("3"), { now }).filesystemInode, "3");
});

test("pressure reclamation prunes expired first, then superseded, then device-local lazy LRU while preserving protected and other-device handles", () => {
  let now = 1_000;
  const store = new AidenOpaqueHandleStore({ maxEntries: 6, maxEntriesPerDevice: 5, now: () => now });
  const dev1 = (inode: string, extra: Partial<AidenOpaqueHandleClaims> = {}) =>
    claims({ deviceId: "device-1", filesystemInode: inode, expiresAt: 10_000, ...extra });
  const dev2 = (inode: string, extra: Partial<AidenOpaqueHandleClaims> = {}) =>
    claims({ deviceId: "device-2", filesystemInode: inode, expiresAt: 10_000, ...extra });

  // Issue 1 handle on device-2 (live lazy page) and 5 handles on device-1 (fills both global 6 and device-1's 5).
  const otherDeviceHandle = store.issue("file", dev2("other-1"), {
    listing: "lazy\u0000device-2\u0000ws\u0000r\u0000d",
    generation: "other-gen-1",
    lazyPage: true,
  });
  const expiringSoon = store.issue("file", dev1("expiring", { expiresAt: 1_500 }), {
    listing: "lazy\u0000device-1\u0000ws\u0000r\u0000d0",
    generation: "gen-0",
    lazyPage: true,
  });
  const supersededUnopened = store.issue("file", dev1("sup-unopened"), {
    listing: "lazy\u0000device-1\u0000ws\u0000r\u0000d1",
    generation: "gen-1",
    lazyPage: true,
  });
  const supersededOpened = store.issue("file", dev1("sup-opened"), {
    listing: "lazy\u0000device-1\u0000ws\u0000r\u0000d1",
    generation: "gen-1",
    lazyPage: true,
  });
  // Opening as a document protects supersededOpened even after its directory generation is superseded.
  store.resolve(supersededOpened, "file", dev1("sup-opened"), { now });
  store.supersedeListing("lazy\u0000device-1\u0000ws\u0000r\u0000d1");

  const dirOlder = store.issue("file", dev1("dir-older", { kind: "directory" }), {
    listing: "lazy\u0000device-1\u0000ws\u0000r\u0000root",
    generation: "gen-root",
    lazyPage: true,
  });
  const dirUntouched = store.issue("file", dev1("dir-untouched", { kind: "directory" }), {
    listing: "lazy\u0000device-1\u0000ws\u0000r\u0000root",
    generation: "gen-root",
    lazyPage: true,
  });
  // Navigating dirOlder moves it ahead of dirUntouched in LRU without making it immortal.
  store.resolve(dirOlder, "file", dev1("dir-older", { kind: "directory" }), { now, navigation: true });

  // 1. Advance past expiringSoon (1,500): expired entry is pruned BEFORE supersededUnopened!
  now = 1_600;
  const issuedAfterExpiry = store.issue("file", dev1("after-expiry"), {
    listing: "lazy\u0000device-1\u0000ws\u0000r\u0000d2",
    generation: "gen-2",
    lazyPage: true,
  });
  rejectsCode(() => store.claimsFor(expiringSoon, "file"), "handle_invalid");
  assert.equal(store.claimsFor(supersededUnopened, "file").filesystemInode, "sup-unopened");
  assert.equal(store.claimsFor(issuedAfterExpiry, "file").filesystemInode, "after-expiry");

  // 2. With no expired entries left, supersededUnopened is reclaimed BEFORE live lazy-page handles.
  const issuedAfterSuperseded = store.issue("file", dev1("after-superseded"), {
    listing: "lazy\u0000device-1\u0000ws\u0000r\u0000d2",
    generation: "gen-2",
    lazyPage: true,
  });
  rejectsCode(() => store.claimsFor(supersededUnopened, "file"), "handle_invalid");
  assert.equal(store.claimsFor(supersededOpened, "file").filesystemInode, "sup-opened");
  assert.equal(store.claimsFor(dirUntouched, "file").filesystemInode, "dir-untouched");
  assert.equal(store.claimsFor(dirOlder, "file").filesystemInode, "dir-older");
  assert.equal(store.claimsFor(issuedAfterSuperseded, "file").filesystemInode, "after-superseded");

  // 3. With no superseded entries left, LRU lazy-page handle (dirUntouched) is reclaimed BEFORE recently navigated dirOlder.
  const saveReserved = store.issue("file", dev1("save-reserved"), { protectedDocument: true });
  rejectsCode(() => store.claimsFor(dirUntouched, "file"), "handle_invalid");
  assert.equal(store.claimsFor(dirOlder, "file").filesystemInode, "dir-older");
  assert.equal(store.claimsFor(supersededOpened, "file").filesystemInode, "sup-opened");
  assert.equal(store.claimsFor(saveReserved, "file").filesystemInode, "save-reserved");

  // 4. Continued pressure CAN still reclaim dirOlder (navigation did not make it immortal), while preserving device-2.
  store.issue("file", dev1("next-1"), { listing: "lazy\u0000device-1\u0000ws\u0000r\u0000d3", generation: "gen-3", lazyPage: true });
  rejectsCode(() => store.claimsFor(dirOlder, "file"), "handle_invalid");
  assert.equal(store.claimsFor(otherDeviceHandle, "file").filesystemInode, "other-1");
  assert.equal(store.storedTokenMaterialForTesting().length <= 6, true);
});

test("retireGeneration retires only the targeted generation and batch assembly protects in-flight handles and rolls back failures", () => {
  const now = 1_000;
  const store = new AidenOpaqueHandleStore({ maxEntries: 4, maxEntriesPerDevice: 4, now: () => now });
  const c = (inode: string, extra: Partial<AidenOpaqueHandleClaims> = {}) =>
    claims({ deviceId: "device-1", filesystemInode: inode, expiresAt: 10_000, ...extra });

  const scope = "lazy\u0000device-1\u0000ws\u0000r\u0000dir";
  const gen1Open = store.issue("file", c("g1-open"), { listing: scope, generation: "gen-1", lazyPage: true });
  const gen1Idle = store.issue("file", c("g1-idle"), { listing: scope, generation: "gen-1", lazyPage: true });
  store.resolve(gen1Open, "file", c("g1-open"), { now });

  // Start gen-2 on the same scope, then retire gen-1 explicitly: gen-2 stays active, gen1Open stays protected.
  store.supersedeListing(scope);
  const gen2Live = store.issue("file", c("g2-live"), { listing: scope, generation: "gen-2", lazyPage: true });
  store.retireGeneration("gen-1");
  const sibling = store.issue("file", c("sib-1"), {
    listing: "lazy\u0000device-1\u0000ws\u0000r\u0000sib",
    generation: "gen-sib",
    lazyPage: true,
  });

  // Store has 4 handles: gen1Open (protected), gen1Idle (superseded), gen2Live (live), sibling (live).
  // Pinning gen2Live and assembling a 3-handle batch (2 files + 1 cursor) can reclaim gen1Idle and sibling,
  // cannot reclaim gen1Open or pinned gen2Live or earlier handles of the batch itself, so the 3rd batch handle hits capacity and rolls back!
  const unpinGen2 = store.pin(gen2Live);
  const failedBatch = store.beginBatch([gen2Live]);
  let b1 = "";
  let b2 = "";
  try {
    b1 = failedBatch.issue("file", c("batch-1"), { listing: "lazy\u0000device-1\u0000ws\u0000r\u0000b", generation: "gen-b", lazyPage: true });
    b2 = failedBatch.issue("file", c("batch-2"), { listing: "lazy\u0000device-1\u0000ws\u0000r\u0000b", generation: "gen-b", lazyPage: true });
    rejectsCode(
      () => failedBatch.issue("cur", c("batch-cur", { kind: undefined, cursorOffset: 200 }), {
        listing: "lazy\u0000device-1\u0000ws\u0000r\u0000b",
        generation: "gen-b",
        lazyPage: true,
      }),
      "handle_capacity",
    );
  } finally {
    failedBatch.dispose();
    unpinGen2();
  }
  // Rollback discarded b1 and b2 (after reclaiming gen1Idle and sibling), while gen1Open and gen2Live survived intact.
  rejectsCode(() => store.claimsFor(gen1Idle, "file"), "handle_invalid");
  rejectsCode(() => store.claimsFor(sibling, "file"), "handle_invalid");
  rejectsCode(() => store.claimsFor(b1, "file"), "handle_invalid");
  rejectsCode(() => store.claimsFor(b2, "file"), "handle_invalid");
  assert.equal(store.claimsFor(gen1Open, "file").filesystemInode, "g1-open");
  assert.equal(store.claimsFor(gen2Live, "file").filesystemInode, "g2-live");

  // A 2-handle batch (1 file + 1 outgoing cursor) fits in the 2 free slots, keeps both alive through commit.
  const okBatch = store.beginBatch([gen2Live]);
  let okFile = "";
  let okCursor = "";
  try {
    okFile = okBatch.issue("file", c("ok-file"), { listing: "lazy\u0000device-1\u0000ws\u0000r\u0000ok", generation: "gen-ok", lazyPage: true });
    okCursor = okBatch.issue("cur", c("ok-cur", { kind: undefined, cursorOffset: 200 }), {
      listing: "lazy\u0000device-1\u0000ws\u0000r\u0000ok",
      generation: "gen-ok",
      lazyPage: true,
    });
    okBatch.commit();
  } finally {
    okBatch.dispose();
  }
  assert.equal(store.claimsFor(okFile, "file").filesystemInode, "ok-file");
  assert.equal(store.claimsFor(okCursor, "cur").cursorOffset, 200);
});
