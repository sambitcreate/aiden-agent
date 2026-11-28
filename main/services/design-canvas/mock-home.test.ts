// A new design app's `/` on the canvas (design mode v2 Phase 3d, S113), on
// real canvas stores in a temp folder.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { DesignCanvas, DesignFrame } from "../../../renderer/shared/design-canvas/schema.js";
import { placeMockHome, type MockHomeDeps } from "./mock-home.js";
import { DesignCanvasStore, DesignChatCanvases } from "./store.js";
import { DesignCanvasViews, designTurnPages } from "./views.js";

async function harness(t: TestContext, options: { designMode?: () => boolean } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-mock-home-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspaceStore = new DesignCanvasStore({ root: () => path.join(base, "canvases") });
  const store = new DesignChatCanvases({ store: workspaceStore, workspaceIdOf: async () => "ws-1" });
  const views = new DesignCanvasViews();
  const focused: Array<{ pageId: string; frameIds: readonly string[] }> = [];
  const added: number[] = [];
  const broadcasts: unknown[] = [];
  let next = 0;
  const deps: MockHomeDeps = {
    store,
    broadcast: (update) => broadcasts.push(update),
    newId: () => `id-${++next}`,
    inDesignMode: async () => options.designMode?.() ?? true,
    focus: (request) => focused.push({ pageId: request.pageId, frameIds: request.frameIds }),
    onAppFrameAdded: (width) => added.push(width),
  };
  const input = (pageId?: string) => ({
    chatId: "chat-1",
    workspaceId: "ws-1",
    workspaceRoot: base,
    appRoot: "design-app",
    pages: designTurnPages({ views, chatId: "chat-1", ...(pageId ? { message: { selection: [], pageId } } : {}) }),
  });
  return { store, workspaceStore, deps, input, focused, added, broadcasts };
}

const homeFrames = (doc: DesignCanvas) => doc.frames.filter((frame) => frame.kind === "app" && frame.appRoot === "design-app" && frame.route === "/");

const note = (id: string, pageId: string): DesignFrame => ({ id, kind: "note", title: "Note", text: "hi", x: 0, y: 0, w: 200, h: 120, pageId, createdBy: "person" });

test("/ lands on a page that already has notes and frames, beside them, and is reported once", async (t) => {
  const h = await harness(t);
  await h.store.update("chat-1", (doc) => ({ ...doc, pages: [...doc.pages, { id: "p2", name: "Two" }], frames: [note("n1", "p2"), note("n2", "page-1")] }));
  assert.equal(await placeMockHome(h.input("p2"), h.deps), "placed");
  const doc = await h.workspaceStore.get("ws-1");
  const [home] = homeFrames(doc);
  assert.ok(home);
  assert.equal(home.pageId, "p2", "the page the scaffold was asked from");
  assert.equal(doc.frames.length, 3, "nothing else moved or went");
  const noteFrame = doc.frames.find((frame) => frame.id === "n1")!;
  assert.ok(home.x >= noteFrame.x + noteFrame.w || home.y >= noteFrame.y + noteFrame.h, "beside the note, not on it");
  assert.deepEqual(h.added, [1280]);
  assert.deepEqual(h.focused, [{ pageId: "p2", frameIds: [home.id] }]);
  assert.equal(h.broadcasts.length > 0, true);
});

test("an existing / frame is focused, not duplicated, and not reported", async (t) => {
  const h = await harness(t);
  assert.equal(await placeMockHome(h.input(), h.deps), "placed");
  h.added.length = 0;
  h.focused.length = 0;
  assert.equal(await placeMockHome(h.input(), h.deps), "already");
  const doc = await h.workspaceStore.get("ws-1");
  assert.equal(homeFrames(doc).length, 1);
  assert.deepEqual(h.added, []);
  assert.deepEqual(h.focused, [{ pageId: homeFrames(doc)[0]!.pageId, frameIds: [homeFrames(doc)[0]!.id] }]);
});

test("a chat that left design mode before the write places nothing", async (t) => {
  let designing = true;
  const h = await harness(t, { designMode: () => designing });
  designing = false;
  assert.equal(await placeMockHome(h.input(), h.deps), "refused");
  assert.deepEqual(homeFrames(await h.workspaceStore.get("ws-1")), []);
  assert.deepEqual([h.added, h.focused], [[], []]);

  // Leaving while the placement waits on the canvas: the save's own check refuses it.
  designing = true;
  let asks = 0;
  const leaving = { ...h.deps, inDesignMode: async () => ++asks <= 1 };
  assert.equal(await placeMockHome(h.input(), leaving), "refused");
  assert.deepEqual(homeFrames(await h.workspaceStore.get("ws-1")), []);
  assert.deepEqual(h.added, []);
});
