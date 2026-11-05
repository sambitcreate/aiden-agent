import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDesignCanvasTools,
  DESIGN_CANVAS_CALLS_PER_TURN,
  designCanvasToolsAllowed,
} from "./canvas-tools.js";
import { DesignCanvasStore } from "./store.js";

async function setup(t: test.TestContext) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-canvas-tools-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace");
  await fs.mkdir(path.join(workspace, "design"), { recursive: true });
  await fs.writeFile(path.join(workspace, "design", "home.html"), "<!doctype html><title>Home</title>");
  await fs.writeFile(path.join(workspace, "design", "hero.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(base, "outside.html"), "<p>secret</p>");
  const store = new DesignCanvasStore({ root: () => path.join(base, "canvases") });
  const broadcasts: { chatId: string; revision: number }[] = [];
  let available = true;
  let next = 0;
  const tools = createDesignCanvasTools({
    chatId: "chat-1",
    workspaceRoot: workspace,
    store,
    broadcast: (update) => broadcasts.push(update),
    stillAvailable: async () => available,
    newId: () => `frame-${++next}`,
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool, `${name} exists`);
    const output = await tool.execute(`call-${name}`, args as never);
    const first = output.content[0];
    assert.ok(first && first.type === "text");
    return JSON.parse(first.text) as Record<string, any>;
  };
  return { base, workspace, store, broadcasts, call, setAvailable: (value: boolean) => (available = value) };
}

test("Aiden places a workspace page, a note and a group, and an open canvas hears about each", async (t) => {
  const { store, broadcasts, call } = await setup(t);
  const page = await call("canvas_place_frame", { kind: "file", title: "Home", path: "design/home.html" });
  assert.equal(page.status, "placed");
  assert.equal(page.units, "canvas");
  assert.deepEqual(
    { kind: page.frame.kind, path: page.frame.path, createdBy: page.frame.createdBy, designWidth: page.frame.designWidth },
    { kind: "file", path: "design/home.html", createdBy: "aiden", designWidth: 1280 },
  );
  const note = await call("canvas_place_frame", { kind: "note", title: "Idea", text: "Warmer hero" });
  const group = await call("canvas_place_frame", { kind: "group", title: "Direction A", x: 0, y: 2000 });

  const doc = await store.get("chat-1");
  assert.deepEqual(doc.frames.map((frame) => frame.id), [page.frame.id, note.frame.id, group.frame.id]);
  assert.equal(doc.frames[1]!.text, "Warmer hero");
  // Without a position the note goes to the right of the page instead of on top of it.
  assert.ok(note.frame.box.x >= page.frame.box.x + page.frame.box.w);
  assert.deepEqual(group.frame.box, { x: 0, y: 2000, w: 640, h: 400 });
  assert.deepEqual(broadcasts.map((update) => update.revision), [1, 2, 3]);
  assert.ok(broadcasts.every((update) => update.chatId === "chat-1"));
});

test("a frame placed into a group sits inside it, and moving the group moves its frames", async (t) => {
  const { store, call } = await setup(t);
  const group = await call("canvas_place_frame", { kind: "group", title: "Direction A", x: 100, y: 100, w: 2000, h: 1200 });
  const member = await call("canvas_place_frame", { kind: "image", title: "Hero", path: "design/hero.png", groupId: group.frame.id });
  assert.equal(member.frame.groupId, group.frame.id);
  assert.ok(member.frame.box.x >= 100 && member.frame.box.y >= 100);

  const moved = await call("canvas_update_frame", { id: group.frame.id, x: 600, y: 100 });
  assert.equal(moved.status, "updated");
  const after = (await store.get("chat-1")).frames.find((frame) => frame.id === member.frame.id)!;
  assert.equal(after.x, member.frame.box.x + 500);
  assert.equal(after.y, member.frame.box.y);

  const ungrouped = await call("canvas_update_frame", { id: member.frame.id, groupId: "" });
  assert.equal(ungrouped.frame.groupId, undefined);
});

test("frames may only show files that exist inside the workspace", async (t) => {
  const { workspace, base, store, broadcasts, call } = await setup(t);
  await fs.symlink(path.join(base, "outside.html"), path.join(workspace, "design", "link.html"));
  for (const bad of ["../outside.html", "/etc/passwd", "design/missing.html", "design/link.html", ".git/config"]) {
    const answer = await call("canvas_place_frame", { kind: "file", title: "Bad", path: bad });
    assert.equal(answer.status, "error", bad);
  }
  const wrongKind = await call("canvas_place_frame", { kind: "file", title: "Picture", path: "design/hero.png" });
  assert.equal(wrongKind.status, "error");
  assert.match(wrongKind.message, /image/u);
  const noGroup = await call("canvas_place_frame", { kind: "note", title: "Lost", groupId: "nope" });
  assert.equal(noGroup.status, "error");
  assert.equal((await store.get("chat-1")).frames.length, 0);
  assert.equal(broadcasts.length, 0, "a refused call changes nothing and announces nothing");
});

test("a frame the person added is removed only with confirm, and removing a group keeps its frames", async (t) => {
  const { store, call } = await setup(t);
  await store.update("chat-1", (doc) => ({
    ...doc,
    frames: [
      { id: "group-p", kind: "group", title: "Mine", x: 0, y: 0, w: 1000, h: 800, createdBy: "person" },
      { id: "note-p", kind: "note", title: "Mine", text: "keep", x: 40, y: 60, w: 240, h: 160, groupId: "group-p", createdBy: "person" },
    ],
  }));
  const refused = await call("canvas_remove_frame", { id: "note-p" });
  assert.equal(refused.status, "error");
  assert.equal((await store.get("chat-1")).frames.length, 2);

  const removed = await call("canvas_remove_frame", { id: "group-p", confirm: true });
  assert.deepEqual(removed, { status: "removed", id: "group-p", personFrame: true });
  const doc = await store.get("chat-1");
  assert.deepEqual(doc.frames.map((frame) => [frame.id, frame.groupId]), [["note-p", undefined]]);

  const unknown = await call("canvas_remove_frame", { id: "gone" });
  assert.equal(unknown.status, "error");
});

test("canvas_read lists what is in view, with open comments, and counts the rest by group", async (t) => {
  const { store, call } = await setup(t);
  await store.update("chat-1", (doc) => ({
    ...doc,
    frames: [
      { id: "page", kind: "file", title: "Home", path: "design/home.html", x: 0, y: 0, w: 640, h: 436, designWidth: 1280, createdBy: "aiden" },
      { id: "far-group", kind: "group", title: "Direction B", x: 50_000, y: 0, w: 1000, h: 800, createdBy: "aiden" },
      { id: "far-note", kind: "note", title: "Far", text: "x", x: 50_100, y: 100, w: 240, h: 160, groupId: "far-group", createdBy: "person" },
    ],
    comments: [
      { id: "c1", frameId: "page", x: 10, y: 10, note: "Bigger", state: "open", anchorState: "anchored", createdAt: "2026-11-05T00:00:00Z" },
      { id: "c2", frameId: "page", x: 10, y: 10, note: "Done", state: "resolved", anchorState: "anchored", createdAt: "2026-11-05T00:00:00Z" },
    ],
  }));
  const answer = await call("canvas_read");
  assert.equal(answer.frameCount, 3);
  assert.equal(answer.openComments, 1);
  assert.deepEqual(answer.inView.map((frame: { id: string }) => frame.id), ["page"]);
  assert.equal(answer.inView[0].openComments, 1);
  assert.deepEqual(answer.outsideView, [{ groupId: "far-group", title: "Direction B", frames: 2 }]);
});

test("a turn makes at most its canvas call budget, and a chat that left design mode gets none", async (t) => {
  const { call, setAvailable } = await setup(t);
  for (let index = 0; index < DESIGN_CANVAS_CALLS_PER_TURN; index += 1) {
    assert.notEqual((await call("canvas_read")).status, "limit_reached");
  }
  assert.equal((await call("canvas_read")).status, "limit_reached");

  const fresh = await setup(t);
  fresh.setAvailable(false);
  const answer = await fresh.call("canvas_place_frame", { kind: "note", title: "Late" });
  assert.equal(answer.status, "unavailable");
  assert.equal((await fresh.store.get("chat-1")).frames.length, 0);
  setAvailable(true);
});

test("only an attended desktop chat with design mode on and a folder gets the canvas tools", () => {
  const base = {
    flagEnabled: true,
    designMode: true,
    localRenderer: true,
    assistant: false,
    telegram: false,
    hasWorkspaceFolder: true,
  };
  assert.equal(designCanvasToolsAllowed(base), true);
  assert.equal(designCanvasToolsAllowed({ ...base, flagEnabled: false }), false);
  assert.equal(designCanvasToolsAllowed({ ...base, designMode: undefined }), false);
  assert.equal(designCanvasToolsAllowed({ ...base, localRenderer: false }), false, "a phone or paired Mac");
  assert.equal(designCanvasToolsAllowed({ ...base, botId: "bot-1" }), false);
  assert.equal(designCanvasToolsAllowed({ ...base, assistant: true }), false);
  assert.equal(designCanvasToolsAllowed({ ...base, telegram: true }), false);
  assert.equal(designCanvasToolsAllowed({ ...base, hasWorkspaceFolder: false }), false);
});
