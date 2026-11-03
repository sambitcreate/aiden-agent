import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { compileAum } from "../../../renderer/shared/aiden-ui/compile.js";
import { AIDEN_UI_CATALOG_VERSION, type ChatUiVisualV1 } from "../../../renderer/shared/aiden-ui/types.js";
import { WORKSPACE_ARTIFACT_LIMITS, type WorkspaceArtifactSourceV1 } from "../../../renderer/shared/workspace-artifacts.js";
import { WorkspaceArtifactStore, workspaceArtifactDigest, type WorkspaceArtifactContent } from "./store.js";

async function openStore(t: test.TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-artifacts-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let clock = 1_000;
  let ids = 0;
  const make = () => new WorkspaceArtifactStore({ root: () => dir, now: () => (clock += 1), newId: () => `art${++ids}` });
  return { dir, store: make(), reopen: make };
}

function page(title = "Open PRs"): ChatUiVisualV1 {
  const compiled = compileAum(`<Visual title="${title}"><Text>{len($pulls)} open</Text></Visual>`);
  return {
    version: 1,
    kind: "ui",
    id: "pending",
    title,
    catalogVersion: AIDEN_UI_CATALOG_VERSION,
    tree: compiled.tree!,
    fallbackText: compiled.fallbackText,
  };
}

const pulls: WorkspaceArtifactSourceV1 = { name: "pulls", kind: "shell", command: "gh pr list --json number", parse: "json" };

function content(overrides: Partial<WorkspaceArtifactContent> = {}): WorkspaceArtifactContent {
  return { title: "Open PRs", visual: page(), sources: [pulls], actions: [], refresh: { onOpen: true }, ...overrides };
}

test("artifacts persist per workspace and survive a restart", async (t) => {
  const { store, reopen } = await openStore(t);
  const created = await store.create("ws1", content(), { chatId: "chat-1" });
  assert.equal(created.id, "art1");
  assert.equal(created.visual.id, "art1");
  assert.equal(created.revision, 1);
  assert.equal(created.createdByChatId, "chat-1");
  assert.equal(created.approvedDigest, undefined);
  assert.deepEqual(await store.list("ws2"), []);
  const listed = await reopen().list("ws1");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.artifact.visual.title, "Open PRs");
  assert.equal(listed[0]!.digest, workspaceArtifactDigest([pulls], []));
});

test("a workspace keeps titles unique and stops at its artifact limit", async (t) => {
  const { store } = await openStore(t);
  await store.create("ws1", content());
  await assert.rejects(store.create("ws1", content()), /already exists/u);
  for (let index = 1; index < WORKSPACE_ARTIFACT_LIMITS.perWorkspace; index += 1) {
    await store.create("ws1", content({ title: `Page ${index}` }));
  }
  await assert.rejects(store.create("ws1", content({ title: "One more" })), /Update or delete one first/u);
});

test("an approval covers only the exact commands that were approved", async (t) => {
  const { store } = await openStore(t);
  const created = await store.create("ws1", content(), { approved: true });
  assert.equal(created.approvedDigest, workspaceArtifactDigest([pulls], []));

  // Same commands, new page: the approval stays.
  const repaged = await store.replace("ws1", created.id, content({ visual: page("Pulls") , title: "Pulls" }));
  assert.equal(repaged.revision, 2);
  assert.equal(repaged.approvedDigest, created.approvedDigest);
  assert.equal(repaged.visual.title, "Pulls");

  // A changed command drops it until approved again.
  const changed = await store.replace("ws1", created.id, content({ sources: [{ ...pulls, command: "rm -rf ." }] }));
  assert.equal(changed.approvedDigest, undefined);
  await assert.rejects(store.approve("ws1", created.id, created.approvedDigest!), /changed after you looked/u);
  const view = (await store.get("ws1", created.id))!;
  const approved = await store.approve("ws1", created.id, view.digest);
  assert.equal(approved.approvedDigest, view.digest);
});

test("a failed refresh keeps the last good data and drops sources that were removed", async (t) => {
  const { store } = await openStore(t);
  const todo: WorkspaceArtifactSourceV1 = { name: "todo", kind: "file", file: "TODO.md", parse: "lines" };
  const artifact = await store.create("ws1", content({ sources: [pulls, todo] }));
  await store.saveSnapshot("ws1", artifact, {
    pulls: { status: "ok", at: 1, dataJson: "[1]" },
    todo: { status: "ok", at: 1, dataJson: '["a"]' },
  });
  const after = await store.saveSnapshot("ws1", artifact, { pulls: { status: "error", at: 2, error: "gh: offline" } });
  assert.deepEqual(after.sources.pulls, { status: "error", at: 2, error: "gh: offline", dataJson: "[1]" });
  assert.deepEqual(after.sources.todo, { status: "ok", at: 1, dataJson: '["a"]' });

  const narrowed = await store.replace("ws1", artifact.id, content({ sources: [pulls] }));
  const snapshot = await store.saveSnapshot("ws1", narrowed, {});
  assert.deepEqual(Object.keys(snapshot.sources), ["pulls"]);
});

test("deleting an artifact removes its snapshot, and removing the workspace removes its files", async (t) => {
  const { store, dir } = await openStore(t);
  const artifact = await store.create("ws1", content());
  await store.saveSnapshot("ws1", artifact, { pulls: { status: "ok", at: 1, dataJson: "[]" } });
  assert.equal(await store.delete("ws1", artifact.id), true);
  assert.equal(await store.delete("ws1", artifact.id), false);
  assert.deepEqual(await store.list("ws1"), []);

  await store.create("ws1", content());
  await store.removeWorkspace("ws1");
  assert.deepEqual((await fs.readdir(dir)).filter((name) => name.startsWith("ws1")), []);
  assert.deepEqual(await store.list("ws1"), []);
});

test("an entry edited into an invalid shape is set aside, not repaired, and survives later writes", async (t) => {
  const { store, reopen, dir } = await openStore(t);
  await store.create("ws1", content());
  await store.create("ws1", content({ title: "Second" }));
  const file = path.join(dir, "ws1.json");
  const document = JSON.parse(await fs.readFile(file, "utf8")) as { artifacts: Record<string, unknown>[] };
  document.artifacts[0]!.sources = [{ name: "x", kind: "file", file: "../../etc/passwd" }];
  await fs.writeFile(file, JSON.stringify(document));
  const reopened = reopen();
  const listed = await reopened.list("ws1");
  assert.deepEqual(listed.map((view) => view.artifact.visual.title), ["Second"]);
  await reopened.create("ws1", content({ title: "Third" }));
  const written = JSON.parse(await fs.readFile(file, "utf8")) as { unreadable?: { sources: unknown }[] };
  assert.deepEqual(written.unreadable?.[0]?.sources, [{ name: "x", kind: "file", file: "../../etc/passwd" }]);
});

test("page state is saved only while it stays small and wire-safe", async (t) => {
  const { store } = await openStore(t);
  const artifact = await store.create("ws1", content());
  await store.saveState("ws1", artifact.id, { tab: "mine" });
  assert.deepEqual((await store.get("ws1", artifact.id))!.artifact.visual.state, { tab: "mine" });
  await assert.rejects(store.saveState("ws1", artifact.id, { blob: "x".repeat(5_000) }), /too large/u);
  await assert.rejects(store.saveState("ws1", artifact.id, { token: "x" }), /reserved/u);
});

test("ids from outside are checked before they reach the file system", async (t) => {
  const { store } = await openStore(t);
  await assert.rejects(store.list("../escape"), /workspace identifier/u);
  await assert.rejects(store.delete("ws1", "../x"), /artifact identifier/u);
});

test("legacy file-source snapshots are purged before the first list and remain absent on disk", async (t) => {
  const { dir, store, reopen } = await openStore(t);
  const artifact = await store.create("ws1", content({ sources: [{ name: "old", kind: "file", file: "alias.txt", parse: "text" }] }));
  await fs.writeFile(path.join(dir, "ws1.snapshots.json"), JSON.stringify({ version: 1, snapshots: {
    [artifact.id]: { revision: 1, refreshedAt: 1, sources: { old: { status: "ok", at: 1, dataJson: '"LEGACY_PRIVATE_VALUE"' } } },
  } }));
  const listed = await reopen().list("ws1");
  assert.equal(listed[0]!.artifact.sources.length, 1, "legacy definition remains editable");
  assert.equal(listed[0]!.snapshot!.sources.old!.dataJson, undefined);
  assert.equal(JSON.stringify(listed).includes("LEGACY_PRIVATE_VALUE"), false);
  assert.equal((await fs.readFile(path.join(dir, "ws1.snapshots.json"), "utf8")).includes("LEGACY_PRIVATE_VALUE"), false);
});

test("canonical policy changes invalidate validated caches before get while transient IO preserves ordinary data", async (t) => {
  const { dir, store } = await openStore(t);
  const artifact = await store.create("ws1", content({ sources: [{ name: "data", kind: "file", file: "alias.txt", parse: "text" }] }));
  await store.saveSnapshot("ws1", artifact, { data: { status: "ok", at: 1, dataJson: '"previous-data"' } });
  const transient = new WorkspaceArtifactStore({ root: () => dir, fileSourceAllowed: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } });
  assert.equal((await transient.get("ws1", artifact.id))!.snapshot!.sources.data!.dataJson, '"previous-data"');
  const denied = new WorkspaceArtifactStore({ root: () => dir, fileSourceAllowed: async () => false });
  assert.equal((await denied.get("ws1", artifact.id))!.snapshot!.sources.data!.dataJson, undefined);
  await denied.saveSnapshot("ws1", artifact, { data: { status: "error", at: 2, policyDenied: true, error: "denied" } });
  assert.equal((await denied.get("ws1", artifact.id))!.snapshot!.sources.data!.dataJson, undefined);
});
