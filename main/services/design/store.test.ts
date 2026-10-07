import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { writeFileAtomic, writeJsonAtomic } from "../durable-fs.js";
import { MAX_DESIGN_REVISION_BYTES, MAX_DESIGN_TOTAL_BYTES } from "../../../renderer/shared/design/limits.js";
import type { DesignRunRequest } from "../../../renderer/shared/design/types.js";
import { designResumeOffer } from "../../../renderer/shared/design/resume.js";
import { createDesignProjectManifest } from "./manifest-core.js";
import { DesignProjectGate } from "./project-gate.js";
import { DesignStoreError } from "./store-core.js";
import { DesignProjectStore, type DesignChatPort, type DesignProjectStoreOptions } from "./store.js";

const MODEL = { providerId: "openrouter", model: "model-a" };
const EXPLORE: DesignRunRequest = { op: "explore", count: 3, creativeRange: "balanced", aspects: [] };
const page = (label: string) => `<main><h1>${label}</h1></main>`;

function fakeChats() {
  const owners = new Map<string, string>();
  let failedRemoves = 0;
  const port: DesignChatPort = {
    exists: async (chatId) => owners.has(chatId),
    create: async (chatId, projectId) => {
      owners.set(chatId, projectId);
    },
    remove: async (chatId) => {
      if (failedRemoves > 0) {
        failedRemoves -= 1;
        throw new Error("chat deletion interrupted");
      }
      owners.delete(chatId);
    },
  };
  return { port, owners, failNextRemove: () => { failedRemoves += 1; } };
}

async function fixture(t: TestContext, overrides: Partial<DesignProjectStoreOptions> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const chats = fakeChats();
  let counter = 0;
  let now = 1_000_000;
  const reopen = async (extra: Partial<DesignProjectStoreOptions> = {}) => {
    const store = new DesignProjectStore({
      root: async () => root,
      chats: chats.port,
      now: () => now,
      newId: () => `id-${(counter += 1)}`,
      ...overrides,
      ...extra,
    });
    return { store, result: await store.initialize() };
  };
  const { store } = await reopen();
  return { root, chats, store, reopen, tick: () => { now += 1_000; } };
}

async function revisionFiles(root: string, projectId: string): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(root, projectId, "revisions"))).sort();
  } catch {
    return [];
  }
}

async function exploreWith(store: DesignProjectStore, projectId: string, titles: readonly string[], runId = "run-1") {
  await store.beginRun(projectId, { runId, turnId: `turn-${runId}`, request: EXPLORE });
  const revisions: string[] = [];
  for (const title of titles) {
    const accepted = await store.acceptRunArtifact(projectId, runId, {
      toolCallId: `call-${title}`, title, html: page(title), model: MODEL,
    });
    revisions.push(accepted.revisionId);
  }
  return revisions;
}

test("a project and its hidden chat are created together and listed newest first", async (t) => {
  const f = await fixture(t);
  const first = await f.store.create({ title: "Landing" });
  f.tick();
  await f.store.create();
  assert.equal(f.chats.owners.get(first.chatId), first.id);
  assert.deepEqual(f.store.list().map((project) => [project.title, project.health]), [
    ["Untitled design", "ok"],
    ["Landing", "ok"],
  ]);
  const { store } = await f.reopen();
  assert.deepEqual(store.get(first.id), first);
});

test("a stale expected revision returns the latest snapshot instead of writing", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create({ title: "Landing" });
  assert.equal((await f.store.mutate(project.id, project.revision, { op: "rename", title: "Pricing" })).ok, true);
  const stale = await f.store.mutate(project.id, project.revision, { op: "rename", title: "Lost" });
  assert.equal(stale.ok, false);
  assert.equal(stale.ok === false ? stale.reason : undefined, "stale");
  assert.equal(stale.snapshot.title, "Pricing");
  assert.equal(f.store.get(project.id)!.title, "Pricing");
});

test("concurrent mutations against one revision admit exactly one", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  const results = await Promise.all([
    f.store.mutate(project.id, project.revision, { op: "rename", title: "A" }),
    f.store.mutate(project.id, project.revision, { op: "rename", title: "B" }),
  ]);
  assert.deepEqual(results.map((result) => result.ok).sort(), [false, true]);
});

test("a crash between the revision file and the manifest leaves no revision, and the orphan is collected", async (t) => {
  let failManifest = false;
  const f = await fixture(t, {
    io: {
      writeManifest: async (target, value, options) => {
        if (failManifest) throw new Error("power lost");
        await writeJsonAtomic(target, value, options);
      },
    },
  });
  const project = await f.store.create();
  await f.store.beginRun(project.id, { runId: "run-1", turnId: "turn-1", request: EXPLORE });
  failManifest = true;
  await assert.rejects(
    f.store.acceptRunArtifact(project.id, "run-1", { toolCallId: "call-1", title: "Lost", html: page("Lost"), model: MODEL }),
    /power lost/u,
  );
  assert.equal((await revisionFiles(f.root, project.id)).length, 1, "the file landed before the commit point");
  failManifest = false;
  const { store } = await f.reopen();
  assert.deepEqual(await revisionFiles(f.root, project.id), []);
  assert.deepEqual(store.get(project.id)!.revisions, {});
  assert.equal(store.get(project.id)!.runs["run-1"]!.status, "interrupted");
  assert.deepEqual(store.get(project.id)!.directionSets, {}, "nothing was accepted, so no set is kept");
});

test("restart publishes a running run's accepted designs as partial and keeps their files", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  const accepted = await exploreWith(f.store, project.id, ["Calm", "Bold"]);
  const { store } = await f.reopen();
  const snapshot = store.get(project.id)!;
  assert.deepEqual([snapshot.runs["run-1"]!.status, snapshot.runs["run-1"]!.endReason], ["partial", "interrupted"]);
  assert.deepEqual(accepted.map((id) => snapshot.revisions[id]!.state), ["published", "published"]);
  assert.deepEqual(await revisionFiles(f.root, project.id), accepted.map((id) => `${id}.html`).sort());
  assert.equal(store.list()[0]!.health, "interrupted");
});

test("concurrent Resumes of one run admit exactly one under the project gate", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  await exploreWith(f.store, project.id, ["Calm"]);
  await f.store.finishRun(project.id, "run-1", "cancelled");
  const resume: DesignRunRequest = { ...EXPLORE, resumeRunId: "run-1" };
  const results = await Promise.allSettled([
    f.store.beginRun(project.id, { runId: "run-2", turnId: "turn-2", request: resume }),
    f.store.beginRun(project.id, { runId: "run-3", turnId: "turn-3", request: resume }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  const admitted = results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<{ cap: number }>;
  assert.equal(admitted.value.cap, 2);
  const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(refused.reason instanceof DesignStoreError && refused.reason.code === "busy");
  const runs = Object.values(f.store.get(project.id)!.runs);
  assert.equal(runs.filter((run) => run.status === "running").length, 1);
});

test("a referenced file that vanished is marked missing and the project still opens", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  const [revision] = await exploreWith(f.store, project.id, ["Gone"]);
  await f.store.finishRun(project.id, "run-1", "completed");
  await fs.rm(path.join(f.root, project.id, "revisions", `${revision}.html`));
  const { store } = await f.reopen();
  assert.equal(store.get(project.id)!.revisions[revision!]!.state, "missing");
  await assert.rejects(store.readRevision(project.id, revision!), /missing or damaged/u);
  assert.equal(store.list().length, 1);
});

test("a damaged revision is detected on read and marked missing", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  const [revision] = await exploreWith(f.store, project.id, ["Real"]);
  await f.store.finishRun(project.id, "run-1", "completed");
  assert.equal((await f.store.readRevision(project.id, revision!)).html, page("Real"));
  // Same length, different bytes: only the digest can tell.
  await fs.writeFile(path.join(f.root, project.id, "revisions", `${revision}.html`), page("Fake"));
  await assert.rejects(f.store.readRevision(project.id, revision!), /missing or damaged/u);
  assert.equal(f.store.get(project.id)!.revisions[revision!]!.state, "missing");
});

test("an unreadable manifest is listed and never deleted", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "broken-1", "revisions"), { recursive: true });
  await fs.writeFile(path.join(f.root, "broken-1", "manifest.json"), "{ not json");
  await fs.writeFile(path.join(f.root, "broken-1", "revisions", "rev-1.html"), page("kept"));
  const { store } = await f.reopen();
  assert.deepEqual(store.list().map((project) => [project.id, project.health]), [["broken-1", "unreadable"]]);
  assert.equal(store.get("broken-1"), undefined);
  assert.equal(await fs.readFile(path.join(f.root, "broken-1", "manifest.json"), "utf8"), "{ not json");
  assert.deepEqual(await revisionFiles(f.root, "broken-1"), ["rev-1.html"]);
});

test("a mutation rewrites only the manifest", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  const [revision] = await exploreWith(f.store, project.id, ["Stable"]);
  const file = path.join(f.root, project.id, "revisions", `${revision}.html`);
  const before = await fs.stat(file);
  const snapshot = f.store.get(project.id)!;
  assert.equal((await f.store.mutate(project.id, snapshot.revision, { op: "rename", title: "Renamed" })).ok, true);
  const after = await fs.stat(file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("deleting removes the chat and directory, and an interrupted delete resumes at startup", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  await exploreWith(f.store, project.id, ["Doomed"]);
  await f.store.finishRun(project.id, "run-1", "completed");
  await assert.rejects(
    f.store.delete(project.id, 1),
    (error: unknown) => error instanceof DesignStoreError && error.code === "stale",
  );
  f.chats.failNextRemove();
  await assert.rejects(f.store.delete(project.id, f.store.get(project.id)!.revision), /chat deletion interrupted/u);
  assert.deepEqual(f.store.list(), []);
  const { store, result } = await f.reopen();
  assert.deepEqual(result.deleting, [project.id]);
  await store.resumeDeletions();
  assert.equal(f.chats.owners.has(project.chatId), false);
  await assert.rejects(fs.stat(path.join(f.root, project.id)), /ENOENT/u);
  assert.deepEqual(store.list(), []);
});

test("duplicate copies revision files under a new hidden chat", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create({ title: "Original" });
  const [revision] = await exploreWith(f.store, project.id, ["Copied"]);
  await f.store.finishRun(project.id, "run-1", "completed");
  const copy = await f.store.duplicate(project.id);
  assert.notEqual(copy.id, project.id);
  assert.notEqual(copy.chatId, project.chatId);
  assert.equal(copy.title, "Original copy");
  assert.equal(f.chats.owners.get(copy.chatId), copy.id);
  const copiedRevision = Object.values(copy.revisions)[0]!;
  assert.notEqual(copiedRevision.id, revision, "a copy shares no revision identity with its source");
  assert.equal((await f.store.readRevision(copy.id, copiedRevision.id)).html, page("Copied"));
  assert.equal((await f.store.readRevision(project.id, revision!)).html, page("Copied"));
  const [source, duplicate] = await Promise.all([
    fs.stat(path.join(f.root, project.id, "revisions", `${revision}.html`)),
    fs.stat(path.join(f.root, copy.id, "revisions", `${copiedRevision.id}.html`)),
  ]);
  assert.notEqual(duplicate.ino, source.ino, "files are copied, not hard-linked");
  const { store } = await f.reopen();
  assert.deepEqual(store.get(copy.id), copy, "the copy survives a restart unchanged");
});

test("a project whose chat went missing gets it back under the same id", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  f.chats.owners.delete(project.chatId);
  assert.equal(await f.store.ensureChat(project.id), project.chatId);
  assert.equal(f.chats.owners.get(project.chatId), project.id);
});

test("the 250-project quota is enforced", async (t) => {
  const f = await fixture(t, {
    io: { writeManifest: (target, value, options) => writeJsonAtomic(target, value, { ...options, fsync: false }) },
  });
  for (let index = 0; index < 250; index += 1) await f.store.create({ title: `Project ${index}` });
  await assert.rejects(
    f.store.create(),
    (error: unknown) =>
      error instanceof DesignStoreError && error.code === "quota" && /250 design projects/u.test(error.message),
  );
});

const ids = (record: Record<string, unknown>) => new Set(Object.keys(record));
const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((id) => b.has(id));

test("a copy shares no identity or run state with its source and does not offer Resume", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create({ title: "Original" });
  await exploreWith(f.store, project.id, ["Calm", "Bold"]);
  const { store } = await f.reopen(); // a restart ends the run as interrupted
  const source = store.get(project.id)!;
  assert.equal(designResumeOffer(source, "run-1").ok, true, "the source can resume its interrupted Explore");
  assert.equal(store.list()[0]!.health, "interrupted");
  const copy = await store.duplicate(project.id);
  for (const kind of ["screens", "revisions", "directionSets", "runs"] as const) {
    assert.deepEqual(overlap(ids(source[kind]), ids(copy[kind])), [], `${kind} are re-identified`);
    assert.equal(Object.keys(copy[kind]).length, Object.keys(source[kind]).length);
  }
  assert.deepEqual(overlap(new Set(source.canvas.nodes.map((n) => n.id)), new Set(copy.canvas.nodes.map((n) => n.id))), []);
  assert.deepEqual(
    Object.values(copy.runs).map((run) => designResumeOffer(copy, run.id).ok),
    [false],
    "Resume needs the source's conversation, which a copy does not have",
  );
  assert.deepEqual(
    store.list().map((summary) => [summary.id, summary.health]).sort(),
    [[copy.id, "ok"], [project.id, "interrupted"]].sort(),
  );
  const renamed = await store.mutate(copy.id, copy.revision, { op: "rename", title: "Changed" });
  assert.equal(renamed.ok, true);
  assert.equal(store.get(project.id)!.title, "Original", "editing a copy never touches the source");
});

test("a project with a running run can be neither deleted nor duplicated until the run ends", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  await exploreWith(f.store, project.id, ["Live"]);
  const busy = (error: unknown) => error instanceof DesignStoreError && error.code === "busy";
  await assert.rejects(f.store.duplicate(project.id), busy);
  await assert.rejects(f.store.delete(project.id, f.store.get(project.id)!.revision), busy);
  assert.equal(f.store.list().length, 1, "nothing was copied or deleted");
  assert.equal(f.chats.owners.size, 1);
  await f.store.finishRun(project.id, "run-1", "cancelled");
  assert.equal((await f.store.duplicate(project.id)).title, "Untitled design copy");
  await f.store.delete(project.id, f.store.get(project.id)!.revision);
  assert.equal(f.store.get(project.id), undefined);
});

test("mutations that the store refuses as busy come back as a busy result with the latest snapshot", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  await exploreWith(f.store, project.id, ["Rendering"]);
  const snapshot = f.store.get(project.id)!;
  const screen = Object.values(snapshot.screens)[0]!;
  const result = await f.store.mutate(project.id, snapshot.revision, { op: "deleteScreen", screenId: screen.id });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : undefined, "busy");
  assert.deepEqual(result.snapshot, snapshot);
  assert.equal(f.store.get(project.id)!.revision, snapshot.revision, "nothing was written");
  await f.store.finishRun(project.id, "run-1", "cancelled");
  const after = f.store.get(project.id)!;
  assert.equal((await f.store.mutate(project.id, after.revision, { op: "deleteScreen", screenId: screen.id })).ok, true);
  assert.deepEqual(await revisionFiles(f.root, project.id), []);
});

test("a manifest the parser would reject is refused before anything is written", async (t) => {
  let manifestWrites = 0;
  const f = await fixture(t, {
    io: {
      writeManifest: async (target, value, options) => {
        manifestWrites += 1;
        await writeJsonAtomic(target, value, options);
      },
    },
  });
  const project = await f.store.create();
  const manifestPath = path.join(f.root, project.id, "manifest.json");
  const onDisk = await fs.readFile(manifestPath, "utf8");
  const writesBefore = manifestWrites;
  // The renderer-facing parser trims titles; the store must still defend itself against an op it never saw.
  const refused = await f.store.mutate(project.id, project.revision, { op: "rename", title: "  padded  " });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false ? refused.reason : undefined, "invalid");
  assert.equal(manifestWrites, writesBefore, "no write was attempted");
  assert.equal(await fs.readFile(manifestPath, "utf8"), onDisk);
  assert.deepEqual(f.store.get(project.id), project);
  assert.equal((await f.store.mutate(project.id, project.revision, { op: "rename", title: "Padded" })).ok, true);
});

test("an accepted design whose manifest would be refused leaves no revision file behind", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  await f.store.beginRun(project.id, { runId: "run-1", turnId: "turn-1", request: EXPLORE });
  // The manifest parser bounds tool-call ids; nothing upstream of the store has to.
  const toolCallId = "c".repeat(600);
  await assert.rejects(
    f.store.acceptRunArtifact(project.id, "run-1", { toolCallId, title: "Nope", html: page("Nope"), model: MODEL }),
    (error: unknown) => error instanceof DesignStoreError && error.code === "invalid",
  );
  assert.deepEqual(await revisionFiles(f.root, project.id), []);
  assert.deepEqual(f.store.get(project.id)!.revisions, {});
});

test("restart collects orphan revision files and staging leftovers but keeps every referenced file", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  const [kept] = await exploreWith(f.store, project.id, ["Kept"]);
  await f.store.finishRun(project.id, "run-1", "completed");
  const revisions = path.join(f.root, project.id, "revisions");
  await fs.writeFile(path.join(revisions, "orphan-1.html"), page("orphan"));
  await fs.writeFile(path.join(revisions, ".orphan-2.html.1234.tmp"), "half");
  await fs.writeFile(path.join(f.root, project.id, ".manifest.json.1234.tmp"), "{");
  await fs.mkdir(path.join(f.root, ".abandoned.duplicate.tmp", "revisions"), { recursive: true });
  await fs.writeFile(path.join(f.root, ".abandoned.duplicate.tmp", "revisions", "x.html"), "half");
  const { store } = await f.reopen();
  assert.deepEqual(await revisionFiles(f.root, project.id), [`${kept}.html`]);
  assert.deepEqual((await fs.readdir(path.join(f.root, project.id))).sort(), ["manifest.json", "revisions"]);
  assert.deepEqual(await fs.readdir(f.root), [project.id]);
  assert.equal((await store.readRevision(project.id, kept!)).html, page("Kept"));
});

test("a manifest that parses but breaks a store invariant is listed as unreadable and left alone", async (t) => {
  const f = await fixture(t);
  const manifest = createDesignProjectManifest({ id: "odd-1", chatId: "chat-odd", title: "Odd", now: 5 });
  // An empty direction set that no running run is filling cannot come from any transition.
  manifest.directionSets["ghost"] = { id: "ghost", runId: "run-gone", requestedCount: 2, screenIds: [], archived: false };
  await fs.mkdir(path.join(f.root, "odd-1"), { recursive: true });
  await writeJsonAtomic(path.join(f.root, "odd-1", "manifest.json"), manifest);
  const before = await fs.readFile(path.join(f.root, "odd-1", "manifest.json"), "utf8");
  const { store } = await f.reopen();
  assert.deepEqual(store.list().map((project) => [project.id, project.health]), [["odd-1", "unreadable"]]);
  assert.equal(await fs.readFile(path.join(f.root, "odd-1", "manifest.json"), "utf8"), before);
});

test("an unreadable project is deleted only by an explicit call, after a preview that says its contents are unknown", async (t) => {
  const f = await fixture(t);
  const healthy = await f.store.create({ title: "Healthy" });
  await fs.mkdir(path.join(f.root, "broken-1", "revisions"), { recursive: true });
  await fs.writeFile(path.join(f.root, "broken-1", "manifest.json"), "{ not json");
  await fs.writeFile(path.join(f.root, "broken-1", "revisions", "rev-1.html"), page("hold"));
  const { store } = await f.reopen();
  assert.deepEqual(store.previewDelete("broken-1"), { screens: 0, revisions: 0, bytes: 0, references: 0, unreadable: true });
  await store.deleteUnreadable("broken-1");
  await assert.rejects(fs.stat(path.join(f.root, "broken-1")), /ENOENT/u);
  assert.deepEqual(store.list().map((project) => project.id), [healthy.id]);
  const reopened = await f.reopen();
  assert.deepEqual(reopened.store.list().map((project) => project.id), [healthy.id]);
});

test("deleting an unreadable project refuses readable projects, unknown ids and paths that leave the library", async (t) => {
  const f = await fixture(t);
  const healthy = await f.store.create();
  const outside = `${path.basename(f.root)}-outside`;
  const outsidePath = path.join(path.dirname(f.root), outside);
  await fs.mkdir(outsidePath);
  await fs.writeFile(path.join(outsidePath, "precious.txt"), "keep");
  t.after(() => fs.rm(outsidePath, { recursive: true, force: true }));
  for (const [id, code] of [
    [healthy.id, "invalid"],
    ["ghost-1", "not_found"],
    [`../${outside}`, "invalid"],
    [".", "invalid"],
    ["", "invalid"],
  ] as const) {
    await assert.rejects(
      f.store.deleteUnreadable(id),
      (error: unknown) => error instanceof DesignStoreError && error.code === code,
      id,
    );
  }
  assert.equal(await fs.readFile(path.join(outsidePath, "precious.txt"), "utf8"), "keep");
  assert.ok(f.store.get(healthy.id));
  assert.ok((await fs.stat(path.join(f.root, healthy.id))).isDirectory());
});

test("a copy is built beside the library and appears whole or not at all", async (t) => {
  let failCopyManifest = false;
  const f = await fixture(t, {
    io: {
      writeManifest: async (target, value, options) => {
        // Only the duplicate writes its manifest into a `.<id>.duplicate.tmp` staging directory;
        // every other manifest write targets a project directory, so this fails the copy alone.
        if (failCopyManifest && target.includes(".tmp")) throw new Error("disk full");
        await writeJsonAtomic(target, value, options);
      },
    },
  });
  const project = await f.store.create();
  await exploreWith(f.store, project.id, ["Calm"]);
  await f.store.finishRun(project.id, "run-1", "completed");
  failCopyManifest = true;
  await assert.rejects(f.store.duplicate(project.id), /disk full/u);
  assert.deepEqual(await fs.readdir(f.root), [project.id], "no partial copy or staging directory is left");
  assert.equal(f.store.list().length, 1);
  assert.equal(f.chats.owners.size, 1);
});

test("a copy whose revision file is damaged keeps the revision but marks it missing", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  const [revision] = await exploreWith(f.store, project.id, ["Fine", "Hurt"]);
  await f.store.finishRun(project.id, "run-1", "completed");
  // Same length as the original, different bytes: only the digest notices.
  await fs.writeFile(path.join(f.root, project.id, "revisions", `${revision}.html`), "x".repeat(page("Fine").length));
  const copy = await f.store.duplicate(project.id);
  const states = Object.values(copy.revisions).map((entry) => [entry.title, entry.state]).sort();
  assert.deepEqual(states, [["Fine", "missing"], ["Hurt", "published"]]);
  assert.equal(f.store.get(project.id)!.revisions[revision!]!.state, "published", "the source is not touched by the copy");
});

test("the 2 GiB library quota is checked against the copy", async (t) => {
  const f = await fixture(t);
  const MiB = 1024 * 1024;
  // Declared bytes count even when the file is gone, so 32 full projects fill the library without 2 GiB on disk.
  for (let index = 0; index < 32; index += 1) {
    const manifest = createDesignProjectManifest({ id: `big-${index}`, chatId: `chat-${index}`, title: `Big ${index}`, now: 5 });
    for (let screenIndex = 0; screenIndex < 64; screenIndex += 1) {
      const screenId = `s${screenIndex}`;
      const revisionIds = [0, 1, 2, 3].map((n) => `r${screenIndex}-${n}`);
      for (const id of revisionIds) {
        manifest.revisions[id] = {
          id, screenId, runId: "run-gone", toolCallId: id, title: "Big", bytes: MiB / 4, sha256: "a".repeat(64),
          state: "published", createdAt: 1, model: MODEL,
        };
      }
      manifest.screens[screenId] = {
        id: screenId, title: "Big", frame: { preset: "desktop", width: 1440, height: 1024 },
        revisionIds, activeRevisionId: revisionIds[0]!, createdAt: 1,
      };
      manifest.canvas.nodes.push({ id: `n${screenIndex}`, kind: "screen", screenId, x: screenIndex * 100, y: 0 });
    }
    await fs.mkdir(path.join(f.root, manifest.id), { recursive: true });
    await writeJsonAtomic(path.join(f.root, manifest.id, "manifest.json"), manifest, { fsync: false });
  }
  const { store } = await f.reopen();
  assert.equal(store.list().length, 32);
  await assert.rejects(
    store.duplicate("big-0"),
    (error: unknown) => error instanceof DesignStoreError && error.code === "quota" && /2 GiB/u.test(error.message),
  );
  assert.equal(store.list().length, 32);
  assert.equal((await fs.readdir(f.root)).length, 32);
});

test("an unreadable project that was repaired since the library loaded is not deleted", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "broken-1", "revisions"), { recursive: true });
  await fs.writeFile(path.join(f.root, "broken-1", "manifest.json"), "{ not json");
  const { store } = await f.reopen();
  assert.deepEqual(store.list().map((project) => project.health), ["unreadable"]);
  // The user fixes the file by hand while the confirmation sheet is open.
  const repaired = createDesignProjectManifest({ id: "broken-1", chatId: "chat-fixed", title: "Rescued", now: 7 });
  await writeJsonAtomic(path.join(f.root, "broken-1", "manifest.json"), repaired);
  await assert.rejects(
    store.deleteUnreadable("broken-1"),
    (error: unknown) => error instanceof DesignStoreError && error.code === "stale",
  );
  assert.ok((await fs.stat(path.join(f.root, "broken-1", "manifest.json"))).isFile(), "the repaired project survives");
  assert.deepEqual(store.list().map((project) => [project.title, project.health]), [["Rescued", "ok"]]);
});

test("an unreadable project that disappeared since the library loaded is reported gone, not deleted twice", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "broken-1"), { recursive: true });
  await fs.writeFile(path.join(f.root, "broken-1", "manifest.json"), "{ not json");
  const { store } = await f.reopen();
  await fs.rm(path.join(f.root, "broken-1"), { recursive: true });
  await assert.rejects(
    store.deleteUnreadable("broken-1"),
    (error: unknown) => error instanceof DesignStoreError && error.code === "not_found",
  );
  assert.deepEqual(store.list(), []);
});

test("a manifest that cannot even be read lists its project as unreadable instead of failing initialize", async (t) => {
  const f = await fixture(t);
  const healthy = await f.store.create({ title: "Healthy" });
  // readFile of a directory fails with EISDIR, the same class as EACCES on a locked file.
  await fs.mkdir(path.join(f.root, "locked-1", "manifest.json"), { recursive: true });
  const { store } = await f.reopen();
  assert.deepEqual(store.list().map((project) => [project.id, project.health]).sort(), [
    [healthy.id, "ok"],
    ["locked-1", "unreadable"],
  ]);
  await store.deleteUnreadable("locked-1");
  await assert.rejects(fs.stat(path.join(f.root, "locked-1")), /ENOENT/u);
});

test("the store is unavailable until initialize has finished loading every project", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  await exploreWith(f.store, project.id, ["Calm"]); // a restart must interrupt this run and rewrite the manifest
  let armed = true;
  let enteredLoad!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredLoad = resolve;
  });
  let finishLoad!: () => void;
  const finished = new Promise<void>((resolve) => {
    finishLoad = resolve;
  });
  const store = new DesignProjectStore({
    root: async () => f.root,
    chats: f.chats.port,
    io: {
      writeManifest: async (target, value, options) => {
        if (armed) {
          armed = false;
          enteredLoad();
          await finished;
        }
        await writeJsonAtomic(target, value, options);
      },
    },
  });
  const loading = store.initialize();
  await entered; // the load is mid-flight: it is reconciling this project
  await assert.rejects(
    store.create(),
    (error: unknown) => error instanceof DesignStoreError && error.code === "unavailable",
  );
  assert.equal(store.get(project.id), undefined);
  assert.deepEqual(store.list(), []);
  finishLoad();
  await loading;
  assert.equal(store.get(project.id)!.runs["run-1"]!.status, "partial");
});

test("an accepted design's bytes are held against the library quota until its manifest owns them", async (t) => {
  let hold: Promise<void> | undefined;
  let failWrite = false;
  const f = await fixture(t, {
    io: {
      writeRevision: async (target, data, options) => {
        await hold;
        if (failWrite) throw new Error("disk full");
        await writeFileAtomic(target, data, options);
      },
    },
  });
  const source = await f.store.create({ title: "Source" });
  await exploreWith(f.store, source.id, ["Calm"]);
  await f.store.finishRun(source.id, "run-1", "completed");
  const target = await f.store.create({ title: "Target" });
  const sourceBytes = Buffer.byteLength(page("Calm"));
  const incoming = page("Incoming design");
  const incomingBytes = Buffer.byteLength(incoming);
  // Leave exactly enough room for either the copy or the new design, never both.
  await fillLibrary(f.root, MAX_DESIGN_TOTAL_BYTES - Math.max(sourceBytes, incomingBytes) - sourceBytes);
  const crowded = (await f.reopen()).store;
  await crowded.beginRun(target.id, { runId: "run-t", turnId: "turn-t", request: EXPLORE });
  const quota = (error: unknown) => error instanceof DesignStoreError && error.code === "quota";

  let release!: () => void;
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  failWrite = true;
  const accepting = crowded.acceptRunArtifact(target.id, "run-t", {
    toolCallId: "call-in", title: "Incoming", html: incoming, model: MODEL,
  });
  await new Promise((resolve) => setImmediate(resolve)); // the accept is now waiting on its file write
  await assert.rejects(crowded.duplicate(source.id), quota, "the in-flight design leaves no room for a copy");
  release();
  await assert.rejects(accepting, /disk full/u);
  failWrite = false;
  hold = undefined;
  assert.equal((await crowded.duplicate(source.id)).title, "Source copy", "a failed write gives its bytes back");
});

test("a copy in flight holds its bytes against a design accepted in another project", async (t) => {
  let hold: Promise<void> | undefined;
  const f = await fixture(t, {
    io: {
      writeRevision: async (target, data, options) => {
        await hold;
        await writeFileAtomic(target, data, options);
      },
    },
  });
  const source = await f.store.create({ title: "Source" });
  await exploreWith(f.store, source.id, ["Calm"]);
  await f.store.finishRun(source.id, "run-1", "completed");
  const target = await f.store.create({ title: "Target" });
  const incoming = page("Incoming design");
  await fillLibrary(
    f.root,
    MAX_DESIGN_TOTAL_BYTES - Math.max(Buffer.byteLength(page("Calm")), Buffer.byteLength(incoming)) - Buffer.byteLength(page("Calm")),
  );
  const { store } = await f.reopen();
  await store.beginRun(target.id, { runId: "run-t", turnId: "turn-t", request: EXPLORE });
  let release!: () => void;
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const copying = store.duplicate(source.id);
  await new Promise((resolve) => setImmediate(resolve)); // the copy is now waiting on its first file write
  await assert.rejects(
    store.acceptRunArtifact(target.id, "run-t", { toolCallId: "call-in", title: "Incoming", html: incoming, model: MODEL }),
    (error: unknown) => error instanceof DesignStoreError && error.code === "quota",
  );
  release();
  assert.equal((await copying).title, "Source copy");
  assert.deepEqual(await revisionFiles(f.root, target.id), [], "the refused design left no file behind");
});

test("creating a project and its first revision flush the directories that gained entries", async (t) => {
  const flushed: string[] = [];
  const f = await fixture(t, {
    io: {
      syncDirectory: async (directory) => {
        flushed.push(directory);
      },
    },
  });
  flushed.length = 0;
  const project = await f.store.create();
  assert.ok(flushed.includes(f.root), "the library directory holds the new project's entry");
  flushed.length = 0;
  await exploreWith(f.store, project.id, ["First"]);
  assert.ok(flushed.includes(path.join(f.root, project.id)), "the project directory holds the new revisions entry");
});

test("restart tolerates staging directories and directories posing as revision files", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  const [kept] = await exploreWith(f.store, project.id, ["Kept"]);
  await f.store.finishRun(project.id, "run-1", "completed");
  const projectDir = path.join(f.root, project.id);
  // A leftover that is itself a directory, at each level the sweep visits.
  await fs.mkdir(path.join(projectDir, ".manifest.json.9.tmp", "inner"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "revisions", ".x.html.9.tmp", "inner"), { recursive: true });
  // Not a staging name and not a regular file: left alone, and not mistaken for a revision.
  await fs.mkdir(path.join(projectDir, "revisions", "stranger.html"), { recursive: true });
  const errors: string[] = [];
  const { store } = await f.reopen({ onError: (message) => errors.push(message) });
  assert.deepEqual(errors, []);
  assert.deepEqual((await fs.readdir(projectDir)).sort(), ["manifest.json", "revisions"]);
  assert.deepEqual((await fs.readdir(path.join(projectDir, "revisions"))).sort(), [`${kept}.html`, "stranger.html"]);
  assert.equal((await store.readRevision(project.id, kept!)).html, page("Kept"));
});

/** Fill the library with declared-only projects (no files) totalling exactly `bytes`. */
async function fillLibrary(root: string, bytes: number): Promise<void> {
  const perProject = 64 * 1024 * 1024;
  for (let index = 0, remaining = bytes; remaining > 0; index += 1) {
    const projectBytes = Math.min(perProject, remaining);
    remaining -= projectBytes;
    const manifest = createDesignProjectManifest({ id: `fill-${index}`, chatId: `chat-fill-${index}`, title: `Fill ${index}`, now: 5 });
    let left = projectBytes;
    for (let screenIndex = 0; left > 0; screenIndex += 1) {
      const screenId = `s${screenIndex}`;
      const revisionIds: string[] = [];
      for (let n = 0; n < 4 && left > 0; n += 1) {
        const id = `r${screenIndex}-${n}`;
        const size = Math.min(MAX_DESIGN_REVISION_BYTES, left);
        left -= size;
        revisionIds.push(id);
        manifest.revisions[id] = {
          id, screenId, runId: "run-gone", toolCallId: id, title: "Fill", bytes: size, sha256: "a".repeat(64),
          state: "published", createdAt: 1, model: MODEL,
        };
      }
      manifest.screens[screenId] = {
        id: screenId, title: "Fill", frame: { preset: "desktop", width: 1440, height: 1024 },
        revisionIds, activeRevisionId: revisionIds[0]!, createdAt: 1,
      };
      manifest.canvas.nodes.push({ id: `n${screenIndex}`, kind: "screen", screenId, x: screenIndex * 100, y: 0 });
    }
    await fs.mkdir(path.join(root, manifest.id), { recursive: true });
    await writeJsonAtomic(path.join(root, manifest.id, "manifest.json"), manifest, { fsync: false });
  }
}

test("the project gate runs one key's operations in order, independent keys together, and forgets settled keys", async () => {
  const gate = new DesignProjectGate();
  const order: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = gate.run("a", async () => {
    await held;
    order.push("a1");
  });
  const failing = gate.run("a", async () => {
    order.push("a2");
    throw new Error("boom");
  });
  const third = gate.run("a", async () => {
    order.push("a3");
  });
  await gate.run("b", async () => {
    order.push("b");
  });
  assert.deepEqual(order, ["b"], "another key is not blocked");
  assert.ok(gate.pending() >= 1, "key a is still held; whether b's tail is already forgotten is not the claim");
  release();
  await first;
  await assert.rejects(failing, /boom/u);
  await third;
  assert.deepEqual(order, ["b", "a1", "a2", "a3"], "a rejected operation does not stop the queue");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.pending(), 0);
});
