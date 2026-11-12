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
  const focused: string[][] = [];
  const tools = createDesignCanvasTools({
    chatId: "chat-1",
    workspaceRoot: workspace,
    store,
    broadcast: (update) => broadcasts.push(update),
    stillAvailable: async () => available,
    newId: () => `frame-${++next}`,
    focus: (ids) => focused.push(ids),
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool, `${name} exists`);
    const output = await tool.execute(`call-${name}`, args as never);
    const first = output.content[0];
    assert.ok(first && first.type === "text");
    return JSON.parse(first.text) as Record<string, any>;
  };
  return { base, workspace, store, broadcasts, focused, call, setAvailable: (value: boolean) => (available = value) };
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
      { id: "auto", kind: "file", title: "home.html", path: "design/home.html", x: 0, y: 0, w: 640, h: 436, designWidth: 1280, pageId: doc.activePageId, createdBy: "aiden", dark: true },
    ],
  }));
  const retitled = await call("canvas_place_frame", { kind: "file", title: "Home", path: "design/home.html" });
  assert.equal(retitled.frame.id, "auto");
  assert.deepEqual(retitled.frame.box, { x: 0, y: 0, w: 640, h: 436 });

  // User or earlier tool resized the adopted frame before Aiden groups it without naming w/h.
  await call("canvas_update_frame", { id: "auto", w: 820, h: 560 });

  const group = await call("canvas_place_frame", { kind: "group", title: "Direction A", x: 0, y: 2000, w: 2000, h: 1200 });
  const grouped = await call("canvas_place_frame", { kind: "file", title: "Home", path: "design/home.html", groupId: group.frame.id });
  assert.equal(grouped.frame.id, "auto");
  assert.equal(grouped.frame.groupId, group.frame.id);
  assert.ok(grouped.frame.box.y >= 2000, "it moved into the group");
  assert.deepEqual({ w: grouped.frame.box.w, h: grouped.frame.box.h }, { w: 820, h: 560 }, "grouping without w/h preserves its size");

  // Once grouped it is the person's layout: another placement at a new width is a second frame.
  const phone = await call("canvas_place_frame", { kind: "file", title: "Home phone", path: "design/home.html", designWidth: 390 });
  assert.notEqual(phone.frame.id, "auto");

  const doc = await store.get("chat-1");
  const pages = doc.frames.filter((frame) => frame.kind === "file");
  assert.equal(pages.length, 2);
  const adopted = pages.find((frame) => frame.id === "auto")!;
  assert.equal(adopted.title, "Home");
  assert.equal(adopted.dark, true, "what the person set on the frame stays");
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
  assert.deepEqual(
    answer.outsideFrames.map((frame: { id: string; box: unknown; groupId?: string }) => [frame.id, frame.box, frame.groupId]),
    [
      ["far-group", { x: 50_000, y: 0, w: 1000, h: 800 }, undefined],
      ["far-note", { x: 50_100, y: 100, w: 240, h: 160 }, "far-group"],
    ],
    "frames outside the view are listed with ids and boxes so they can be moved, grouped or shown",
  );
  assert.equal(answer.outsideOmitted, 0);
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

test("a page's frame is sized for its design width, adopting the auto-placed frame at a new width and duplicating on request", async (t) => {
  const { store, call } = await setup(t);
  await store.update("chat-1", (doc) => ({
    ...doc,
    frames: [
      { id: "auto", kind: "file", title: "home.html", path: "design/home.html", x: 100, y: 50, w: 640, h: 436, designWidth: 1280, pageId: doc.activePageId, createdBy: "aiden" },
    ],
  }));
  const phone = await call("canvas_place_frame", { kind: "file", title: "Home phone", path: "design/home.html", designWidth: 390 });
  assert.equal(phone.frame.id, "auto", "placing the written page at a phone width adopts it instead of adding a copy");
  assert.equal(phone.frame.designWidth, 390);
  assert.deepEqual(phone.frame.box, { x: 100, y: 50, w: 390, h: 844 }, "a phone frame shows a whole phone screen");

  const kept = await call("canvas_place_frame", { kind: "file", title: "Home phone", path: "design/home.html", designWidth: 390 });
  assert.deepEqual(kept.frame.box, phone.frame.box, "the same width keeps the frame's box");

  const dark = await call("canvas_place_frame", { kind: "file", title: "Home dark", path: "design/home.html", designWidth: 390, duplicate: true, dark: true });
  assert.notEqual(dark.frame.id, "auto");
  assert.equal(dark.frame.dark, true);
  assert.deepEqual({ w: dark.frame.box.w, h: dark.frame.box.h }, { w: 390, h: 844 });
  assert.ok(dark.frame.box.x >= phone.frame.box.x + phone.frame.box.w, "the variant sits beside the original");

  const tablet = await call("canvas_place_frame", { kind: "file", title: "Tablet", path: "design/home.html", designWidth: 768, duplicate: true });
  const wide = await call("canvas_place_frame", { kind: "file", title: "Wide", path: "design/home.html", designWidth: 1440, duplicate: true, w: 1000, h: 700 });
  assert.deepEqual({ w: tablet.frame.box.w, h: tablet.frame.box.h }, { w: 576, h: 768 });
  assert.deepEqual({ w: wide.frame.box.w, h: wide.frame.box.h }, { w: 1000, h: 700 }, "an explicit size wins");

  const files = (await store.get("chat-1")).frames.filter((frame) => frame.kind === "file");
  assert.equal(files.length, 4);
});

test("changing a page's design width resizes its frame: the default box follows, a custom size scales", async (t) => {
  const { store, call } = await setup(t);
  await store.update("chat-1", (doc) => ({
    ...doc,
    frames: [
      { id: "plain", kind: "file", title: "Plain", path: "design/home.html", x: 0, y: 0, w: 640, h: 436, designWidth: 1280, pageId: "page-1", createdBy: "person" },
      { id: "custom", kind: "file", title: "Custom", path: "design/home.html", x: 0, y: 1000, w: 960, h: 500, designWidth: 1280, pageId: "page-1", createdBy: "aiden" },
    ],
  }));
  const plain = await call("canvas_update_frame", { id: "plain", designWidth: 390 });
  assert.deepEqual({ w: plain.frame.box.w, h: plain.frame.box.h }, { w: 390, h: 844 });
  const custom = await call("canvas_update_frame", { id: "custom", designWidth: 1440 });
  assert.deepEqual({ w: custom.frame.box.w, h: custom.frame.box.h }, { w: 1080, h: 500 });
  const sized = await call("canvas_update_frame", { id: "custom", designWidth: 768, w: 600, h: 800 });
  assert.deepEqual({ w: sized.frame.box.w, h: sized.frame.box.h }, { w: 600, h: 800 });
});

test("Aiden organises the person's unlocked frames, but a locked frame refuses everything except unlocking", async (t) => {
  const { store, call } = await setup(t);
  await store.update("chat-1", (doc) => ({
    ...doc,
    frames: [
      { id: "theirs", kind: "note", title: "Theirs", text: "keep", x: 0, y: 0, w: 240, h: 160, pageId: "page-1", createdBy: "person" },
      { id: "pinned", kind: "note", title: "Pinned", text: "x", x: 400, y: 0, w: 240, h: 160, pageId: "page-1", createdBy: "aiden", locked: true },
    ],
  }));
  const moved = await call("canvas_update_frame", { id: "theirs", x: 900, y: 40, title: "Moved" });
  assert.equal(moved.status, "updated");
  assert.deepEqual([moved.frame.box.x, moved.frame.box.y, moved.frame.title], [900, 40, "Moved"]);

  for (const [name, args] of [
    ["canvas_update_frame", { id: "pinned", x: 10 }],
    ["canvas_remove_frame", { id: "pinned", force: true }],
    ["canvas_arrange", { frameIds: ["pinned", "theirs"] }],
  ] as const) {
    const refused = await call(name, args);
    assert.equal(refused.status, "error", name);
    assert.match(refused.message, /locked/u);
  }
  const pinned = (await store.get("chat-1")).frames.find((frame) => frame.id === "pinned")!;
  assert.deepEqual([pinned.x, pinned.locked], [400, true]);

  const unlocked = await call("canvas_update_frame", { id: "pinned", locked: false, x: 10 });
  assert.equal(unlocked.frame.locked, undefined);
  assert.equal(unlocked.frame.box.x, 10);
  const relocked = await call("canvas_update_frame", { id: "pinned", locked: true });
  assert.equal(relocked.frame.locked, true);

  assert.equal((await call("canvas_remove_frame", { id: "theirs" })).status, "error", "the person's frame needs force");
  assert.deepEqual(await call("canvas_remove_frame", { id: "theirs", force: true }), { status: "removed", id: "theirs", personFrame: true });
});

test("canvas_update_frame and canvas_place_frame set every look the side panel can", async (t) => {
  const { store, call } = await setup(t);
  const board = await call("canvas_place_frame", { kind: "frame", title: "Board", x: 0, y: 0, fill: "yellow", radius: 24, guide: "columns-12" });
  assert.deepEqual([board.frame.fill, board.frame.radius, board.frame.guide], ["yellow", 24, "columns-12"]);
  const cleared = await call("canvas_update_frame", { id: board.frame.id, fill: "none", guide: "none", radius: 999 });
  assert.deepEqual([cleared.frame.fill, cleared.frame.guide, cleared.frame.radius], [undefined, undefined, 200]);

  const page = await call("canvas_place_frame", { kind: "file", title: "Home", path: "design/home.html", x: 2000, y: 0, tweaks: { "--accent": "#ff0000", "data-density": "compact" } });
  assert.deepEqual(page.frame.tweaks, { "--accent": "#ff0000", "data-density": "compact" });
  const restyled = await call("canvas_update_frame", {
    id: page.frame.id,
    dark: true,
    paper: "a4",
    printMode: "fixed",
    tweaks: { "--accent": null, "--radius": "12px" },
  });
  assert.deepEqual(
    [restyled.frame.dark, restyled.frame.paper, restyled.frame.printMode, restyled.frame.tweaks],
    [true, "a4", "fixed", { "data-density": "compact", "--radius": "12px" }],
    "null resets one tweak; the others merge",
  );
  const light = await call("canvas_update_frame", { id: page.frame.id, dark: false });
  assert.equal(light.frame.dark, undefined);

  const note = await call("canvas_place_frame", { kind: "note", title: "N", x: 0, y: 3000 });
  for (const bad of [
    { id: page.frame.id, tweaks: { color: "red" } },
    { id: page.frame.id, tweaks: { "--accent": "red; background: url(x)" } },
    { id: note.frame.id, dark: true },
    { id: note.frame.id, radius: 4 },
    { id: note.frame.id, guide: "grid-8" },
    { id: note.frame.id, paper: "a4" },
  ]) {
    assert.equal((await call("canvas_update_frame", bad)).status, "error", JSON.stringify(bad));
  }
  const saved = (await store.get("chat-1")).frames.find((frame) => frame.id === page.frame.id)!;
  assert.deepEqual(saved.tweaks, { "data-density": "compact", "--radius": "12px" }, "a refused call changes nothing");
});

test("canvas_update_frame hides, moves to another page and reorders layers", async (t) => {
  const { store, call } = await setup(t);
  const a = await call("canvas_place_frame", { kind: "note", title: "A", x: 0, y: 0 });
  const b = await call("canvas_place_frame", { kind: "note", title: "B", x: 50, y: 50 });
  const c = await call("canvas_place_frame", { kind: "note", title: "C", x: 100, y: 100 });
  const order = async () => (await store.get("chat-1")).frames.filter((frame) => frame.pageId === "page-1").map((frame) => frame.title);
  await call("canvas_update_frame", { id: a.frame.id, layer: "front" });
  assert.deepEqual(await order(), ["B", "C", "A"], "drawn last is in front");
  await call("canvas_update_frame", { id: a.frame.id, layer: "back" });
  assert.deepEqual(await order(), ["A", "B", "C"]);
  await call("canvas_update_frame", { id: c.frame.id, belowFrameId: b.frame.id });
  assert.deepEqual(await order(), ["A", "C", "B"]);
  await call("canvas_update_frame", { id: a.frame.id, layer: "forward" });
  assert.deepEqual(await order(), ["C", "A", "B"]);
  assert.equal((await call("canvas_update_frame", { id: a.frame.id, layer: "front", aboveFrameId: b.frame.id })).status, "error");

  const hidden = await call("canvas_update_frame", { id: b.frame.id, hidden: true });
  assert.equal(hidden.frame.hidden, true);
  assert.equal((await call("canvas_update_frame", { id: b.frame.id, hidden: false })).frame.hidden, undefined);

  await call("canvas_page", { action: "add", name: "Archive", show: false });
  const moved = await call("canvas_update_frame", { id: c.frame.id, page: "archive" });
  const doc = await store.get("chat-1");
  assert.equal(doc.pages.find((page) => page.id === doc.frames.find((frame) => frame.id === c.frame.id)!.pageId)!.name, "Archive");
  assert.equal(moved.status, "updated");
  assert.equal(doc.activePageId, "page-1", "moving a frame does not change the page on screen");
});

test("a frame placed into a group past its edge grows the group to hold it", async (t) => {
  const { call } = await setup(t);
  const group = await call("canvas_place_frame", { kind: "group", title: "Direction A", x: 0, y: 0, w: 400, h: 300 });
  const first = await call("canvas_place_frame", { kind: "note", title: "One", groupId: group.frame.id });
  const second = await call("canvas_place_frame", { kind: "note", title: "Two", groupId: group.frame.id });
  const answer = await call("canvas_read");
  const grown = answer.inView.find((frame: { id: string }) => frame.id === group.frame.id);
  assert.ok(second.frame.box.x > first.frame.box.x);
  assert.equal(grown.box.x + grown.box.w, second.frame.box.x + second.frame.box.w + 32);
  assert.ok(grown.box.y + grown.box.h >= second.frame.box.y + second.frame.box.h + 32);
});

test("canvas_arrange lays frames out in a group that fits itself around them, and shows them", async (t) => {
  const { store, focused, call } = await setup(t);
  const group = await call("canvas_place_frame", { kind: "group", title: "Direction A", x: 1000, y: 1000 });
  const notes = [];
  for (const [index, title] of ["One", "Two", "Three"].entries()) {
    notes.push(await call("canvas_place_frame", { kind: "note", title, x: index * 37, y: index * 91, h: 160 + index * 40 }));
  }
  const ids = notes.map((note) => note.frame.id as string);
  const arranged = await call("canvas_arrange", { frameIds: ids, groupId: group.frame.id, layout: "row", align: "center" });
  assert.equal(arranged.status, "arranged");
  const doc = await store.get("chat-1");
  const frames = ids.map((id) => doc.frames.find((frame) => frame.id === id)!);
  assert.ok(frames.every((frame) => frame.groupId === group.frame.id));
  // A row: each starts 64 past the one before, centred on the tallest.
  for (let index = 1; index < frames.length; index += 1) {
    assert.equal(frames[index]!.x, frames[index - 1]!.x + frames[index - 1]!.w + 64);
  }
  const centres = frames.map((frame) => frame.y + frame.h / 2);
  assert.ok(centres.every((centre) => centre === centres[0]), "centred in the row");
  const fitted = doc.frames.find((frame) => frame.id === group.frame.id)!;
  const right = Math.max(...frames.map((frame) => frame.x + frame.w));
  const bottom = Math.max(...frames.map((frame) => frame.y + frame.h));
  assert.deepEqual(
    { left: frames[0]!.x - fitted.x, top: Math.min(...frames.map((frame) => frame.y)) - fitted.y, right: fitted.x + fitted.w - right, bottom: fitted.y + fitted.h - bottom },
    { left: 32, top: 48, right: 32, bottom: 32 },
  );
  assert.deepEqual(focused[focused.length - 1]?.slice().sort(), [...ids, group.frame.id].sort());

  // A grid of the group's members, then taken out of the group.
  await call("canvas_arrange", { groupId: group.frame.id, layout: "grid", columns: 2, focus: false });
  const grid = (await store.get("chat-1")).frames.filter((frame) => ids.includes(frame.id));
  assert.equal(grid[0]!.y, grid[1]!.y);
  assert.equal(grid[2]!.x, grid[0]!.x);
  assert.equal(grid[2]!.y, grid[0]!.y + Math.max(grid[0]!.h, grid[1]!.h) + 80);
  const out = await call("canvas_arrange", { frameIds: [ids[2]], groupId: null, x: 5000, y: 0, focus: false });
  assert.equal(out.frames[0].groupId, undefined);
  assert.deepEqual([out.frames[0].box.x, out.frames[0].box.y], [5000, 0]);
});

test("canvas_page adds, renames, duplicates, reorders, shows and deletes pages, never the last one", async (t) => {
  const { store, call } = await setup(t);
  await call("canvas_place_frame", { kind: "note", title: "Mine", x: 0, y: 0 });
  const added = await call("canvas_page", { action: "add", name: "Mobile" });
  assert.equal(added.page.name, "Mobile");
  assert.equal((await store.get("chat-1")).activePageId, added.page.id, "a new page comes on screen");
  assert.equal((await call("canvas_page", { action: "rename", page: "Mobile", name: "Phone" })).page.name, "Phone");
  const copy = await call("canvas_page", { action: "duplicate", page: "Page 1", name: "Page 1 v2" });
  assert.equal(copy.page.name, "Page 1 v2");
  assert.equal((await store.get("chat-1")).frames.filter((frame) => frame.pageId === copy.page.id).length, 1);
  const moved = await call("canvas_page", { action: "move", page: "Phone", step: 1 });
  assert.deepEqual(moved.pages.map((page: { name: string }) => page.name), ["Page 1", "Page 1 v2", "Phone"]);
  await call("canvas_page", { action: "show", page: "Page 1" });
  assert.equal((await store.get("chat-1")).activePageId, "page-1");
  assert.equal((await call("canvas_page", { action: "delete", page: "Phone" })).status, "deleted");
  assert.equal((await call("canvas_page", { action: "delete", page: "Page 1 v2" })).status, "deleted", "Aiden's own frames go with its page");
  const last = await call("canvas_page", { action: "delete", page: "Page 1" });
  assert.equal(last.status, "error");
  assert.match(last.message, /at least one page/u);
  assert.equal((await call("canvas_page", { action: "rename", page: "Nope", name: "X" })).status, "error");
});

test("deleting a page that holds the person's frames needs force", async (t) => {
  const { store, call } = await setup(t);
  const added = await call("canvas_page", { action: "add", name: "Theirs" });
  await store.update("chat-1", (doc) => ({
    ...doc,
    frames: [{ id: "theirs", kind: "note", title: "T", text: "", x: 0, y: 0, w: 240, h: 160, pageId: added.page.id, createdBy: "person" }],
  }));
  assert.equal((await call("canvas_page", { action: "delete", page: "Theirs" })).status, "error");
  assert.equal((await call("canvas_page", { action: "delete", page: "Theirs", force: true })).status, "deleted");
  assert.equal((await store.get("chat-1")).frames.length, 0);
});

test("canvas_focus with a page brings that page on screen", async (t) => {
  const { store, focused, call } = await setup(t);
  const added = await call("canvas_page", { action: "add", name: "Flows" });
  const note = await call("canvas_place_frame", { kind: "note", title: "On flows", x: 0, y: 0 });
  await call("canvas_page", { action: "show", page: "Page 1" });
  assert.deepEqual(await call("canvas_focus", { page: "Flows" }), { status: "requested", frames: 1 });
  assert.equal((await store.get("chat-1")).activePageId, added.page.id);
  assert.deepEqual(focused[focused.length - 1], []);
  assert.equal((await call("canvas_focus", { ids: [note.frame.id], page: "Page 1" })).status, "error");
  assert.deepEqual(await call("canvas_focus", { page: "Page 1" }), { status: "shown", page: "page-1", frames: 0 });
});

test("adversarial edge cases: partial size with designWidth, cross-page regrouping, locked group members and cross-page fitGroupIds", async (t) => {
  const { store, focused, call } = await setup(t);

  // 1. Changing designWidth while overriding only h updates w to the new designWidth's default width.
  const screen = await call("canvas_place_frame", { kind: "file", title: "Home", path: "design/home.html" });
  assert.deepEqual([screen.frame.box.w, screen.frame.box.h, screen.frame.designWidth], [640, 436, 1280]);
  const tallPhone = await call("canvas_update_frame", { id: screen.frame.id, designWidth: 390, h: 960 });
  assert.deepEqual([tallPhone.frame.box.w, tallPhone.frame.box.h, tallPhone.frame.designWidth], [390, 960, 390]);

  // 2. Moving a frame to another page and into a group on that page in one call works and grows that group.
  const archive = await call("canvas_page", { action: "add", name: "Archive", show: false });
  const archiveGroup = await call("canvas_place_frame", {
    kind: "group",
    title: "Saved",
    page: "Archive",
    x: 100,
    y: 100,
    w: 300,
    h: 200,
  });
  const movedIntoGroup = await call("canvas_update_frame", {
    id: screen.frame.id,
    page: "Archive",
    groupId: archiveGroup.frame.id,
    x: 140,
    y: 160,
  });
  assert.equal(movedIntoGroup.status, "updated");
  assert.equal(movedIntoGroup.frame.groupId, archiveGroup.frame.id);
  const afterMove = await store.get("chat-1");
  assert.equal(afterMove.frames.find((frame) => frame.id === screen.frame.id)!.pageId, archive.page.id);
  const grownArchiveGroup = afterMove.frames.find((frame) => frame.id === archiveGroup.frame.id)!;
  assert.ok(grownArchiveGroup.h >= 160 + 960 - 100 + 32, "target page group grows around moved frame");

  // 3. canvas_arrange with fitGroupIds on another page switches to and fits that page's group, and empty string ungroups.
  const fittedOtherPage = await call("canvas_arrange", { fitGroupIds: [archiveGroup.frame.id] });
  assert.equal(fittedOtherPage.status, "arranged");
  assert.equal(fittedOtherPage.page, archive.page.id);
  assert.equal((await store.get("chat-1")).activePageId, archive.page.id);
  assert.deepEqual(focused[focused.length - 1], [archiveGroup.frame.id]);

  const ungrouped = await call("canvas_arrange", { frameIds: [screen.frame.id], groupId: "", focus: false });
  assert.equal(ungrouped.status, "arranged");
  assert.equal(ungrouped.frames[0].groupId, undefined);

  // 4. A group holding a locked member cannot be dragged/arranged/moved across pages until unlocked or ungrouped.
  await call("canvas_page", { action: "show", page: "Page 1" });
  const lockedGroup = await call("canvas_place_frame", { kind: "group", title: "Pinned set", x: 0, y: 0 });
  const pinnedNote = await call("canvas_place_frame", { kind: "note", title: "Pinned", groupId: lockedGroup.frame.id });
  await call("canvas_update_frame", { id: pinnedNote.frame.id, locked: true });
  assert.equal((await call("canvas_update_frame", { id: lockedGroup.frame.id, x: 400 })).status, "error");
  assert.equal((await call("canvas_update_frame", { id: lockedGroup.frame.id, page: "Archive" })).status, "error");
  assert.equal((await call("canvas_arrange", { frameIds: [lockedGroup.frame.id] })).status, "error");
  assert.equal((await call("canvas_arrange", { frameIds: [lockedGroup.frame.id], fitGroupIds: [archiveGroup.frame.id] })).status, "error");

  // Auto-arranging Page 1 skips the group holding a locked member instead of failing when another unlocked frame exists.
  const freeNote = await call("canvas_place_frame", { kind: "note", title: "Free", x: 900, y: 200 });
  const pageArranged = await call("canvas_arrange", { page: "Page 1", focus: false });
  assert.equal(pageArranged.status, "arranged");
  assert.deepEqual(pageArranged.skippedLocked, [lockedGroup.frame.id]);
  assert.deepEqual(
    pageArranged.frames.map((frame: { id: string }) => frame.id),
    [freeNote.frame.id],
  );

  // Passing both a group and its unlocked member without ungrouping is refused cleanly.
  await call("canvas_update_frame", { id: pinnedNote.frame.id, locked: false });
  assert.equal((await call("canvas_arrange", { frameIds: [lockedGroup.frame.id, pinnedNote.frame.id] })).status, "error");
});

test("a locked group or artboard keeps its box: nothing can be placed, moved or arranged into it, and frames leaving it do not refit it", async (t) => {
  const { store, call } = await setup(t);
  const group = await call("canvas_place_frame", { kind: "group", title: "Pinned set", x: 0, y: 0, w: 400, h: 300 });
  const artboard = await call("canvas_place_frame", { kind: "frame", title: "Phone", x: 2000, y: 0, w: 390, h: 844 });
  const member = await call("canvas_place_frame", { kind: "note", title: "Inside", groupId: group.frame.id });
  const loose = await call("canvas_place_frame", { kind: "note", title: "Loose", x: 900, y: 900 });
  await call("canvas_update_frame", { id: group.frame.id, locked: true });
  await call("canvas_update_frame", { id: artboard.frame.id, locked: true });
  const boxes = async () => {
    const doc = await store.get("chat-1");
    return [group.frame.id, artboard.frame.id].map((id) => {
      const frame = doc.frames.find((entry) => entry.id === id)!;
      return [frame.x, frame.y, frame.w, frame.h];
    });
  };
  const before = await boxes();

  for (const target of [group.frame.id, artboard.frame.id]) {
    const placed = await call("canvas_place_frame", { kind: "note", title: "New", groupId: target, x: 5000, y: 5000 });
    assert.equal(placed.status, "error");
    assert.match(placed.message, /locked/u);
    assert.equal((await call("canvas_update_frame", { id: loose.frame.id, groupId: target, x: 5000, y: 5000 })).status, "error");
    assert.equal((await call("canvas_arrange", { frameIds: [loose.frame.id], groupId: target })).status, "error");
  }
  assert.deepEqual(await boxes(), before);
  const after = await store.get("chat-1");
  assert.ok(after.frames.every((frame) => frame.title !== "New"));
  assert.equal(after.frames.find((frame) => frame.id === loose.frame.id)!.groupId, undefined);

  // A member already inside can still move, naming its own group, without growing it.
  const moved = await call("canvas_update_frame", { id: member.frame.id, groupId: group.frame.id, x: 3000, y: 3000 });
  assert.equal(moved.status, "updated");
  assert.equal(moved.frame.groupId, group.frame.id);
  assert.deepEqual(await boxes(), before);

  // Arranging it out of the group leaves the locked group's box as it was.
  const out = await call("canvas_arrange", { frameIds: [member.frame.id], groupId: null, x: 6000, y: 0, focus: false });
  assert.equal(out.status, "arranged");
  assert.equal(out.frames[0].groupId, undefined);
  assert.deepEqual(await boxes(), before);
});
