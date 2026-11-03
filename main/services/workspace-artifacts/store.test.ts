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

/** What a tool call passes after the person allowed a card showing exactly these commands. */
function allowed(saved: WorkspaceArtifactContent) {
  return { approvedDigest: workspaceArtifactDigest(saved.sources, saved.actions) };
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
  // A card that showed other commands approves nothing.
  const stale = await store.create("ws1", content({ title: "Stale" }), allowed(content({ sources: [] })));
  assert.equal(stale.approvedDigest, undefined);
  await store.delete("ws1", stale.id);

  const created = await store.create("ws1", content(), allowed(content()));
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

function heading(text: string): ChatUiVisualV1 {
  const compiled = compileAum(`<Visual title="x"><Text>${text}</Text></Visual>`);
  return { ...page(), tree: compiled.tree!, fallbackText: compiled.fallbackText };
}

test("each update keeps the version it replaced, at most five per page, newest first", async (t) => {
  const { store, reopen } = await openStore(t);
  const created = await store.create("ws1", content({ visual: heading("v1") }));
  for (let version = 2; version <= 7; version += 1) {
    await store.replace("ws1", created.id, content({ visual: heading(`v${version}`) }));
  }
  const history = await reopen().history("ws1", created.id);
  assert.deepEqual(
    history.map((entry) => entry.revision),
    [6, 5, 4, 3, 2],
  );
  assert.equal(history[0]!.title, "Open PRs");
  // Nothing was ever allowed here, so every version's commands would need allowing.
  assert.equal(history[0]!.needsApproval, true);

  // Renames, approvals and state saves are not versions.
  await store.rename("ws1", created.id, "Pulls");
  await store.saveState("ws1", created.id, { tab: "mine" });
  const view = (await store.get("ws1", created.id))!;
  await store.approve("ws1", created.id, view.digest);
  assert.equal((await store.history("ws1", created.id)).length, 5);
  assert.deepEqual(await store.earlierRevisions("ws1"), { [created.id]: [6, 5, 4, 3, 2] });
});

test("restore brings an earlier page back as a new revision under the current name, and can itself be undone", async (t) => {
  const { store } = await openStore(t);
  const created = await store.create("ws1", content({ visual: heading("first"), description: "Before" }));
  await store.replace("ws1", created.id, content({ visual: heading("second"), title: "Pulls", description: "After" }));

  const restored = await store.restore("ws1", created.id, 1);
  assert.equal(restored.revision, 3);
  assert.equal(restored.visual.title, "Pulls");
  assert.equal(restored.description, "Before");
  assert.match(restored.visual.fallbackText ?? "", /first/u);

  const history = await store.history("ws1", created.id);
  assert.deepEqual(history.map((entry) => [entry.revision, entry.title]), [
    [2, "Pulls"],
    [1, "Open PRs"],
  ]);
  const undone = await store.restore("ws1", created.id, 2);
  assert.equal(undone.revision, 4);
  assert.match(undone.visual.fallbackText ?? "", /second/u);
});

test("a restore keeps an approval only when it brings back the commands already approved", async (t) => {
  const { store } = await openStore(t);
  const created = await store.create("ws1", content(), allowed(content()));
  const risky = { ...pulls, command: "gh pr list --json number,title" };
  // Revision 2: same commands, new page. Revision 3: different commands.
  await store.replace("ws1", created.id, content({ visual: heading("two") }));
  await store.replace("ws1", created.id, content({ sources: [risky] }), allowed(content({ sources: [risky] })));
  const summaries = await store.history("ws1", created.id);
  assert.deepEqual(
    summaries.map((entry) => [entry.revision, entry.needsApproval]),
    [
      [2, true],
      [1, true],
    ],
  );

  const back = await store.restore("ws1", created.id, 2);
  assert.equal(back.approvedDigest, undefined, "earlier commands must be allowed again");
  const view = (await store.get("ws1", created.id))!;
  await store.approve("ws1", created.id, view.digest);
  const same = await store.restore("ws1", created.id, 1);
  assert.equal(same.approvedDigest, workspaceArtifactDigest([pulls], []));
  // A card for other commands approves nothing; one for revision 3's commands does.
  const unforced = await store.restore("ws1", created.id, 3, allowed(content()));
  assert.equal(unforced.approvedDigest, undefined);
  const forced = await store.restore("ws1", created.id, 3, allowed(content({ sources: [risky] })));
  assert.equal(forced.approvedDigest, workspaceArtifactDigest([risky], []));
});

test("a version needs allowing whenever its commands differ from what the page has allowed, even while the page waits", async (t) => {
  const { store } = await openStore(t);
  const created = await store.create("ws1", content());
  await store.replace("ws1", created.id, content({ visual: heading("two") }));
  await store.replace("ws1", created.id, content({ visual: heading("three"), sources: [] }));
  await store.replace("ws1", created.id, content({ visual: heading("four") }));
  // Nothing was ever allowed: the versions with commands need allowing, the one without does not.
  assert.deepEqual(
    (await store.history("ws1", created.id)).map((entry) => [entry.revision, entry.needsApproval]),
    [
      [3, false],
      [2, true],
      [1, true],
    ],
  );
  const view = (await store.get("ws1", created.id))!;
  await store.approve("ws1", created.id, view.digest);
  assert.deepEqual(
    (await store.history("ws1", created.id)).map((entry) => [entry.revision, entry.needsApproval]),
    [
      [3, false],
      [2, false],
      [1, false],
    ],
  );
});

test("restoring a version that is no longer kept fails clearly", async (t) => {
  const { store } = await openStore(t);
  const created = await store.create("ws1", content());
  for (let version = 2; version <= 7; version += 1) {
    await store.replace("ws1", created.id, content({ visual: heading(`v${version}`) }));
  }
  await assert.rejects(store.restore("ws1", created.id, 1), /Revision 1 of this artifact is no longer kept/u);
  await assert.rejects(store.restore("ws1", created.id, 7), /no longer kept/u);
  assert.equal((await store.get("ws1", created.id))!.artifact.revision, 7);
});

test("deleting a page forgets its earlier versions", async (t) => {
  const { store, reopen } = await openStore(t);
  const created = await store.create("ws1", content());
  const other = await store.create("ws1", content({ title: "Other" }));
  await store.replace("ws1", created.id, content({ visual: heading("two") }));
  await store.replace("ws1", other.id, content({ title: "Other", visual: heading("two") }));
  await store.delete("ws1", created.id);
  assert.deepEqual(await reopen().earlierRevisions("ws1"), { [other.id]: [1] });
});

test("a delete that lands while a replace is still keeping its earlier version leaves no history behind", async (t) => {
  const { store, reopen, dir } = await openStore(t);
  const created = await store.create("ws1", content());
  await store.replace("ws1", created.id, content({ visual: heading("two") }));
  // Start a replace and delete the page before its history write has run.
  const replacing = store.replace("ws1", created.id, content({ visual: heading("three") }));
  const deleting = store.delete("ws1", created.id);
  await replacing;
  assert.equal(await deleting, true);
  assert.deepEqual(await reopen().earlierRevisions("ws1"), {});
  const file = JSON.parse(await fs.readFile(path.join(dir, "ws1.history.json"), "utf8")) as { revisions: object };
  assert.deepEqual(file.revisions, {});
});

test("removing a workspace while a replace is still keeping its earlier version leaves no history file", async (t) => {
  const { store, dir } = await openStore(t);
  const created = await store.create("ws1", content());
  const replacing = store.replace("ws1", created.id, content({ visual: heading("two") }));
  const removing = store.removeWorkspace("ws1");
  await Promise.allSettled([replacing, removing]);
  assert.ok(!(await fs.readdir(dir)).includes("ws1.history.json"));
});

test("a history file that cannot be cleared does not stop a delete", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-artifacts-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const errors: unknown[] = [];
  let ids = 0;
  const store = new WorkspaceArtifactStore({ root: () => dir, newId: () => `art${++ids}`, onHistoryError: (error) => errors.push(error) });
  const created = await store.create("ws1", content());
  await fs.mkdir(path.join(dir, "ws1.history.json"));
  assert.equal(await store.delete("ws1", created.id), true);
  assert.deepEqual(await store.list("ws1"), []);
  assert.equal(errors.length, 1);
});

test("a damaged history file is tolerated: bad entries are dropped and pages still save", async (t) => {
  const { store, reopen, dir } = await openStore(t);
  const created = await store.create("ws1", content());
  await store.replace("ws1", created.id, content({ visual: heading("two") }));
  const file = path.join(dir, "ws1.history.json");
  const document = JSON.parse(await fs.readFile(file, "utf8")) as { revisions: Record<string, Record<string, unknown>[]> };
  const good = document.revisions[created.id]![0]!;
  document.revisions[created.id] = [
    good,
    { ...good, revision: 9, sources: [{ name: "x", kind: "file", file: "../../etc/passwd" }] },
    { ...good, revision: 10, approvedDigest: "f".repeat(64) },
  ];
  (document.revisions as Record<string, unknown>)["../escape"] = [good];
  await fs.writeFile(file, JSON.stringify(document));
  const reopened = reopen();
  assert.deepEqual(await reopened.earlierRevisions("ws1"), { [created.id]: [10, 1] });
  // An approval written into history by hand is never restored.
  assert.equal((await reopened.restore("ws1", created.id, 10)).approvedDigest, undefined);

  await fs.writeFile(file, "{ not json");
  const afterCorruption = reopen();
  const saved = await afterCorruption.replace("ws1", created.id, content({ visual: heading("three") }));
  assert.equal(saved.revision, 4);
  assert.deepEqual(await afterCorruption.earlierRevisions("ws1"), { [created.id]: [3] });
});

test("history that would outgrow its file drops the oldest versions instead of failing the save", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-artifacts-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let clock = 1_000;
  let ids = 0;
  const errors: unknown[] = [];
  const store = new WorkspaceArtifactStore({
    root: () => dir,
    now: () => (clock += 1),
    newId: () => `art${++ids}`,
    historyMaxBytes: 7_000,
    onHistoryError: (error) => errors.push(error),
  });
  const first = await store.create("ws1", content({ visual: heading("a".repeat(800)) }));
  const second = await store.create("ws1", content({ title: "Second", visual: heading("b".repeat(800)) }));
  for (let version = 0; version < 4; version += 1) {
    await store.replace("ws1", first.id, content({ visual: heading(`a${version}`.repeat(400)) }));
    await store.replace("ws1", second.id, content({ title: "Second", visual: heading(`b${version}`.repeat(400)) }));
  }
  assert.deepEqual(errors, []);
  assert.ok((await fs.stat(path.join(dir, "ws1.history.json"))).size <= 7_000);
  const kept = await store.earlierRevisions("ws1");
  // Room for about three versions: the three saved last survive, across both
  // pages (second's 3, first's 4, second's 4), and the older ones went first.
  assert.deepEqual(kept, { [first.id]: [4], [second.id]: [4, 3] });
  assert.equal((await store.get("ws1", first.id))!.artifact.revision, 5);
});

test("a history write that fails is reported, and the update still succeeds", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-artifacts-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const errors: unknown[] = [];
  let ids = 0;
  const store = new WorkspaceArtifactStore({ root: () => dir, newId: () => `art${++ids}`, onHistoryError: (error) => errors.push(error) });
  const created = await store.create("ws1", content());
  // A directory where the history file belongs: the history write cannot land.
  await fs.mkdir(path.join(dir, "ws1.history.json"));
  const saved = await store.replace("ws1", created.id, content({ visual: heading("two") }));
  assert.equal(saved.revision, 2);
  assert.equal((await store.get("ws1", created.id))!.artifact.revision, 2);
  assert.equal(errors.length, 1);
});

test("ids from outside are checked before they reach the file system", async (t) => {
  const { store } = await openStore(t);
  await assert.rejects(store.list("../escape"), /workspace identifier/u);
  await assert.rejects(store.delete("ws1", "../x"), /artifact identifier/u);
});
