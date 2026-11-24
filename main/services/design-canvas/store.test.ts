import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import {
  emptyDesignCanvas,
  type DesignCanvas,
} from "../../../renderer/shared/design-canvas/schema.js";
import { addChatPage } from "../../../renderer/shared/design-canvas/chat-pages.js";
import { addPage, deletePage } from "../../../renderer/shared/design-canvas/pages.js";
import { writeJsonAtomic } from "../durable-fs.js";
import { DESIGN_CANVAS_LAYOUT_MARKER, DesignCanvasStore, DesignChatCanvases } from "./store.js";

async function tempRoot(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-canvas-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, "design-canvases");
}

/** A canvas folder already on the v3 layout, so files a test puts there are kept. */
async function v3Root(t: TestContext): Promise<string> {
  const root = await tempRoot(t);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, DESIGN_CANVAS_LAYOUT_MARKER), "");
  return root;
}

function withNote(doc: DesignCanvas, id: string): DesignCanvas {
  return {
    ...doc,
    frames: [
      ...doc.frames,
      { id, kind: "note", title: id, x: 0, y: 0, w: 200, h: 120, text: id, pageId: "page-1", createdBy: "person" },
    ],
  };
}

test("an unknown workspace reads as an empty canvas at revision 0", async (t) => {
  const root = await tempRoot(t);
  assert.deepEqual(
    await new DesignCanvasStore({ root: () => root }).get("ws-1"),
    emptyDesignCanvas(),
  );
});

test("a save at the current revision lands and survives a new store", async (t) => {
  const root = await tempRoot(t);
  const store = new DesignCanvasStore({ root: () => root });
  const result = await store.save("ws-1", withNote(emptyDesignCanvas(), "a"), 0);
  assert.deepEqual(result, { ok: true, revision: 1 });

  const reread = await new DesignCanvasStore({ root: () => root }).get("ws-1");
  assert.equal(reread.revision, 1);
  assert.deepEqual(
    reread.frames.map((frame) => frame.id),
    ["a"],
  );
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(path.join(root, "ws-1.json"))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
  }
});

test("a save from a stale revision conflicts and returns the stored document", async (t) => {
  const root = await tempRoot(t);
  const canvases = new DesignCanvasStore({ root: () => root });
  await canvases.save("ws-1", withNote(emptyDesignCanvas(), "first"), 0);
  const stale = await canvases.save("ws-1", withNote(emptyDesignCanvas(), "second"), 0);
  assert.equal(stale.ok, false);
  if (stale.ok || stale.reason !== "conflict") return assert.fail("expected a conflict");
  assert.equal(stale.doc.revision, 1);
  assert.deepEqual(
    stale.doc.frames.map((frame) => frame.id),
    ["first"],
  );
});

test("two concurrent saves from the same base admit exactly one", async (t) => {
  const root = await tempRoot(t);
  const store = new DesignCanvasStore({ root: () => root });
  const results = await Promise.all([
    store.save("ws-1", withNote(emptyDesignCanvas(), "left"), 0),
    store.save("ws-1", withNote(emptyDesignCanvas(), "right"), 0),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal((await store.get("ws-1")).revision, 1);
});

test("update runs in order with saves on the same workspace", async (t) => {
  const root = await tempRoot(t);
  const store = new DesignCanvasStore({ root: () => root });
  const [saved, updated] = await Promise.all([
    store.save("ws-1", withNote(emptyDesignCanvas(), "person"), 0),
    store.update("ws-1", (doc) => withNote(doc, "aiden")),
  ]);
  assert.deepEqual(saved, { ok: true, revision: 1 });
  assert.equal(updated.revision, 2);
  assert.deepEqual(
    (await store.get("ws-1")).frames.map((frame) => frame.id),
    ["person", "aiden"],
  );
});

test("update refuses a mutation that yields an invalid document", async (t) => {
  const root = await tempRoot(t);
  const store = new DesignCanvasStore({ root: () => root });
  await assert.rejects(store.update("ws-1", () => ({ version: 2 }) as unknown as DesignCanvas));
  assert.equal((await store.get("ws-1")).revision, 0);
});

test("a save of an invalid document is refused with its issues", async (t) => {
  const root = await tempRoot(t);
  const store = new DesignCanvasStore({ root: () => root });
  const result = await store.save("ws-1", { version: 2 } as unknown as DesignCanvas, 0);
  assert.equal(result.ok, false);
  if (result.ok || result.reason !== "invalid") return assert.fail("expected invalid");
  assert.ok(result.issues.length > 0);
  await assert.rejects(fs.stat(path.join(root, "ws-1.json")), { code: "ENOENT" });
});

test("delete removes the canvas file and the workspace reads empty again", async (t) => {
  const root = await tempRoot(t);
  const store = new DesignCanvasStore({ root: () => root });
  await store.save("ws-1", withNote(emptyDesignCanvas(), "a"), 0);
  await store.delete("ws-1");
  await assert.rejects(fs.stat(path.join(root, "ws-1.json")), { code: "ENOENT" });
  assert.equal((await store.get("ws-1")).revision, 0);
  await store.delete("ws-1");
});

test("delete also removes that workspace's set-aside corrupt copies and nobody else's", async (t) => {
  const root = await v3Root(t);
  await fs.writeFile(path.join(root, "ws-1.json"), "{ not json");
  await fs.writeFile(path.join(root, "ws-10.json.corrupt-1"), "other");
  const store = new DesignCanvasStore({ root: () => root });
  await store.get("ws-1");
  await store.delete("ws-1");
  assert.deepEqual((await fs.readdir(root)).sort(), [DESIGN_CANVAS_LAYOUT_MARKER, "ws-10.json.corrupt-1"]);
});

test("refuses workspace ids that fail isWorkspaceArtifactWorkspaceId", async () => {
  let touched = false;
  const store = new DesignCanvasStore({
    root: () => {
      touched = true;
      return "/nonexistent-aiden-root";
    },
    writeJson: async () => {
      touched = true;
    },
  });
  for (const workspaceId of ["", "../escape", "a/b", "..", ".", "x".repeat(129), "ws\u0000", "ws.1", "ws:1", 42]) {
    await assert.rejects(store.get(workspaceId as string), /Invalid workspace id/u, JSON.stringify(workspaceId));
    await assert.rejects(store.save(workspaceId as string, emptyDesignCanvas(), 0), /Invalid workspace id/u);
    await assert.rejects(store.update(workspaceId as string, (doc) => doc), /Invalid workspace id/u);
    await assert.rejects(store.delete(workspaceId as string), /Invalid workspace id/u);
  }
  assert.equal(touched, false);
});

test("a corrupt canvas file reads as empty and is set aside, not overwritten by the next save", async (t) => {
  const root = await v3Root(t);
  const file = path.join(root, "ws-1.json");
  await fs.writeFile(file, "{ not json");
  const store = new DesignCanvasStore({ root: () => root });
  assert.deepEqual(await store.get("ws-1"), emptyDesignCanvas());

  assert.deepEqual(await store.save("ws-1", withNote(emptyDesignCanvas(), "fresh"), 0), {
    ok: true,
    revision: 1,
  });
  const asides = (await fs.readdir(root)).filter((name) => name.startsWith("ws-1.json.corrupt-"));
  assert.equal(asides.length, 1);
  assert.equal(await fs.readFile(path.join(root, asides[0]!), "utf8"), "{ not json");
  assert.deepEqual(
    (await store.get("ws-1")).frames.map((frame) => frame.id),
    ["fresh"],
  );
});

test("a canvas file that fails the schema is set aside too", async (t) => {
  const root = await v3Root(t);
  await fs.writeFile(path.join(root, "ws-1.json"), JSON.stringify({ version: 9 }));
  const store = new DesignCanvasStore({ root: () => root });
  assert.deepEqual(await store.get("ws-1"), emptyDesignCanvas());
  const names = await fs.readdir(root);
  assert.equal(names.includes("ws-1.json"), false);
  assert.equal(names.filter((name) => name.startsWith("ws-1.json.corrupt-")).length, 1);
});

test("a failed write leaves the stored revision unchanged", async (t) => {
  const root = await tempRoot(t);
  let fail = false;
  const store = new DesignCanvasStore({
    root: () => root,
    writeJson: async (target, value, options) => {
      if (fail) throw new Error("disk full");
      await writeJsonAtomic(target, value, options);
    },
  });
  await store.save("ws-1", withNote(emptyDesignCanvas(), "a"), 0);
  fail = true;
  await assert.rejects(store.save("ws-1", withNote(emptyDesignCanvas(), "b"), 1), /disk full/u);
  fail = false;
  const current = await store.get("ws-1");
  assert.equal(current.revision, 1);
  assert.deepEqual(await store.save("ws-1", withNote(current, "b"), 1), {
    ok: true,
    revision: 2,
  });
});

test("a canvas too large to read back is refused and the previous one stays", async (t) => {
  const root = await tempRoot(t);
  const store = new DesignCanvasStore({ root: () => root, maxDocumentBytes: 4096 });
  await store.save("ws-1", withNote(emptyDesignCanvas(), "kept"), 0);
  let big = await store.get("ws-1");
  for (let index = 0; big.frames.length < 40; index += 1) big = withNote(big, `big-${index}`);

  const result = await store.save("ws-1", big, 1);
  assert.equal(result.ok, false);
  if (result.ok || result.reason !== "invalid") return assert.fail("expected invalid");
  await assert.rejects(store.update("ws-1", () => big));

  const current = await store.get("ws-1");
  assert.equal(current.revision, 1);
  assert.deepEqual(
    current.frames.map((frame) => frame.id),
    ["kept"],
  );
});

test("a save that fits only without the pages remembered as taken off is refused, and the stored canvas still reads back", async (t) => {
  const root = await v3Root(t);
  const removedPagePaths = Array.from({ length: 30 }, (_, index) => `pages/${"p".repeat(80)}-${index}.html`);
  await fs.writeFile(path.join(root, "ws-1.json"), JSON.stringify({ ...emptyDesignCanvas(), revision: 1, removedPagePaths }));
  const store = new DesignCanvasStore({ root: () => root, maxDocumentBytes: 4096 });
  let doc = await store.get("ws-1");
  assert.equal(doc.removedPagePaths?.length, 30);
  for (let index = 0; index < 12; index += 1) doc = withNote(doc, `note-${index}`);
  const { removedPagePaths: _remembered, ...saved } = doc;
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) < 4096, "the saved canvas alone fits");

  const result = await store.save("ws-1", saved, 1);
  assert.equal(result.ok, false);
  if (result.ok || result.reason !== "invalid") return assert.fail("expected invalid");
  const current = await store.get("ws-1");
  assert.equal(current.revision, 1, "the stored canvas was not replaced by one too large to read");
  assert.equal(current.removedPagePaths?.length, 30);
});

test("a canvas file over the read cap is set aside instead of being overwritten", async (t) => {
  const root = await v3Root(t);
  const big = JSON.stringify({ ...emptyDesignCanvas(), padding: "x".repeat(8192) });
  await fs.writeFile(path.join(root, "ws-1.json"), big);
  const store = new DesignCanvasStore({ root: () => root, maxDocumentBytes: 4096 });
  assert.deepEqual(await store.get("ws-1"), emptyDesignCanvas());
  await store.save("ws-1", withNote(emptyDesignCanvas(), "fresh"), 0);
  const asides = (await fs.readdir(root)).filter((name) => name.startsWith("ws-1.json.corrupt-"));
  assert.equal(asides.length, 1);
  assert.equal(await fs.readFile(path.join(root, asides[0]!), "utf8"), big);
});

function chatCanvases(root: string, workspaces: Record<string, string | null>) {
  const store = new DesignCanvasStore({ root: () => root });
  return { store, chats: new DesignChatCanvases({ store, workspaceIdOf: async (chatId) => workspaces[chatId] ?? null }) };
}

const v2Document = {
  version: 2,
  revision: 3,
  pages: [{ id: "page-1", name: "Page 1", viewport: { x: 0, y: 0, zoom: 1 } }],
  activePageId: "page-1",
  frames: [],
  comments: [],
};

test("once a workspace's record is gone, its canvas is refused and no file is written back", async (t) => {
  const root = await tempRoot(t);
  const store = new DesignCanvasStore({ root: () => root });
  const records = new Set(["ws-1"]);
  const chats = new DesignChatCanvases({
    store,
    workspaceIdOf: async () => "ws-1",
    workspaceExists: async (workspaceId) => records.has(workspaceId),
  });
  await chats.save("chat-a", withNote(emptyDesignCanvas(), "a"), 0);
  // The workspace is removed: its record goes, then its canvas file.
  records.delete("ws-1");
  await store.delete("ws-1");
  const gone = /This workspace is no longer available/u;
  await assert.rejects(chats.save("chat-a", withNote(emptyDesignCanvas(), "late"), 1), gone);
  await assert.rejects(chats.update("chat-a", (doc) => withNote(doc, "late"), { workspaceId: "ws-1" }), gone);
  await assert.rejects(chats.get("chat-a"), gone);
  assert.deepEqual(await fs.readdir(root), [DESIGN_CANVAS_LAYOUT_MARKER], "nothing brings ws-1.json back");
});

test("a write that saw the workspace live before its removal does not bring the deleted canvas back", async (t) => {
  const root = await tempRoot(t);
  const store = new DesignCanvasStore({ root: () => root });
  const records = new Set(["ws-1"]);
  let checks = 0;
  let releaseFirstCheck: () => void = () => undefined;
  const firstCheckHeld = new Promise<void>((resolve) => {
    releaseFirstCheck = resolve;
  });
  let firstCheckAnswered: () => void = () => undefined;
  const firstCheckMade = new Promise<void>((resolve) => {
    firstCheckAnswered = resolve;
  });
  const chats = new DesignChatCanvases({
    store,
    workspaceIdOf: async () => "ws-1",
    workspaceExists: async (workspaceId) => {
      const live = records.has(workspaceId);
      // The save's early check answers "live", then waits while the removal runs.
      if (++checks === 1) {
        firstCheckAnswered();
        await firstCheckHeld;
      }
      return live;
    },
  });
  const pending = chats.save("chat-a", withNote(emptyDesignCanvas(), "late"), 0);
  await firstCheckMade;
  // The removal: the record goes, then the canvas file's delete is queued and finishes.
  records.delete("ws-1");
  await store.delete("ws-1");
  releaseFirstCheck();
  await assert.rejects(pending, /This workspace is no longer available/u);
  assert.deepEqual(await fs.readdir(root), [DESIGN_CANVAS_LAYOUT_MARKER], "ws-1.json stays deleted");
});

test("two chats of one workspace read and write the same document", async (t) => {
  const root = await tempRoot(t);
  const { chats } = chatCanvases(root, { "chat-a": "ws-1", "chat-b": "ws-1" });
  const saved = await chats.save("chat-a", withNote(emptyDesignCanvas(), "from-a"), 0);
  assert.deepEqual(saved, { result: { ok: true, revision: 1 }, workspaceId: "ws-1" });
  const read = await chats.get("chat-b");
  assert.equal(read.workspaceId, "ws-1");
  assert.deepEqual(read.doc.frames.map((frame) => frame.id), ["from-a"]);
  const updated = await chats.update("chat-b", (doc) => withNote(doc, "from-b"));
  assert.equal(updated.workspaceId, "ws-1");
  assert.equal(updated.doc.revision, 2);
  // Chat A's next save from its old revision now conflicts with B's change.
  const stale = await chats.save("chat-a", withNote(emptyDesignCanvas(), "again"), 1);
  assert.equal(stale.result.ok, false);
  assert.deepEqual((await fs.readdir(root)).sort(), [DESIGN_CANVAS_LAYOUT_MARKER, "ws-1.json"]);
});

test("chats of different workspaces get different documents", async (t) => {
  const root = await tempRoot(t);
  const { chats } = chatCanvases(root, { "chat-a": "ws-1", "chat-b": "ws-2" });
  await chats.save("chat-a", withNote(emptyDesignCanvas(), "a"), 0);
  const other = await chats.get("chat-b");
  assert.equal(other.workspaceId, "ws-2");
  assert.deepEqual(other.doc, emptyDesignCanvas());
});

test("a chat that is gone has no canvas, and a workspace the caller resolved is used as it is", async (t) => {
  const root = await tempRoot(t);
  const { chats } = chatCanvases(root, { "chat-a": "ws-1" });
  await assert.rejects(chats.get("gone"), /no longer available/u);
  await assert.rejects(chats.update("gone", (doc) => doc), /no longer available/u);
  await assert.rejects(chats.get("../x"), /Invalid chat id/u);
  // The handler resolved ws-2 from the chat it checked; the store does not look again.
  const read = await chats.update("chat-a", (doc) => withNote(doc, "there"), { workspaceId: "ws-2" });
  assert.equal(read.workspaceId, "ws-2");
  assert.equal((await chats.get("chat-a")).doc.revision, 0, "ws-1 is untouched");
  await assert.rejects(chats.get("chat-a", { workspaceId: "../ws" }), /Invalid workspace id/u);
});

test("first access removes v2 per-chat files and writes the layout marker, once", async (t) => {
  const root = await tempRoot(t);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "chat-1.json"), JSON.stringify(v2Document));
  await fs.writeFile(path.join(root, "chat-1.json.corrupt-1"), "{ not json");
  const { chats } = chatCanvases(root, { "chat-1": "ws-1", "chat-2": "ws-2" });
  assert.deepEqual((await chats.get("chat-1")).doc, emptyDesignCanvas());
  assert.deepEqual(await fs.readdir(root), [DESIGN_CANVAS_LAYOUT_MARKER]);
  // A file that appears afterwards is a v3 one: it stays, through this store and the next.
  await fs.writeFile(path.join(root, "later.txt"), "kept");
  await chats.get("chat-2");
  await chatCanvases(root, {}).store.get("ws-3");
  assert.deepEqual((await fs.readdir(root)).sort(), [DESIGN_CANVAS_LAYOUT_MARKER, "later.txt"]);
});

test("concurrent first calls on different workspaces clear the old files once and lose no save", async (t) => {
  const root = await tempRoot(t);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "chat-1.json"), "{}");
  const store = new DesignCanvasStore({ root: () => root });
  const results = await Promise.all([
    store.save("ws-1", withNote(emptyDesignCanvas(), "one"), 0),
    store.save("ws-2", withNote(emptyDesignCanvas(), "two"), 0),
    store.get("ws-3"),
  ]);
  assert.deepEqual(results.slice(0, 2), [{ ok: true, revision: 1 }, { ok: true, revision: 1 }]);
  assert.deepEqual((await fs.readdir(root)).sort(), [DESIGN_CANVAS_LAYOUT_MARKER, "ws-1.json", "ws-2.json"]);
});

test("a v2 document at a workspace path is set aside as corrupt", async (t) => {
  const root = await v3Root(t);
  await fs.writeFile(path.join(root, "ws-1.json"), JSON.stringify(v2Document));
  const store = new DesignCanvasStore({ root: () => root });
  assert.deepEqual(await store.get("ws-1"), emptyDesignCanvas());
  const names = await fs.readdir(root);
  assert.equal(names.includes("ws-1.json"), false);
  assert.equal(names.filter((name) => name.startsWith("ws-1.json.corrupt-")).length, 1);
});

// Chats' own pages are main's: a person's save is merged with the stored claims.

const pageIdsOf = (doc: DesignCanvas) => doc.pages.map((page) => page.id);

/** A store whose canvas has pages page-1, then each of `ids`, and the given claims, written as main would. */
async function claimedStore(t: TestContext, ids: string[], chatPages: Record<string, string>) {
  const root = await tempRoot(t);
  const real = new DesignCanvasStore({ root: () => root });
  const doc = await real.update("ws-1", (current) => {
    let next = current;
    for (const id of ids) next = addPage(next, id, id);
    return { ...next, chatPages };
  });
  return { store: real, doc };
}

async function saveOk(store: DesignCanvasStore, doc: DesignCanvas, options: Parameters<DesignCanvasStore["save"]>[3] = {}) {
  const current = await store.get("ws-1");
  const result = await store.save("ws-1", doc, current.revision, options);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as Extract<typeof result, { ok: true }>;
}

test("a person's save cannot add or move a claim", async (t) => {
  const { store, doc } = await claimedStore(t, ["P2"], { A: "page-1" });
  const result = await saveOk(store, { ...doc, chatPages: { A: "P2", B: "page-1" } });
  assert.deepEqual((await store.get("ws-1")).chatPages, { A: "page-1" });
  assert.deepEqual(result.chatPages, { A: "page-1" });
  // A save that changes no claim answers with the revision alone.
  const plain = await saveOk(store, withNote(await store.get("ws-1"), "n"));
  assert.deepEqual(Object.keys(plain).sort(), ["ok", "revision"]);
});

test("a stale claim in a save after the chat's own turn does not move it back", async (t) => {
  const { store, doc: held } = await claimedStore(t, ["P", "Q"], { A: "P" });
  // A's turn makes Q its page.
  const turned = await store.update("ws-1", (current) => ({ ...current, chatPages: { A: "Q" } }));
  // A's canvas, still holding {A: P}, saves an unrelated edit at the new revision.
  const result = await store.save("ws-1", withNote({ ...held, revision: turned.revision }, "n"), turned.revision);
  assert.equal(result.ok, true);
  const stored = await store.get("ws-1");
  assert.equal(stored.chatPages.A, "Q");
  assert.deepEqual(stored.frames.map((frame) => frame.id), ["n"]);
});

test("an undo that brings a deleted page back brings its claims back", async (t) => {
  const { store, doc: before } = await claimedStore(t, ["P2"], { B: "P2" });
  await saveOk(store, deletePage(before, "P2"));
  assert.deepEqual((await store.get("ws-1")).chatPages, { B: "page-1" });
  await saveOk(store, before, { undone: [] });
  const stored = await store.get("ws-1");
  assert.deepEqual(pageIdsOf(stored), ["page-1", "P2"]);
  assert.deepEqual(stored.chatPages, { B: "P2" });
});

test("a renderer cannot move another chat's claim to a new page id", async (t) => {
  const { store, doc } = await claimedStore(t, [], { B: "page-1" });
  await saveOk(store, { ...addPage(doc, "P9", "New"), chatPages: { B: "P9" } });
  const stored = await store.get("ws-1");
  assert.deepEqual(pageIdsOf(stored), ["page-1", "P9"]);
  assert.deepEqual(stored.chatPages, { B: "page-1" });
});

test("a page Aiden deletes is recorded, so the person's undo of a later edit cannot resurrect claims for it unless it brings the page back", async (t) => {
  const { store, doc: before } = await claimedStore(t, ["P2"], { B: "P2" });
  await store.update("ws-1", (current) => deletePage(current, "P2"));
  // An undo that does not bring P2 back leaves B where the delete moved it.
  await saveOk(store, withNote(await store.get("ws-1"), "n"));
  assert.deepEqual((await store.get("ws-1")).chatPages, { B: "page-1" });
  // One that does brings B back with it.
  await saveOk(store, before);
  assert.deepEqual((await store.get("ws-1")).chatPages, { B: "P2" });
});

test("a save that deletes a page moves its chats to the first page, even when the renderer's copy forgot them", async (t) => {
  const { store, doc } = await claimedStore(t, ["P2"], { B: "P2" });
  const result = await saveOk(store, { ...deletePage(doc, "P2"), chatPages: {} });
  assert.deepEqual((await store.get("ws-1")).chatPages, { B: "page-1" });
  assert.deepEqual(result.chatPages, { B: "page-1" });
});

test("a save cannot mark a page as following a chat", async (t) => {
  const { store, doc } = await claimedStore(t, ["P2"], {});
  const marked = { ...doc, pages: doc.pages.map((page) => (page.id === "P2" ? { ...page, namedFor: "A" } : page)) };
  const result = await saveOk(store, marked);
  assert.equal((await store.get("ws-1")).pages.find((page) => page.id === "P2")?.namedFor, undefined);
  assert.deepEqual(result.namedFor, {});
});

test("a chat deleted or moved after its page was deleted is not brought back by undoing the delete", async (t) => {
  const { store, doc: before } = await claimedStore(t, ["P2"], { B: "P2", C: "P2", D: "P2" });
  await saveOk(store, deletePage(before, "P2"));
  // B is deleted and C moves away: main drops both entries. D stays.
  await store.update("ws-1", (current) => ({ ...current, chatPages: { D: "page-1" } }));
  await saveOk(store, before);
  assert.deepEqual((await store.get("ws-1")).chatPages, { D: "P2" });
});

test("undoing the delete of a page made for a chat that now uses another page brings back its namedFor", async (t) => {
  const root = await tempRoot(t);
  const store = new DesignCanvasStore({ root: () => root });
  const before = await store.update("ws-1", (current) => addChatPage(current, "A", "Landing", "pa"));
  await saveOk(store, deletePage(before, "pa"));
  // A uses another page since.
  await store.update("ws-1", (current) => ({ ...addPage(current, "P3", "Other"), chatPages: { A: "P3" } }));
  // The person's undo: the old document, with the claim carried into it.
  const result = await saveOk(store, { ...addPage(before, "P3", "Other"), chatPages: { A: "P3" } });
  const stored = await store.get("ws-1");
  assert.deepEqual(stored.pages.find((page) => page.id === "pa"), { id: "pa", name: "Landing", namedFor: "A" });
  assert.deepEqual(stored.chatPages, { A: "P3" });
  assert.equal("namedFor" in result, false, "nothing was merged, so the answer is plain");
});

test("a write whose beforeWrite throws leaves the delete record unchanged", async (t) => {
  const { store, doc: before } = await claimedStore(t, ["P2"], { B: "P2" });
  await store.update("ws-1", (current) => deletePage(current, "P2"));
  const current = await store.get("ws-1");
  await assert.rejects(
    store.save("ws-1", before, current.revision, {
      beforeWrite: () => {
        throw new Error("workspace gone");
      },
    }),
    /workspace gone/u,
  );
  assert.deepEqual((await store.get("ws-1")).chatPages, { B: "page-1" });
  // The failed restore did not use up the record.
  await saveOk(store, before);
  assert.deepEqual((await store.get("ws-1")).chatPages, { B: "P2" });
});

test("deleting the same page id twice and undoing restores the claims of the newest delete only", async (t) => {
  const { store, doc: original } = await claimedStore(t, ["P2", "P3"], { B: "P2", D: "P2" });
  await saveOk(store, deletePage(original, "P2"));
  // D uses P3, so the undo brings back only B; D's part of that delete stays recorded.
  await store.update("ws-1", (current) => ({ ...current, chatPages: { ...current.chatPages, D: "P3" } }));
  await saveOk(store, { ...original, chatPages: { B: "P2", D: "P2" } });
  assert.deepEqual((await store.get("ws-1")).chatPages, { B: "P2", D: "P3" });
  // D goes back to Page 1, where the first delete moved it, and C joins P2.
  const shared = await store.update("ws-1", (current) => ({ ...current, chatPages: { B: "P2", C: "P2", D: "page-1" } }));
  // The redo deletes P2 again: B and C are on it, D is not.
  await saveOk(store, deletePage(shared, "P2"));
  await store.update("ws-1", (current) => ({ ...current, chatPages: { ...current.chatPages, B: "P3" } }));
  // An undo that claims all three on P2 restores C only: B moved since, and D was not on P2 at this delete.
  await saveOk(store, { ...original, chatPages: { B: "P2", C: "P2", D: "P2" } });
  assert.deepEqual((await store.get("ws-1")).chatPages, { B: "P3", C: "P2", D: "page-1" });
});
