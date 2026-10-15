import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { WorkflowDocV1 } from "../../../renderer/shared/images/schema.js";
import { StudioAssetStore } from "../studio-assets/store.js";
import { fakeThumbnailer, pngBytes } from "../studio-assets/test-fixture.js";
import { writeJsonAtomic } from "../durable-fs.js";
import { ImageWorkflowLoadError, ImageWorkflowStore } from "./workflow-store.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-image-workflows-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = new StudioAssetStore({ root: () => path.join(root, "assets"), thumbnailer: fakeThumbnailer().thumbnailer });
  await assets.initialize();
  t.after(() => assets.close());
  let clock = 1_000;
  /** Flip a flag to make that kind of JSON write fail, as a full disk or a permissions error would. */
  const faults = { document: false, index: false };
  const issues: string[] = [];
  const open = async () => {
    const store = new ImageWorkflowStore({
      root: () => path.join(root, "create-images"),
      assets,
      now: () => (clock += 1),
      writeJson: (target, value, options) => {
        const isIndex = path.basename(target) === "index.json";
        if (isIndex ? faults.index : faults.document) return Promise.reject(new Error("disk full"));
        return writeJsonAtomic(target, value, options);
      },
      reportIssue: (message) => void issues.push(message),
    });
    await store.initialize();
    return store;
  };
  const documentFile = (id: string) => path.join(root, "create-images", "workflows", `${id}.json`);
  return { root, assets, open, documentFile, faults, issues, store: await open() };
}

test("create, save and reopen round-trip through the documents and the index", async (t) => {
  const { store, open } = await fixture(t);
  const created = await store.create("starter", { model: { provider: "openrouter", id: "google/gemini-3.1-flash-image" } });
  const edited: WorkflowDocV1 = structuredClone(created);
  edited.title = "Bicycles";
  const prompt = edited.nodes.find((node) => node.type === "prompt")!;
  if (prompt.type === "prompt") prompt.data.text = "A red bicycle at dawn";
  assert.deepEqual(await store.save(created.id, 1, edited), { ok: true, revision: 2 });

  const reopened = await open();
  assert.deepEqual(
    reopened.list().map(({ id, title, revision }) => ({ id, title, revision })),
    [{ id: created.id, title: "Bicycles", revision: 2 }],
  );
  const loaded = await reopened.get(created.id);
  assert.equal(loaded?.revision, 2);
  assert.equal(loaded?.createdAt, created.createdAt);
  assert.ok((loaded?.updatedAt ?? 0) > created.updatedAt);
  assert.deepEqual(loaded?.nodes.find((node) => node.type === "prompt")?.data, { text: "A red bicycle at dawn" });
});

test("a stale base revision is a conflict and leaves the file unchanged", async (t) => {
  const { store, documentFile } = await fixture(t);
  const created = await store.create("blank");
  assert.deepEqual(await store.save(created.id, 1, { ...created, title: "One" }), { ok: true, revision: 2 });
  const file = documentFile(created.id);
  const before = await readFile(file, "utf8");
  assert.deepEqual(await store.save(created.id, 1, { ...created, title: "Two" }), { ok: false, reason: "conflict" });
  assert.equal(await readFile(file, "utf8"), before);
});

test("concurrent saves from one base revision: exactly one wins", async (t) => {
  const { store } = await fixture(t);
  const created = await store.create("blank");
  const results = await Promise.all([
    store.save(created.id, 1, { ...created, title: "Left" }),
    store.save(created.id, 1, { ...created, title: "Right" }),
  ]);
  assert.deepEqual(results.map((result) => result.ok).sort(), [false, true]);
  assert.equal((await store.get(created.id))?.revision, 2);
});

test("invalid documents are rejected: unknown keys, cycles, foreign ids and missing assets", async (t) => {
  const { store, assets, documentFile } = await fixture(t);
  const held = await assets.put({ bytes: pngBytes(4, 4, 1) });
  const other = await assets.put({ bytes: pngBytes(4, 4, 2) });
  const blank = await store.create("starter");
  const created: WorkflowDocV1 = {
    ...blank,
    nodes: [...blank.nodes, { id: "keep", type: "image-input", position: { x: 0, y: 0 }, data: { assetId: held.assetId } }],
  };
  assert.deepEqual(await store.save(created.id, 1, created), { ok: true, revision: 2 });
  const generate = created.nodes.find((node) => node.type === "generate-image")!;
  const file = documentFile(created.id);
  const before = await readFile(file, "utf8");
  const cases: unknown[] = [
    { ...created, extra: true },
    { ...created, id: "another-id" },
    { ...created, edges: [...created.edges, { id: "loop", source: generate.id, sourcePort: "images", target: generate.id, targetPort: "references" }] },
    // One real new asset beside a missing one: the whole save is refused, so the real one is not held either.
    {
      ...created,
      nodes: [
        ...created.nodes,
        { id: "fresh", type: "image-input", position: { x: 0, y: 0 }, data: { assetId: other.assetId } },
        { id: "in", type: "image-input", position: { x: 0, y: 0 }, data: { assetId: "b".repeat(64) } },
      ],
    },
  ];
  for (const document of cases) {
    const result = await store.save(created.id, 2, document);
    assert.equal(result.ok, false, JSON.stringify(document).slice(0, 80));
    assert.equal(result.ok ? "" : result.reason, "invalid");
  }
  assert.equal(await readFile(file, "utf8"), before);
  assert.equal((await store.get(created.id))?.revision, 2);
  assert.deepEqual(assets.holders(held.assetId), [{ kind: "images-workflow", id: created.id }]);
  assert.deepEqual(assets.holders(other.assetId), []);
  assert.deepEqual(await store.save("missing", 1, created), { ok: false, reason: "not-found" });
});

test("a save with a dangling edge or a two-node cycle is refused with readable issues", async (t) => {
  const { store } = await fixture(t);
  const created = await store.create("starter");
  const [first, second] = [created.nodes[1]!, { ...created.nodes[1]!, id: "generate-two" }];
  const dangling = { ...created, edges: [...created.edges, { id: "ghost", source: first.id, sourcePort: "images", target: "nowhere", targetPort: "references" }] };
  const cycle = {
    ...created,
    nodes: [...created.nodes, second],
    edges: [
      ...created.edges,
      { id: "forward", source: first.id, sourcePort: "images", target: second.id, targetPort: "references" },
      { id: "back", source: second.id, sourcePort: "images", target: first.id, targetPort: "references" },
    ],
  };
  const refused = await store.save(created.id, 1, dangling);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : (refused.issues ?? []).join(" "), /no longer exists/u);
  const cyclic = await store.save(created.id, 1, cycle);
  assert.equal(cyclic.ok, false);
  assert.match(cyclic.ok ? "" : (cyclic.issues ?? []).join(" "), /Cycles/u);
  assert.equal((await store.get(created.id))?.revision, 1);
});

test("Image Input assets are held by their workflow and released on delete", async (t) => {
  const { store, assets } = await fixture(t);
  const asset = await assets.put({ bytes: pngBytes(4, 4, 1) });
  const created = await store.create("blank");
  const withImage: WorkflowDocV1 = {
    ...created,
    nodes: [{ id: "in", type: "image-input", position: { x: 0, y: 0 }, data: { assetId: asset.assetId } }],
  };
  assert.equal((await store.save(created.id, 1, withImage)).ok, true);
  assert.deepEqual(assets.holders(asset.assetId), [{ kind: "images-workflow", id: created.id }]);

  const copy = await store.duplicate(created.id);
  assert.ok(copy && copy.id !== created.id && copy.revision === 1);
  assert.deepEqual(
    assets.holders(asset.assetId).map((holder) => holder.id).sort(),
    [created.id, copy.id].sort(),
  );

  assert.equal(await store.delete(created.id), true);
  assert.deepEqual(assets.holders(asset.assetId), [{ kind: "images-workflow", id: copy.id }]);
  assert.equal(await store.get(created.id), null);
  assert.deepEqual(store.list().map((entry) => entry.id), [copy.id]);
});

test("rename bumps the revision and a missing or corrupt index is rebuilt from the documents", async (t) => {
  const { store, open, root } = await fixture(t);
  const first = await store.create("blank", { title: "First" });
  const second = await store.create("starter");
  assert.deepEqual(await store.rename(first.id, "Renamed"), { ok: true, revision: 2 });
  assert.equal((await store.rename(first.id, "   ")).ok, false);

  const index = path.join(root, "create-images", "index.json");
  await writeFile(index, "{not json");
  const reopened = await open();
  assert.deepEqual(
    reopened.list().map(({ id, title }) => ({ id, title })).sort((a, b) => a.id.localeCompare(b.id)),
    [{ id: first.id, title: "Renamed" }, { id: second.id, title: second.title }].sort((a, b) => a.id.localeCompare(b.id)),
  );
  await rm(index);
  assert.equal((await open()).list().length, 2);
});

test("an index that disagrees with the directory is rebuilt", async (t) => {
  const { store, open, documentFile } = await fixture(t);
  const kept = await store.create("blank", { title: "Kept" });
  const removed = await store.create("blank", { title: "Removed by hand" });
  await rm(documentFile(removed.id));
  assert.deepEqual((await open()).list().map((entry) => entry.id), [kept.id]);
});

test("a hand-edited cycle or dangling edge refuses to open, and the other workflows still list and open", async (t) => {
  const { store, open, documentFile, root } = await fixture(t);
  const good = await store.create("starter", { title: "Good" });
  const cyclic = await store.create("starter", { title: "Cyclic" });
  const dangling = await store.create("starter", { title: "Dangling" });
  const unreadable = await store.create("blank", { title: "Unreadable" });

  const edit = async (id: string, change: (doc: WorkflowDocV1) => void) => {
    const doc = JSON.parse(await readFile(documentFile(id), "utf8")) as WorkflowDocV1;
    change(doc);
    await writeFile(documentFile(id), JSON.stringify(doc));
  };
  await edit(cyclic.id, (doc) => {
    const first = doc.nodes[1]!;
    doc.nodes.push({ ...first, id: "generate-two" });
    doc.edges.push(
      { id: "forward", source: first.id, sourcePort: "images", target: "generate-two", targetPort: "references" },
      { id: "back", source: "generate-two", sourcePort: "images", target: first.id, targetPort: "references" },
    );
  });
  await edit(dangling.id, (doc) => {
    doc.edges.push({ id: "ghost", source: doc.nodes[1]!.id, sourcePort: "images", target: "nowhere", targetPort: "references" });
  });
  await writeFile(documentFile(unreadable.id), "{ this is not json");

  // The cached index is only a cache: with it gone, every well-formed document is re-read.
  await rm(path.join(root, "create-images", "index.json"));
  const reopened = await open();
  const listed = reopened.list().map((entry) => entry.id);
  assert.ok(listed.includes(good.id));
  assert.ok(!listed.includes(unreadable.id), "an unparseable file is left on disk but not indexed");
  assert.equal(await readFile(documentFile(unreadable.id), "utf8"), "{ this is not json");
  assert.equal((await reopened.get(good.id))?.title, "Good");

  const refusals = new Map<string, ImageWorkflowLoadError>();
  for (const id of [cyclic.id, dangling.id]) {
    await assert.rejects(reopened.get(id), (error: unknown) => {
      assert.ok(error instanceof ImageWorkflowLoadError);
      assert.equal(error.code, "invalid_graph");
      refusals.set(id, error);
      return true;
    });
  }
  assert.match(refusals.get(cyclic.id)!.message, /can't be opened.*Cycles/u);
  assert.match(refusals.get(dangling.id)!.message, /can't be opened.*no longer exists/u);
  assert.deepEqual(refusals.get(dangling.id)!.issues, ["This connection points at a node that no longer exists."]);

  // Nothing else republishes a broken document either, and nothing repaired it on disk.
  assert.deepEqual(await reopened.rename(dangling.id, "Renamed"), {
    ok: false,
    reason: "invalid",
    issues: ["This connection points at a node that no longer exists."],
  });
  await assert.rejects(reopened.duplicate(cyclic.id), ImageWorkflowLoadError);
  assert.ok(JSON.parse(await readFile(documentFile(dangling.id), "utf8")).edges.some((edge: { id: string }) => edge.id === "ghost"));
  assert.equal(reopened.list().find((entry) => entry.id === dangling.id)?.title, "Dangling");
});

test("a failed document write leaves the old document and every hold it needs in place", async (t) => {
  const { store, assets, faults, documentFile } = await fixture(t);
  const removed = await assets.put({ bytes: pngBytes(4, 4, 1) });
  const added = await assets.put({ bytes: pngBytes(4, 4, 2) });
  const created = await store.create("blank");
  const withInput = (assetId: string): WorkflowDocV1 => ({
    ...created,
    nodes: [{ id: "in", type: "image-input", position: { x: 0, y: 0 }, data: { assetId } }],
  });
  assert.equal((await store.save(created.id, 1, withInput(removed.assetId))).ok, true);
  const holder = { kind: "images-workflow", id: created.id };
  const before = await readFile(documentFile(created.id), "utf8");

  faults.document = true;
  await assert.rejects(store.save(created.id, 2, withInput(added.assetId)), /disk full/u);
  faults.document = false;

  // The persisted document still references the removed asset, so it must still be held.
  assert.equal(await readFile(documentFile(created.id), "utf8"), before);
  assert.deepEqual(assets.holders(removed.assetId), [holder]);

  // A later successful save settles membership to exactly what the document references.
  assert.deepEqual(await store.save(created.id, 2, withInput(added.assetId)), { ok: true, revision: 3 });
  assert.deepEqual(assets.holders(removed.assetId), []);
  assert.deepEqual(assets.holders(added.assetId), [holder]);
});

test("the index is a cache: a failed index write neither fails a save nor desyncs the list", async (t) => {
  const { store, open, faults, issues } = await fixture(t);
  const created = await store.create("blank");
  faults.index = true;
  assert.deepEqual(await store.save(created.id, 1, { ...created, title: "Saved anyway" }), { ok: true, revision: 2 });
  assert.deepEqual(await store.rename(created.id, "Renamed anyway"), { ok: true, revision: 3 });
  assert.deepEqual(store.list().map(({ title, revision }) => ({ title, revision })), [{ title: "Renamed anyway", revision: 3 }]);
  assert.ok(issues.length >= 2, "each failed index write is reported");
  faults.index = false;
  assert.equal((await (await open()).get(created.id))?.revision, 3);
});

test("delete releases the workflow's holds even if the index cannot be rewritten, and removes unindexed files", async (t) => {
  const { store, open, assets, faults, documentFile, root } = await fixture(t);
  const asset = await assets.put({ bytes: pngBytes(4, 4, 1) });
  const created = await store.create("blank");
  const withImage = { ...created, nodes: [{ id: "in", type: "image-input", position: { x: 0, y: 0 }, data: { assetId: asset.assetId } }] };
  assert.equal((await store.save(created.id, 1, withImage)).ok, true);

  faults.index = true;
  assert.equal(await store.delete(created.id), true);
  faults.index = false;
  assert.deepEqual(assets.holders(asset.assetId), []);
  assert.equal(await store.get(created.id), null);
  assert.deepEqual(store.list(), []);

  const unreadable = await store.create("blank");
  await writeFile(documentFile(unreadable.id), "{ not json");
  await rm(path.join(root, "create-images", "index.json"));
  const reopened = await open();
  assert.deepEqual(reopened.list(), [], "the unparseable file is not indexed");
  assert.equal(await reopened.delete(unreadable.id), true);
  await assert.rejects(readFile(documentFile(unreadable.id)), { code: "ENOENT" });
  assert.equal(await reopened.delete(unreadable.id), false);
  assert.equal(await reopened.delete("../escape"), false);
});

test("imageInputAssets lists each workflow's distinct Image Input assets and skips workflows without any", async (t) => {
  const { store, assets } = await fixture(t);
  const first = await assets.put({ bytes: pngBytes(4, 4, 11) });
  const second = await assets.put({ bytes: pngBytes(4, 4, 12) });
  const at = { x: 0, y: 0 };
  const withImages = await store.create("blank");
  assert.deepEqual(
    await store.save(withImages.id, 1, {
      ...withImages,
      nodes: [
        { id: "a", type: "image-input", position: at, data: { assetId: first.assetId } },
        { id: "b", type: "image-input", position: at, data: { assetId: first.assetId } },
        { id: "c", type: "image-input", position: at, data: { assetId: second.assetId } },
      ],
      edges: [],
    }),
    { ok: true, revision: 2 },
  );
  await store.create("blank");
  assert.deepEqual(await store.imageInputAssets(), { [withImages.id]: [first.assetId, second.assetId].sort() });
});
