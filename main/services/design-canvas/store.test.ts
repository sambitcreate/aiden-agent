import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import {
  emptyDesignCanvas,
  type DesignCanvasV1,
} from "../../../renderer/shared/design-canvas/schema.js";
import { writeJsonAtomic } from "../durable-fs.js";
import { DesignCanvasStore } from "./store.js";

async function tempRoot(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-canvas-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, "design-canvases");
}

function withNote(doc: DesignCanvasV1, id: string): DesignCanvasV1 {
  return {
    ...doc,
    frames: [
      ...doc.frames,
      { id, kind: "note", title: id, x: 0, y: 0, w: 200, h: 120, text: id, createdBy: "person" },
    ],
  };
}

test("an unknown chat reads as an empty canvas at revision 0", async (t) => {
  const store = new DesignCanvasStore({ root: () => "/nonexistent-aiden-root" });
  assert.deepEqual(await store.get("chat-1"), emptyDesignCanvas());
  const root = await tempRoot(t);
  assert.deepEqual(
    await new DesignCanvasStore({ root: () => root }).get("chat-1"),
    emptyDesignCanvas(),
  );
});

test("a save at the current revision lands and survives a new store", async (t) => {
  const root = await tempRoot(t);
  const store = new DesignCanvasStore({ root: () => root });
  const result = await store.save("chat-1", withNote(emptyDesignCanvas(), "a"), 0);
  assert.deepEqual(result, { ok: true, revision: 1 });

  const reread = await new DesignCanvasStore({ root: () => root }).get("chat-1");
  assert.equal(reread.revision, 1);
  assert.deepEqual(
    reread.frames.map((frame) => frame.id),
    ["a"],
  );
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(path.join(root, "chat-1.json"))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
  }
});

test("a save from a stale revision conflicts and returns the stored document", async (t) => {
  const root = await tempRoot(t);
  const canvases = new DesignCanvasStore({ root: () => root });
  await canvases.save("chat-1", withNote(emptyDesignCanvas(), "first"), 0);
  const stale = await canvases.save("chat-1", withNote(emptyDesignCanvas(), "second"), 0);
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
    store.save("chat-1", withNote(emptyDesignCanvas(), "left"), 0),
    store.save("chat-1", withNote(emptyDesignCanvas(), "right"), 0),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal((await store.get("chat-1")).revision, 1);
});

test("update runs in order with saves on the same chat", async (t) => {
  const root = await tempRoot(t);
  const store = new DesignCanvasStore({ root: () => root });
  const [saved, updated] = await Promise.all([
    store.save("chat-1", withNote(emptyDesignCanvas(), "person"), 0),
    store.update("chat-1", (doc) => withNote(doc, "aiden")),
  ]);
  assert.deepEqual(saved, { ok: true, revision: 1 });
  assert.equal(updated.revision, 2);
  assert.deepEqual(
    (await store.get("chat-1")).frames.map((frame) => frame.id),
    ["person", "aiden"],
  );
});

test("update refuses a mutation that yields an invalid document", async (t) => {
  const root = await tempRoot(t);
  const store = new DesignCanvasStore({ root: () => root });
  await assert.rejects(store.update("chat-1", () => ({ version: 2 }) as unknown as DesignCanvasV1));
  assert.equal((await store.get("chat-1")).revision, 0);
});

test("a save of an invalid document is refused with its issues", async (t) => {
  const root = await tempRoot(t);
  const store = new DesignCanvasStore({ root: () => root });
  const result = await store.save("chat-1", { version: 2 } as unknown as DesignCanvasV1, 0);
  assert.equal(result.ok, false);
  if (result.ok || result.reason !== "invalid") return assert.fail("expected invalid");
  assert.ok(result.issues.length > 0);
  await assert.rejects(fs.stat(path.join(root, "chat-1.json")), { code: "ENOENT" });
});

test("delete removes the canvas file and the chat reads empty again", async (t) => {
  const root = await tempRoot(t);
  const store = new DesignCanvasStore({ root: () => root });
  await store.save("chat-1", withNote(emptyDesignCanvas(), "a"), 0);
  await store.delete("chat-1");
  await assert.rejects(fs.stat(path.join(root, "chat-1.json")), { code: "ENOENT" });
  assert.equal((await store.get("chat-1")).revision, 0);
  await store.delete("chat-1");
});

test("delete also removes that chat's set-aside corrupt copies and nobody else's", async (t) => {
  const root = await tempRoot(t);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "chat-1.json"), "{ not json");
  await fs.writeFile(path.join(root, "chat-10.json.corrupt-1"), "other");
  const store = new DesignCanvasStore({ root: () => root });
  await store.get("chat-1");
  await store.delete("chat-1");
  assert.deepEqual(await fs.readdir(root), ["chat-10.json.corrupt-1"]);
});

test("a chat id outside the safe pattern throws before touching disk", async () => {
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
  for (const chatId of ["", "../escape", "a/b", "..", ".", "x".repeat(161), "chat\u0000"]) {
    await assert.rejects(store.get(chatId), /Invalid chat id/u, JSON.stringify(chatId));
    await assert.rejects(store.save(chatId, emptyDesignCanvas(), 0), /Invalid chat id/u);
    await assert.rejects(store.delete(chatId), /Invalid chat id/u);
  }
  assert.equal(touched, false);
});

test("a corrupt canvas file reads as empty and is set aside, not overwritten by the next save", async (t) => {
  const root = await tempRoot(t);
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, "chat-1.json");
  await fs.writeFile(file, "{ not json");
  const store = new DesignCanvasStore({ root: () => root });
  assert.deepEqual(await store.get("chat-1"), emptyDesignCanvas());

  assert.deepEqual(await store.save("chat-1", withNote(emptyDesignCanvas(), "fresh"), 0), {
    ok: true,
    revision: 1,
  });
  const asides = (await fs.readdir(root)).filter((name) => name.startsWith("chat-1.json.corrupt-"));
  assert.equal(asides.length, 1);
  assert.equal(await fs.readFile(path.join(root, asides[0]!), "utf8"), "{ not json");
  assert.deepEqual(
    (await store.get("chat-1")).frames.map((frame) => frame.id),
    ["fresh"],
  );
});

test("a canvas file that fails the schema is set aside too", async (t) => {
  const root = await tempRoot(t);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "chat-1.json"), JSON.stringify({ version: 9 }));
  const store = new DesignCanvasStore({ root: () => root });
  assert.deepEqual(await store.get("chat-1"), emptyDesignCanvas());
  const names = await fs.readdir(root);
  assert.equal(names.includes("chat-1.json"), false);
  assert.equal(names.filter((name) => name.startsWith("chat-1.json.corrupt-")).length, 1);
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
  await store.save("chat-1", withNote(emptyDesignCanvas(), "a"), 0);
  fail = true;
  await assert.rejects(store.save("chat-1", withNote(emptyDesignCanvas(), "b"), 1), /disk full/u);
  fail = false;
  const current = await store.get("chat-1");
  assert.equal(current.revision, 1);
  assert.deepEqual(await store.save("chat-1", withNote(current, "b"), 1), {
    ok: true,
    revision: 2,
  });
});

test("a canvas too large to read back is refused and the previous one stays", async (t) => {
  const root = await tempRoot(t);
  const store = new DesignCanvasStore({ root: () => root, maxDocumentBytes: 4096 });
  await store.save("chat-1", withNote(emptyDesignCanvas(), "kept"), 0);
  let big = await store.get("chat-1");
  for (let index = 0; big.frames.length < 40; index += 1) big = withNote(big, `big-${index}`);

  const result = await store.save("chat-1", big, 1);
  assert.equal(result.ok, false);
  if (result.ok || result.reason !== "invalid") return assert.fail("expected invalid");
  await assert.rejects(store.update("chat-1", () => big));

  const current = await store.get("chat-1");
  assert.equal(current.revision, 1);
  assert.deepEqual(
    current.frames.map((frame) => frame.id),
    ["kept"],
  );
});

test("a canvas file over the read cap is set aside instead of being overwritten", async (t) => {
  const root = await tempRoot(t);
  await fs.mkdir(root, { recursive: true });
  const big = JSON.stringify({ ...emptyDesignCanvas(), padding: "x".repeat(8192) });
  await fs.writeFile(path.join(root, "chat-1.json"), big);
  const store = new DesignCanvasStore({ root: () => root, maxDocumentBytes: 4096 });
  assert.deepEqual(await store.get("chat-1"), emptyDesignCanvas());
  await store.save("chat-1", withNote(emptyDesignCanvas(), "fresh"), 0);
  const asides = (await fs.readdir(root)).filter((name) => name.startsWith("chat-1.json.corrupt-"));
  assert.equal(asides.length, 1);
  assert.equal(await fs.readFile(path.join(root, asides[0]!), "utf8"), big);
});
