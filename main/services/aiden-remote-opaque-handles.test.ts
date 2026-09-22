import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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
