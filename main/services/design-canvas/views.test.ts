// Main's record of each chat's canvas view: what Aiden's tools read as the
// page on screen, kept after the canvas unmounts and across restarts.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DESIGN_CANVAS_LIMITS, emptyDesignCanvas, type DesignCanvas } from "../../../renderer/shared/design-canvas/schema.js";
import type { DesignChatView } from "../../../renderer/shared/design-canvas/view.js";
import { DesignCanvasViews, designTurnPages } from "./views.js";

const view = (pageId: string, x = 0): DesignChatView => ({ pageId, viewport: { x, y: 0, zoom: 1 } });

async function tempRoot(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-design-views-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function docWith(...pageIds: string[]): DesignCanvas {
  return { ...emptyDesignCanvas(), pages: pageIds.map((id) => ({ id, name: id })) };
}

test("mounted counts only mounted canvases on that workspace", async () => {
  const views = new DesignCanvasViews();
  await views.report("chat-a", "ws-1", view("page-1"), 0);
  await views.report("chat-b", "ws-1", view("page-1"), 0);
  await views.report("chat-c", "ws-2", view("page-1"), 0);
  assert.equal(views.mounted("ws-1"), 2);
  assert.equal(views.mounted("ws-2"), 1);
  views.unmount("chat-b");
  assert.equal(views.mounted("ws-1"), 1);
  assert.equal(views.mounted("ws-3"), 0);
  // Aiden showing a page for a chat with no canvas open does not count as one.
  await views.showPage("chat-d", "ws-3", "page-2");
  assert.equal(views.mounted("ws-3"), 0);
});

test("unmount keeps the last page and viewport, and forget drops the chat", async () => {
  const views = new DesignCanvasViews();
  await views.report("chat-a", "ws-1", view("p2", 40), 0);
  views.unmount("chat-a");
  assert.deepEqual(await views.get("chat-a", "ws-1"), view("p2", 40));
  await views.forget("chat-a", "ws-1");
  assert.equal(await views.get("chat-a", "ws-1"), undefined);
  assert.equal(await views.kept("chat-a", "ws-1"), undefined);
  // An unmount for a chat main never heard of is nothing.
  views.unmount("never");
  assert.equal(await views.get("never", "ws-1"), undefined);
});

test("switching chats A to B to A in one window restores A's kept page", async () => {
  const views = new DesignCanvasViews();
  await views.report("chat-a", "ws-1", view("pricing", 120), 0);
  views.unmount("chat-a");
  await views.report("chat-b", "ws-1", view("page-1"), 0);
  views.unmount("chat-b");
  assert.deepEqual(await views.kept("chat-a", "ws-1"), { pageId: "pricing", viewport: { x: 120, y: 0, zoom: 1 }, focusId: 0 });
});

test("Aiden showing a page counts at once and takes that page's own viewport", async () => {
  const views = new DesignCanvasViews();
  assert.equal(await views.showPage("chat-a", "ws-1", "p2"), 1);
  assert.deepEqual(await views.get("chat-a", "ws-1"), { pageId: "p2", viewport: { x: 0, y: 0, zoom: 1 } });
  await views.report("chat-a", "ws-1", { ...view("p2", 30), size: { w: 900, h: 600 } }, 1);
  await views.report("chat-a", "ws-1", { ...view("p3", 70), size: { w: 900, h: 600 } }, 1);
  // Back to P2: the canvas looks where the person last looked at P2, at its size.
  assert.equal(await views.showPage("chat-a", "ws-1", "p2"), 2);
  assert.deepEqual(await views.get("chat-a", "ws-1"), { ...view("p2", 30), size: { w: 900, h: 600 } });
  // A page never looked at opens at the fresh viewport.
  await views.showPage("chat-a", "ws-1", "p9");
  assert.deepEqual((await views.get("chat-a", "ws-1"))?.viewport, { x: 0, y: 0, zoom: 1 });
});

test("a report echoing an older focusId is ignored, and one that applied the latest is taken", async () => {
  const views = new DesignCanvasViews();
  await views.report("chat-a", "ws-1", view("page-1"), 0);
  const focusId = await views.showPage("chat-a", "ws-1", "p2");
  // The renderer had not applied Aiden's page yet when it reported this pan.
  await views.report("chat-a", "ws-1", view("page-1", 500), focusId - 1);
  assert.equal((await views.get("chat-a", "ws-1"))?.pageId, "p2");
  assert.equal(views.mounted("ws-1"), 1, "an ignored report still says the canvas is open");
  // Once the renderer applied it, its reports are the view again.
  await views.report("chat-a", "ws-1", view("p2", 80), focusId);
  assert.deepEqual(await views.get("chat-a", "ws-1"), view("p2", 80));
  assert.deepEqual(await views.kept("chat-a", "ws-1"), { pageId: "p2", viewport: { x: 80, y: 0, zoom: 1 }, focusId });
});

test("when the window goes, every view is unmounted and every page kept", async () => {
  const views = new DesignCanvasViews();
  await views.report("chat-a", "ws-1", view("p2"), 0);
  await views.report("chat-b", "ws-2", view("p3"), 0);
  views.unmountAll();
  assert.equal(views.mounted("ws-1"), 0);
  assert.equal(views.mounted("ws-2"), 0);
  assert.equal((await views.get("chat-a", "ws-1"))?.pageId, "p2");
  assert.equal((await views.get("chat-b", "ws-2"))?.pageId, "p3");
});

test("views survive a restart: a new instance on the same root reads the page, viewports and focusId", async (t) => {
  const root = await tempRoot(t);
  const before = new DesignCanvasViews({ root: () => root });
  await before.report("chat-a", "ws-1", { ...view("p1", 15), size: { w: 640, h: 480 } }, 0);
  await before.report("chat-a", "ws-1", view("p2", 25), 0);
  await before.showPage("chat-a", "ws-1", "p1");
  await before.flush();
  const stored = JSON.parse(await readFile(path.join(root, "ws-1.json"), "utf8")) as Record<string, unknown>;
  assert.equal("mounted" in (stored["chat-a"] as object), false, "whether a canvas is open is not stored");
  assert.equal((await stat(path.join(root, "ws-1.json"))).mode & 0o777, 0o600);

  const after = new DesignCanvasViews({ root: () => root });
  assert.equal(after.mounted("ws-1"), 0);
  assert.deepEqual(await after.kept("chat-a", "ws-1"), { pageId: "p1", viewport: { x: 15, y: 0, zoom: 1 }, focusId: 1 });
  await after.showPage("chat-a", "ws-1", "p2");
  assert.deepEqual((await after.get("chat-a", "ws-1"))?.viewport, { x: 25, y: 0, zoom: 1 });
});

test("changes are written once after a quiet second, not on every report", async (t) => {
  const root = await tempRoot(t);
  const writes: unknown[] = [];
  const views = new DesignCanvasViews({
    root: () => root,
    writeJson: async (_file, value) => {
      writes.push(value);
    },
  });
  for (let x = 0; x < 20; x += 1) await views.report("chat-a", "ws-1", view("p1", x), 0);
  assert.equal(writes.length, 0, "nothing is written straight away");
  await views.flush();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], { "chat-a": { pageId: "p1", viewports: { p1: { x: 19, y: 0, zoom: 1 } }, focusId: 0 } });
  await views.flush();
  assert.equal(writes.length, 1, "nothing changed, so nothing more is written");
});

test("a missing or corrupt views file reads as empty, and junk entries are dropped", async (t) => {
  const root = await tempRoot(t);
  await writeFile(path.join(root, "ws-1.json"), "{not json");
  await writeFile(
    path.join(root, "ws-2.json"),
    JSON.stringify({
      "chat-a": { pageId: "p1", viewports: { p1: { x: 5, y: 6, zoom: 99 } }, focusId: 3 },
      "chat-b": { pageId: "", viewports: {}, focusId: 0 },
      "chat-c": { pageId: "p1", viewports: { p1: { x: "far" } }, focusId: -1 },
      "../x": { pageId: "p1", viewports: {}, focusId: 0 },
    }),
  );
  const views = new DesignCanvasViews({ root: () => root });
  assert.equal(await views.get("chat-a", "ws-1"), undefined);
  assert.equal(await views.get("chat-a", "ws-0"), undefined, "no file at all");
  assert.deepEqual(await views.kept("chat-a", "ws-2"), {
    pageId: "p1",
    viewport: { x: 5, y: 6, zoom: DESIGN_CANVAS_LIMITS.maxZoom },
    focusId: 3,
  });
  assert.equal(await views.get("chat-b", "ws-2"), undefined);
  assert.deepEqual(await views.kept("chat-c", "ws-2"), { pageId: "p1", viewport: { x: 0, y: 0, zoom: 1 }, focusId: 0 });
});

test("a chat keeps at most one viewport per page limit, dropping the longest unvisited", async () => {
  const writes: Array<Record<string, { viewports: Record<string, unknown> }>> = [];
  const views = new DesignCanvasViews({
    root: () => "/unused",
    writeJson: async (_file, value) => {
      writes.push(value as (typeof writes)[number]);
    },
  });
  for (let page = 0; page <= DESIGN_CANVAS_LIMITS.pages; page += 1) {
    await views.report("chat-a", "ws-1", view(`p${page}`), 0);
  }
  await views.flush();
  const viewports = Object.keys(writes[0]!["chat-a"]!.viewports);
  assert.equal(viewports.length, DESIGN_CANVAS_LIMITS.pages);
  assert.equal(viewports.includes("p0"), false, "the first page visited went first");
  assert.equal(viewports.includes(`p${DESIGN_CANVAS_LIMITS.pages}`), true);
});

test("removing a workspace deletes its views file, and nothing writes it back", async (t) => {
  const root = await tempRoot(t);
  const views = new DesignCanvasViews({ root: () => root });
  await views.report("chat-a", "ws-1", view("p1"), 0);
  await views.flush();
  await views.report("chat-a", "ws-1", view("p1", 9), 0);
  await views.removeWorkspace("ws-1");
  await views.flush();
  await assert.rejects(stat(path.join(root, "ws-1.json")), { code: "ENOENT" });
  assert.equal(views.mounted("ws-1"), 0);
  await views.report("chat-a", "ws-1", view("p1"), 0);
  await views.flush();
  await assert.rejects(stat(path.join(root, "ws-1.json")), { code: "ENOENT" });
});

test("forget drops the chat from its workspace's file", async (t) => {
  const root = await tempRoot(t);
  await mkdir(root, { recursive: true });
  const views = new DesignCanvasViews({ root: () => root });
  await views.report("chat-a", "ws-1", view("p1"), 0);
  await views.report("chat-b", "ws-1", view("p2"), 0);
  await views.forget("chat-a", "ws-1");
  await views.flush();
  const stored = JSON.parse(await readFile(path.join(root, "ws-1.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(stored), ["chat-b"]);
});

test("workspace ids that are not workspace ids are refused", async () => {
  const views = new DesignCanvasViews({ root: () => "/unused" });
  await assert.rejects(views.get("chat-a", "../ws"), /Invalid workspace id/u);
  await assert.rejects(views.report("chat-a", "ws/1", view("p1"), 0), /Invalid workspace id/u);
});

test("a turn's page: what Aiden showed this turn, then the message's page, then the kept page, then the first", async () => {
  const views = new DesignCanvasViews();
  const doc = docWith("p1", "p2", "p3");
  // Nothing known: the first page, at the message's size.
  const fresh = designTurnPages({ views, chatId: "chat-a", message: { selection: [], viewSize: { w: 500, h: 400 } } });
  assert.deepEqual(await fresh.view(doc, "ws-1"), { pageId: "p1", viewport: { x: 0, y: 0, zoom: 1 }, size: { w: 500, h: 400 } });

  await views.report("chat-a", "ws-1", { ...view("p2", 30), size: { w: 900, h: 600 } }, 0);
  await views.report("chat-a", "ws-1", view("p3", 60), 0);
  // The kept page.
  assert.equal((await designTurnPages({ views, chatId: "chat-a" }).view(doc, "ws-1")).pageId, "p3");
  // The message's page beats the kept one, and is looked at from its own viewport.
  const turn = designTurnPages({ views, chatId: "chat-a", message: { selection: [], pageId: "p2" } });
  assert.deepEqual(await turn.view(doc, "ws-1"), { pageId: "p2", viewport: { x: 30, y: 0, zoom: 1 } });
  // A page Aiden showed this turn beats the message's.
  const focusId = await turn.show("ws-1", "p1");
  assert.equal(focusId, 1);
  assert.equal((await turn.view(doc, "ws-1")).pageId, "p1");
  // A page that no longer exists falls through to the next.
  assert.equal((await turn.view(docWith("p2", "p3"), "ws-1")).pageId, "p2");
  assert.equal((await turn.view(docWith("p9"), "ws-1")).pageId, "p9");
});

test("a turn without the registry still follows its own shown page", async () => {
  const doc = docWith("p1", "p2");
  const turn = designTurnPages({ chatId: "chat-a" });
  assert.equal((await turn.view(doc, "ws-1")).pageId, "p1");
  assert.equal(await turn.show("ws-1", "p2"), undefined);
  assert.equal((await turn.view(doc, "ws-1")).pageId, "p2");
});
