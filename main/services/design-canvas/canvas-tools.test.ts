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
import { addPage, showPage } from "../../../renderer/shared/design-canvas/pages.js";
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
      { id: "group-p", kind: "group", title: "Mine", x: 0, y: 0, w: 1000, h: 800, pageId: "page-1", createdBy: "person" },
      { id: "note-p", kind: "note", title: "Mine", text: "keep", x: 40, y: 60, w: 240, h: 160, groupId: "group-p", pageId: "page-1", createdBy: "person" },
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

test("canvas_read lists what is in view, the page's waiting comments, and counts the rest by group", async (t) => {
  const { store, call } = await setup(t);
  await store.update("chat-1", (doc) => ({
    ...doc,
    frames: [
      { id: "page", kind: "file", title: "Home", path: "design/home.html", x: 0, y: 0, w: 640, h: 436, designWidth: 1280, pageId: "page-1", createdBy: "aiden" },
      { id: "far-group", kind: "group", title: "Direction B", x: 50_000, y: 0, w: 1000, h: 800, pageId: "page-1", createdBy: "aiden" },
      { id: "far-note", kind: "note", title: "Far", text: "x", x: 50_100, y: 100, w: 240, h: 160, groupId: "far-group", pageId: "page-1", createdBy: "person" },
    ],
    comments: [
      {
        id: "c1", frameId: "page", x: 10, y: 10, note: "Bigger", state: "open", pageId: "page-1", anchorState: "anchored", createdAt: "2026-11-05T00:00:00Z",
        anchor: { commentId: "c1", selector: "main > h1", text: "Welcome", tag: "h1", sourcePath: "design/home.html:4" },
      },
      { id: "c2", frameId: "page", x: 10, y: 10, note: "Done", state: "resolved", pageId: "page-1", anchorState: "anchored", createdAt: "2026-11-05T00:00:00Z" },
      { id: "c3", x: 5, y: 5, note: "A footer", state: "sent", pageId: "page-1", anchorState: "anchored", createdAt: "2026-11-05T01:00:00Z", sentAt: "2026-11-05T01:00:00Z" },
    ],
  }));
  const answer = await call("canvas_read");
  assert.deepEqual(
    answer.comments,
    [
      { commentId: "c3", page: "Page 1", note: "A footer", at: { x: 5, y: 5, on: "canvas" }, state: "sent" },
      {
        commentId: "c1",
        page: "Page 1",
        note: "Bigger",
        frame: "Home",
        frameId: "page",
        file: "design/home.html",
        element: { tag: "h1", text: "Welcome", selector: "main > h1", source: "design/home.html:4", found: "anchored" },
        state: "open",
      },
    ],
    "open and sent comments, newest first, with what each points at; resolved ones are left out",
  );
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

test("canvas_focus asks the canvas to show frames that exist, and refuses ones that do not", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-canvas-focus-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const store = new DesignCanvasStore({ root: () => base });
  const focused: string[][] = [];
  const tools = createDesignCanvasTools({
    chatId: "chat-1",
    workspaceRoot: base,
    store,
    broadcast: () => undefined,
    focus: (ids) => focused.push(ids),
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const output = await tools.find((tool) => tool.name === name)!.execute("c", args as never);
    const first = output.content[0];
    assert.ok(first && first.type === "text");
    return JSON.parse(first.text) as Record<string, any>;
  };
  assert.equal((await call("canvas_focus", {})).status, "error", "an empty canvas has nothing to show");
  const note = await call("canvas_place_frame", { kind: "note", title: "Idea" });
  assert.equal((await call("canvas_focus", { ids: ["missing"] })).status, "error");
  assert.deepEqual(await call("canvas_focus", { ids: [note.frame.id, note.frame.id] }), { status: "requested", frames: 1 });
  assert.deepEqual(await call("canvas_focus", {}), { status: "requested", frames: 1 });
  assert.deepEqual(focused, [[note.frame.id], []]);
});

test("Aiden reads and places on a page it names, and focusing a frame on another page brings that page on screen", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-canvas-pages-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const store = new DesignCanvasStore({ root: () => base });
  const focused: string[][] = [];
  const tools = createDesignCanvasTools({
    chatId: "chat-1",
    workspaceRoot: base,
    store,
    broadcast: () => undefined,
    focus: (ids) => focused.push(ids),
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const output = await tools.find((tool) => tool.name === name)!.execute("c", args as never);
    const first = output.content[0];
    assert.ok(first && first.type === "text");
    return JSON.parse(first.text) as Record<string, any>;
  };
  await store.update("chat-1", (doc) => addPage(addPage(doc, "p2", "Pricing"), "p3", "Empty"));
  await store.update("chat-1", (doc) => showPage(doc, "page-1"));

  const placed = await call("canvas_place_frame", { kind: "note", title: "Tiers", page: "pricing" });
  assert.equal(placed.status, "placed");
  const home = await call("canvas_read");
  assert.deepEqual(home.page, { id: "page-1", name: "Page 1" });
  assert.equal(home.frameCount, 0, "the note went to the page Aiden named, not the one on screen");
  assert.deepEqual(home.pages.map((page: { name: string; frames: number }) => [page.name, page.frames]), [["Page 1", 0], ["Pricing", 1], ["Empty", 0]]);
  const pricing = await call("canvas_read", { page: "p2" });
  assert.deepEqual(pricing.inView.map((frame: { id: string }) => frame.id), [placed.frame.id]);

  const unknown = await call("canvas_place_frame", { kind: "note", title: "Lost", page: "Nope" });
  assert.equal(unknown.status, "error");
  assert.match(unknown.message, /"Pricing"/u, "the error names the pages there are");

  assert.deepEqual(await call("canvas_focus", { ids: [placed.frame.id] }), { status: "requested", frames: 1 });
  assert.equal((await store.get("chat-1")).activePageId, "p2");
  assert.deepEqual(focused, [[placed.frame.id]]);
  await store.update("chat-1", (doc) => showPage(doc, "p3"));
  assert.equal((await call("canvas_focus", {})).status, "error", "an empty page has nothing to show");
});

test("canvas_read with snapshot shows Aiden the canvas picture, or says it is not on screen", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-canvas-snapshot-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  let picture: { data: string; mimeType: string } | null = { data: "iVBORw0KGgo=", mimeType: "image/png" };
  const read = createDesignCanvasTools({
    chatId: "chat-1",
    workspaceRoot: base,
    store: new DesignCanvasStore({ root: () => base }),
    broadcast: () => undefined,
    snapshot: async () => picture,
  }).find((tool) => tool.name === "canvas_read")!;

  const plain = await read.execute("c", {} as never);
  assert.deepEqual(plain.content.map((part) => part.type), ["text"], "no picture unless asked");
  const withPicture = await read.execute("c", { snapshot: true } as never);
  assert.deepEqual(withPicture.content.map((part) => part.type), ["text", "image"]);
  assert.deepEqual(withPicture.content[1], { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });

  picture = null;
  const offScreen = await read.execute("c", { snapshot: true } as never);
  assert.deepEqual(offScreen.content.map((part) => part.type), ["text"]);
  const first = offScreen.content[0];
  assert.ok(first && first.type === "text");
  assert.equal(JSON.parse(first.text).snapshot, "unavailable");
});
