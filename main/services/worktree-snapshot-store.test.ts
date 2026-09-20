import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { WorktreeSnapshotStore, WorktreeSnapshotStoreError } from "./worktree-snapshot-store.js";
import {
  MAX_WORKTREE_SNAPSHOTS,
  parseWorktreeSnapshotRecord,
  worktreeSnapshotRef,
  type WorktreeSnapshotRecord,
} from "./worktree-snapshot-store-core.js";

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-snapshot-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function snapshotRecord(overrides: Partial<WorktreeSnapshotRecord> = {}): Omit<
  WorktreeSnapshotRecord,
  "provisionedFiles"
> & {
  provisionedFiles: WorktreeSnapshotRecord["provisionedFiles"];
} {
  const id = "11111111-2222-4333-8444-555555555555";
  return {
    id,
    repositoryCommonDir: "/repos/example/.git",
    repositoryPath: "/repos/example",
    branch: "codex/feature",
    baseCommit: "a".repeat(40),
    snapshotCommit: "b".repeat(40),
    snapshotRef: worktreeSnapshotRef(id),
    originalWorktreePath: "/userData/worktrees/example-abc/codex-feature-1234",
    originalName: "example · codex/feature",
    owner: "manual",
    workspaceSubdir: "",
    provisionedFiles: [],
    createdAt: 1_000,
    expiresAt: 1_000 + 30 * 24 * 60 * 60 * 1_000,
    ...overrides,
  };
}

async function storeAt(
  t: test.TestContext,
  options: ConstructorParameters<typeof WorktreeSnapshotStore>[0] = {},
): Promise<{ store: WorktreeSnapshotStore; root: string }> {
  const root = await temporaryDirectory(t);
  const store = new WorktreeSnapshotStore({ root: () => root, ...options });
  await store.initialize();
  return { store, root };
}

test("snapshot store records, reads, and removes snapshot records", async (t) => {
  const { store } = await storeAt(t);
  const record = await store.record(snapshotRecord());
  assert.equal(record.id, "11111111-2222-4333-8444-555555555555");
  assert.equal((await store.get(record.id))?.branch, "codex/feature");
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.listForRepository("/repos/example/.git")).length, 1);
  assert.equal((await store.listForRepository("/repos/other/.git")).length, 0);

  await store.remove(record.id);
  assert.equal(await store.get(record.id), undefined);
  assert.equal((await store.list()).length, 0);
});

test("snapshot store rejects invalid and duplicate records", async (t) => {
  const { store } = await storeAt(t);
  await assert.rejects(
    store.record(snapshotRecord({ id: "not-a-uuid" })),
    (error) => error instanceof WorktreeSnapshotStoreError && error.code === "invalid",
  );
  await assert.rejects(
    store.record(snapshotRecord({ snapshotRef: "refs/heads/other" })),
    (error) => error instanceof WorktreeSnapshotStoreError && error.code === "invalid",
  );
  await assert.rejects(
    store.record(snapshotRecord({ originalWorktreePath: "relative/path" })),
    (error) => error instanceof WorktreeSnapshotStoreError && error.code === "invalid",
  );
  await assert.rejects(
    store.record(snapshotRecord({ owner: "nobody" as never })),
    (error) => error instanceof WorktreeSnapshotStoreError && error.code === "invalid",
  );

  await store.record(snapshotRecord());
  await assert.rejects(
    store.record(snapshotRecord()),
    (error) => error instanceof WorktreeSnapshotStoreError && error.code === "invalid",
  );
});

test("snapshot store fails closed on a corrupt registry file", async (t) => {
  const { root } = await storeAt(t);
  await fs.writeFile(path.join(root, "snapshots.json"), "{ not json", "utf8");
  const store = new WorktreeSnapshotStore({ root: () => root });
  await assert.rejects(
    store.initialize(),
    (error) => error instanceof WorktreeSnapshotStoreError && error.code === "corrupt",
  );
});

test("snapshot store fails closed on an unsafe registry shape", async (t) => {
  const { root } = await storeAt(t);
  await fs.writeFile(
    path.join(root, "snapshots.json"),
    JSON.stringify({ version: 99, revision: 0, snapshots: [] }),
    "utf8",
  );
  const store = new WorktreeSnapshotStore({ root: () => root });
  await assert.rejects(
    store.initialize(),
    (error) => error instanceof WorktreeSnapshotStoreError && error.code === "unsafe",
  );
});

test("snapshot store reports expired snapshots and evicts them under capacity", async (t) => {
  const data = { value: 1_000 };
  const { store } = await storeAt(t, { now: () => data.value });
  const expired = snapshotRecord({ id: "22222222-3333-4444-8555-666666666666" });
  expired.snapshotRef = worktreeSnapshotRef(expired.id);
  expired.createdAt = 100;
  expired.expiresAt = 500;
  await store.record(expired);
  data.value = 2_000;
  assert.equal((await store.listExpired()).length, 1);

  for (let index = 0; index < MAX_WORKTREE_SNAPSHOTS - 1; index += 1) {
    const suffix = String(index).padStart(12, "0");
    const id = `00000000-0000-4000-8000-${suffix}`;
    await store.record(
      snapshotRecord({ id, snapshotRef: worktreeSnapshotRef(id), expiresAt: undefined }),
    );
  }
  // Registry is at capacity with one expired row: recording evicts the expired one.
  const fresh = snapshotRecord({ id: "99999999-9999-4999-8999-999999999999" });
  fresh.snapshotRef = worktreeSnapshotRef(fresh.id);
  await store.record(fresh);
  assert.equal(await store.get(expired.id), undefined);
  assert.notEqual(await store.get(fresh.id), undefined);
});

test("snapshot store copies provisioned payloads with modes and restores them", async (t) => {
  const { store, root } = await storeAt(t);
  const worktree = await temporaryDirectory(t);
  await fs.mkdir(path.join(worktree, "config"), { recursive: true });
  await fs.writeFile(path.join(worktree, ".env.local"), "SECRET=1\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.writeFile(path.join(worktree, "config", "local.json"), "{}", {
    encoding: "utf8",
    mode: 0o640,
  });
  await fs.symlink(".env.local", path.join(worktree, "config", "link"));

  const id = "33333333-4444-4555-8666-777777777777";
  const stored = await store.storeProvisionedFiles(id, worktree, [
    { relativePath: ".env.local", mode: 0o600 },
    { relativePath: "config/local.json", mode: 0o640 },
    { relativePath: "config/link", mode: 0o777 },
    { relativePath: "config/missing.json", mode: 0o600 },
  ]);
  assert.equal(stored.length, 2);
  assert.equal(stored[0]!.mode, 0o600);
  assert.ok(stored[0]!.storedPath.startsWith(path.join(root, "payloads", id)));
  const payloadStat = await fs.stat(stored[0]!.storedPath);
  assert.equal(payloadStat.mode & 0o777, 0o600);

  const restored = await temporaryDirectory(t);
  await store.restoreProvisionedFiles(snapshotRecord({ id, provisionedFiles: stored }), restored);
  assert.equal(await fs.readFile(path.join(restored, ".env.local"), "utf8"), "SECRET=1\n");
  const restoredStat = await fs.stat(path.join(restored, "config", "local.json"));
  assert.equal(restoredStat.mode & 0o777, 0o640);

  // Existing destination files are never overwritten.
  await fs.writeFile(path.join(restored, ".env.local"), "LOCAL=override\n", "utf8");
  await assert.rejects(
    store.restoreProvisionedFiles(snapshotRecord({ id, provisionedFiles: stored }), restored),
  );
  assert.equal(await fs.readFile(path.join(restored, ".env.local"), "utf8"), "LOCAL=override\n");

  await store.dropPayload(id);
  await assert.rejects(fs.access(path.join(root, "payloads", id)));
});

test("snapshot store enforces provisioned payload budgets", async (t) => {
  const { store } = await storeAt(t, {
    maxProvisionedFiles: 1,
    maxProvisionedFileBytes: 8,
    maxProvisionedTotalBytes: 16,
  });
  const worktree = await temporaryDirectory(t);
  await fs.writeFile(path.join(worktree, "big.txt"), "0123456789abcdef", "utf8");
  await fs.writeFile(path.join(worktree, "a.txt"), "aaaaaaaa", "utf8");
  await fs.writeFile(path.join(worktree, "b.txt"), "bbbbbbbb", "utf8");

  const id = "44444444-5555-4666-8777-888888888888";
  await assert.rejects(
    store.storeProvisionedFiles(id, worktree, [
      { relativePath: "a.txt", mode: 0o600 },
      { relativePath: "b.txt", mode: 0o600 },
    ]),
    (error) => error instanceof WorktreeSnapshotStoreError && error.code === "invalid",
  );
  await assert.rejects(
    store.storeProvisionedFiles(id, worktree, [{ relativePath: "big.txt", mode: 0o600 }]),
    (error) => error instanceof WorktreeSnapshotStoreError && error.code === "invalid",
  );
});

test("snapshot record parser accepts legacy-tolerant optional fields only", () => {
  assert.notEqual(parseWorktreeSnapshotRecord(snapshotRecord()), null);
  assert.equal(parseWorktreeSnapshotRecord(null), null);
  assert.equal(parseWorktreeSnapshotRecord({}), null);
  assert.equal(parseWorktreeSnapshotRecord(snapshotRecord({ id: "not-a-uuid" })), null);
  const withoutOptionals = snapshotRecord();
  delete withoutOptionals.originalName;
  delete withoutOptionals.workspaceSubdir;
  delete withoutOptionals.expiresAt;
  assert.notEqual(parseWorktreeSnapshotRecord(withoutOptionals), null);
  const extra = { ...snapshotRecord(), sneaky: true };
  assert.equal(parseWorktreeSnapshotRecord(extra), null);
});
