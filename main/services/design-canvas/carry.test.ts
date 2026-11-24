// A No workspace chat's canvas following its files into a project workspace.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { DESIGN_CANVAS_LIMITS, emptyDesignCanvas, type DesignCanvas, type DesignFrame } from "../../../renderer/shared/design-canvas/schema.js";
import { createDesignCanvasCarry } from "./carry.js";
import { DesignCanvasStore } from "./store.js";
import { DesignCanvasViews } from "./views.js";

async function setup(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-carry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DesignCanvasStore({ root: () => root });
  const views = new DesignCanvasViews();
  const broadcasts: unknown[] = [];
  let next = 0;
  const carry = createDesignCanvasCarry({
    store,
    views,
    broadcast: (update) => broadcasts.push(update),
    newId: () => `new-${++next}`,
  });
  return { root, store, views, carry, broadcasts };
}

const frame = (id: string, extra: Partial<DesignFrame> & Pick<DesignFrame, "kind">): DesignFrame => ({
  id,
  title: id,
  x: 0,
  y: 0,
  w: 200,
  h: 120,
  pageId: "page-1",
  createdBy: "aiden",
  ...extra,
});

function hiddenCanvas(): DesignCanvas {
  return {
    ...emptyDesignCanvas(),
    frames: [
      frame("hero", { kind: "file", path: "design/hero.html", chatId: "chat-1" }),
      frame("idea", { kind: "note", text: "warmer" }),
      frame("left-behind", { kind: "image", path: "tmp/scratch.png" }),
    ],
  };
}

test("a copied chat's pages land after the workspace's, named after the chat, with frames following their files; the chat is shown its first page", async (t) => {
  const { store, views, carry, broadcasts } = await setup(t);
  await store.save("hidden", hiddenCanvas(), 0);
  await store.save("project", { ...emptyDesignCanvas(), frames: [frame("theirs", { kind: "note", text: "" })] }, 0);
  const outcome = await carry.carry({
    chatId: "chat-1",
    label: "Brand refresh",
    fromWorkspaceId: "hidden",
    toWorkspaceId: "project",
    copied: [{ from: "design/hero.html", to: "aiden-scratch/design/hero.html" }],
  });
  assert.equal(outcome, "carried");
  const merged = await store.get("project");
  assert.deepEqual(merged.pages.map((page) => page.name), ["Page 1", "Brand refresh · Page 1"]);
  const carriedPage = merged.pages[1]!.id;
  const carriedFrames = merged.frames.filter((entry) => entry.pageId === carriedPage);
  assert.deepEqual(
    carriedFrames.map((entry) => [entry.id, entry.path]),
    [
      ["hero", "aiden-scratch/design/hero.html"],
      ["idea", undefined],
    ],
    "a frame whose file was not copied stays behind",
  );
  assert.equal((await views.get("chat-1", "project"))?.pageId, carriedPage);
  assert.deepEqual(broadcasts, [{ workspaceId: "project", chatId: "chat-1", revision: merged.revision }]);
  assert.equal((await store.get("hidden")).frames.length, 3, "the hidden canvas is only read");
});

test("a canvas too large to bring along changes nothing and says so", async (t) => {
  const { store, views, carry } = await setup(t);
  await store.save("hidden", hiddenCanvas(), 0);
  const full: DesignCanvas = {
    ...emptyDesignCanvas(),
    pages: Array.from({ length: DESIGN_CANVAS_LIMITS.pages }, (_, index) => ({ id: `p${index}`, name: `Page ${index + 1}` })),
  };
  await store.save("project", full, 0);
  const before = await store.get("project");
  const outcome = await carry.carry({
    chatId: "chat-1",
    label: "Chat",
    fromWorkspaceId: "hidden",
    toWorkspaceId: "project",
    copied: [{ from: "design/hero.html", to: "design/hero.html" }],
  });
  assert.equal(outcome, "too-large");
  assert.deepEqual(await store.get("project"), before);
  assert.equal(await views.get("chat-1", "project"), undefined);
});

test("a hidden workspace with nothing on its canvas writes no canvas for the project", async (t) => {
  const { root, carry } = await setup(t);
  const outcome = await carry.carry({ chatId: "chat-1", label: "Chat", fromWorkspaceId: "hidden", toWorkspaceId: "project", copied: [] });
  assert.equal(outcome, "nothing");
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith(".json")), []);
});

test("an attached chat claims the first page it brought along, and the hidden canvas's own claims and marks stay behind", async (t) => {
  const { store, carry } = await setup(t);
  await store.update("hidden", (current): DesignCanvas => ({
    ...hiddenCanvas(),
    pages: [{ id: "page-1", name: "Page 1", namedFor: "chat-1" }],
    chatPages: { "chat-1": "page-1", "chat-7": "page-1" },
    revision: current.revision,
  }));
  await store.update("project", (current): DesignCanvas => ({ ...current, chatPages: { "chat-2": "page-1" } }));
  await carry.carry({
    chatId: "chat-1",
    label: "Brand refresh",
    fromWorkspaceId: "hidden",
    toWorkspaceId: "project",
    copied: [{ from: "design/hero.html", to: "design/hero.html" }],
  });
  const merged = await store.get("project");
  const carriedPage = merged.pages[1]!;
  assert.deepEqual(merged.chatPages, { "chat-2": "page-1", "chat-1": carriedPage.id });
  assert.equal(carriedPage.namedFor, undefined, "carried pages are named after the chat, not made for it");
});

test("at a full set of chat pages, the pages still come over without a claim", async (t) => {
  const { store, views, carry } = await setup(t);
  await store.save("hidden", hiddenCanvas(), 0);
  const full = Object.fromEntries(
    Array.from({ length: DESIGN_CANVAS_LIMITS.chatPages }, (_, index) => [`chat-other-${index}`, "page-1"]),
  );
  await store.update("project", (current): DesignCanvas => ({ ...current, chatPages: full }));
  const outcome = await carry.carry({
    chatId: "chat-1",
    label: "Chat",
    fromWorkspaceId: "hidden",
    toWorkspaceId: "project",
    copied: [{ from: "design/hero.html", to: "design/hero.html" }],
  });
  assert.equal(outcome, "carried");
  const merged = await store.get("project");
  assert.equal(merged.pages.length, 2);
  assert.equal(merged.chatPages["chat-1"], undefined);
  assert.equal((await views.get("chat-1", "project"))?.pageId, merged.pages[1]!.id, "the chat is still shown its page");
});

test("when nothing comes along, no claim is made", async (t) => {
  const { store, carry } = await setup(t);
  await store.save("hidden", { ...emptyDesignCanvas(), frames: [frame("left-behind", { kind: "image", path: "tmp/scratch.png" })] }, 0);
  await store.save("project", { ...emptyDesignCanvas(), frames: [frame("theirs", { kind: "note", text: "" })] }, 0);
  const outcome = await carry.carry({ chatId: "chat-1", label: "Chat", fromWorkspaceId: "hidden", toWorkspaceId: "project", copied: [] });
  assert.equal(outcome, "nothing");
  assert.deepEqual((await store.get("project")).chatPages, {});
});
