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

test("placing a page that already landed on the canvas by itself moves that frame instead of adding a copy", async (t) => {
  const { store, call } = await setup(t);
  // The page landed by itself after Aiden wrote it (written-pages.ts).
  await store.update("chat-1", (doc) => ({
    ...doc,
    frames: [
      { id: "auto", kind: "file", title: "home.html", path: "design/home.html", x: 0, y: 0, w: 640, h: 436, designWidth: 1280, pageId: doc.activePageId, createdBy: "aiden", locked: true },
    ],
  }));
  const retitled = await call("canvas_place_frame", { kind: "file", title: "Home", path: "design/home.html" });
  assert.equal(retitled.frame.id, "auto");
  assert.deepEqual(retitled.frame.box, { x: 0, y: 0, w: 640, h: 436 });

  const group = await call("canvas_place_frame", { kind: "group", title: "Direction A", x: 0, y: 2000, w: 2000, h: 1200 });
  const grouped = await call("canvas_place_frame", { kind: "file", title: "Home", path: "design/home.html", groupId: group.frame.id });
  assert.equal(grouped.frame.id, "auto");
  assert.equal(grouped.frame.groupId, group.frame.id);
  assert.ok(grouped.frame.box.y >= 2000, "it moved into the group");

  // Once grouped it is the person's layout: another placement at a new width is a second frame.
  const phone = await call("canvas_place_frame", { kind: "file", title: "Home phone", path: "design/home.html", designWidth: 390 });
  assert.notEqual(phone.frame.id, "auto");

  const doc = await store.get("chat-1");
  const pages = doc.frames.filter((frame) => frame.kind === "file");
  assert.equal(pages.length, 2);
  const adopted = pages.find((frame) => frame.id === "auto")!;
  assert.equal(adopted.title, "Home");
  assert.equal(adopted.locked, true, "what the person set on the frame stays");
});

test("resizing a page that landed by itself keeps an arrow on it attached to its side", async (t) => {
  const { store, call } = await setup(t);
  await store.update("chat-1", (doc) => ({
    ...doc,
    frames: [
      { id: "auto", kind: "file", title: "home.html", path: "design/home.html", x: 0, y: 0, w: 640, h: 436, designWidth: 1280, pageId: doc.activePageId, createdBy: "aiden" },
    ],
  }));
  const note = await call("canvas_place_frame", { kind: "note", title: "Next", text: "Library", x: 1200, y: 100 });
  const arrow = await call("canvas_place_frame", { kind: "connector", title: "Flow", from: { frameId: "auto" }, to: { frameId: note.frame.id } });
  assert.equal(arrow.status, "placed");
  await call("canvas_place_frame", { kind: "file", title: "Home", path: "design/home.html", w: 900, h: 600 });
  const doc = await store.get("chat-1");
  const page = doc.frames.find((frame) => frame.id === "auto")!;
  const connector = doc.frames.find((frame) => frame.kind === "connector")!;
  assert.deepEqual({ w: page.w, h: page.h }, { w: 900, h: 600 });
  // The arrow leaves the page's right side, which moved with the new width.
  assert.equal(connector.ends![0].frameId, "auto");
  assert.equal(connector.ends![0].x, page.x + page.w);
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
  const commentOn = (id: string, frameId: string) => ({
    id, frameId, x: 10, y: 10, note: id, state: "open" as const, anchorState: "anchored" as const, pageId: "page-1", createdAt: "2026-11-05T00:00:00Z",
  });
  await store.update("chat-1", (doc) => ({
    ...doc,
    frames: [
      { id: "group-p", kind: "group", title: "Mine", x: 0, y: 0, w: 1000, h: 800, pageId: "page-1", createdBy: "person" },
      { id: "note-p", kind: "note", title: "Mine", text: "keep", x: 40, y: 60, w: 240, h: 160, groupId: "group-p", pageId: "page-1", createdBy: "person" },
    ],
    comments: [commentOn("on-group", "group-p"), commentOn("on-note", "note-p")],
  }));
  const refused = await call("canvas_remove_frame", { id: "note-p" });
  assert.equal(refused.status, "error");
  assert.equal((await store.get("chat-1")).frames.length, 2);

  const removed = await call("canvas_remove_frame", { id: "group-p", confirm: true });
  assert.deepEqual(removed, { status: "removed", id: "group-p", personFrame: true });
  const doc = await store.get("chat-1");
  assert.deepEqual(doc.frames.map((frame) => [frame.id, frame.groupId]), [["note-p", undefined]]);
  assert.deepEqual(
    doc.comments.map((comment) => [comment.id, comment.frameId]),
    [["on-note", "note-p"]],
    "the removed frame's comments go with it; the kept frame's stay",
  );

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

test("Aiden draws a small flow: labelled shapes, text and an arrow that follows its boxes", async (t) => {
  const { store, call } = await setup(t);
  const start = await call("canvas_place_frame", { kind: "shape", title: "Start", text: "Sign in", x: 0, y: 0 });
  const done = await call("canvas_place_frame", {
    kind: "shape",
    shape: "oval",
    title: "Done",
    text: "Home",
    fill: "green",
    x: 400,
    y: 0,
  });
  const caption = await call("canvas_place_frame", { kind: "text", title: "Caption", text: "Happy path\nNo errors", size: "small" });
  const arrow = await call("canvas_place_frame", {
    kind: "connector",
    title: "Then",
    from: { frameId: start.frame.id },
    to: { frameId: done.frame.id },
  });
  assert.deepEqual(
    [start.frame.shape, start.frame.text, start.frame.fill, start.frame.box.w, start.frame.box.h],
    ["rect", "Sign in", "blue", 160, 100],
  );
  assert.deepEqual([done.frame.shape, done.frame.fill], ["oval", "green"]);
  assert.equal(caption.frame.box.h, 38, "two small lines");
  assert.equal(arrow.frame.arrow, "end");
  assert.deepEqual(arrow.frame.from, { x: 160, y: 50, frameId: start.frame.id });
  assert.deepEqual(arrow.frame.to, { x: 400, y: 50, frameId: done.frame.id });

  // Moving a box brings the arrow with it.
  await call("canvas_update_frame", { id: done.frame.id, x: 0, y: 400 });
  const doc = await store.get("chat-1");
  const after = doc.frames.find((frame) => frame.id === arrow.frame.id)!;
  assert.deepEqual(
    after.ends!.map((end) => [end.x, end.y]),
    [
      [80, 100],
      [80, 400],
    ],
  );

  // Removing a box leaves the arrow's end where it was.
  await call("canvas_remove_frame", { id: done.frame.id });
  const left = (await store.get("chat-1")).frames.find((frame) => frame.id === arrow.frame.id)!;
  assert.deepEqual(left.ends![1], { x: 80, y: 400 });

  const read = await call("canvas_read");
  const summary = read.inView.find((frame: { id: string }) => frame.id === arrow.frame.id);
  assert.deepEqual(summary.from, { x: 80, y: 100, frameId: start.frame.id });
  assert.deepEqual(summary.to, { x: 80, y: 400 });
});

test("drawn items refuse what they cannot be", async (t) => {
  const { call } = await setup(t);
  const box = await call("canvas_place_frame", { kind: "shape", title: "Box" });
  const loop = await call("canvas_place_frame", {
    kind: "connector",
    title: "Loop",
    from: { frameId: box.frame.id },
    to: { frameId: box.frame.id },
  });
  assert.equal(loop.status, "error");
  const nowhere = await call("canvas_place_frame", { kind: "connector", title: "Nowhere", from: { x: 0 }, to: { x: 1, y: 1 } });
  assert.equal(nowhere.status, "error");
  const empty = await call("canvas_place_frame", { kind: "text", title: "Empty", text: "  " });
  assert.equal(empty.status, "error");
  const pink = await call("canvas_place_frame", { kind: "shape", title: "Odd", fill: "#ff00ff" });
  assert.equal(pink.status, "error");
  const sized = await call("canvas_update_frame", { id: box.frame.id, size: "large" });
  assert.equal(sized.status, "error");
  const recolored = await call("canvas_update_frame", { id: box.frame.id, fill: "red", text: "Checkout" });
  assert.deepEqual([recolored.status, recolored.frame.fill, recolored.frame.text], ["updated", "red", "Checkout"]);
});

test("a shape placed in an artboard sits in it, and moving the artboard moves it", async (t) => {
  const { store, call } = await setup(t);
  const board = await call("canvas_place_frame", { kind: "frame", title: "Mobile", x: 0, y: 0, w: 390, h: 844 });
  const card = await call("canvas_place_frame", { kind: "shape", title: "Card", groupId: board.frame.id });
  assert.equal(card.frame.groupId, board.frame.id);
  await call("canvas_update_frame", { id: board.frame.id, x: 1000 });
  const moved = (await store.get("chat-1")).frames.find((frame) => frame.id === card.frame.id)!;
  assert.equal(moved.x, card.frame.box.x + 1000);
});

test("Aiden writes a formatted note in a colour, and canvas_read gives the formatting back", async (t) => {
  const { store, call } = await setup(t);
  const words = "**Launch plan**\n- Draft the *pricing* page\n- Check [the brief](https://example.com/brief)\n1. <u>Ship</u>";
  const note = await call("canvas_place_frame", { kind: "note", title: "Plan", text: words, fill: "yellow", size: "medium", color: "blue" });
  assert.equal(note.status, "placed");
  const saved = (await store.get("chat-1")).frames.find((frame) => frame.id === note.frame.id)!;
  assert.deepEqual([saved.text, saved.fill, saved.size, saved.color], [words, "yellow", "medium", "blue"]);
  const read = await call("canvas_read");
  assert.ok(JSON.stringify(read).includes(JSON.stringify(words).slice(1, -1)), "canvas_read carries the Markdown as written");
  const recolored = await call("canvas_update_frame", { id: note.frame.id, fill: "green", size: "large" });
  assert.deepEqual([recolored.status, recolored.frame.fill], ["updated", "green"]);
  const text = await call("canvas_place_frame", { kind: "text", title: "Heading", text: "**Hi**" });
  const filled = await call("canvas_update_frame", { id: text.frame.id, fill: "red" });
  assert.equal(filled.status, "error", "a text item has no fill");
});
