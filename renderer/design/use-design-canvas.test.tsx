// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { emitBotTestNotification, installBotTestIpc, type BotTestIpcCall } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { act, cleanup, render } from "@testing-library/react";
import { deletePage, renamePage } from "../shared/design-canvas/pages";
import { emptyDesignCanvas, type DesignCanvas, type DesignFrame } from "../shared/design-canvas/schema";
import { DESIGN_CANVAS_CLOSED_RETRY_MS, useDesignCanvas } from "./use-design-canvas";

type Controller = ReturnType<typeof useDesignCanvas>;
type SaveReply =
  | { ok: true; revision: number; chatPages?: Record<string, string>; namedFor?: Record<string, string> }
  | { ok: false; reason: "conflict"; doc: DesignCanvas }
  | { ok: false; reason: "moved"; workspaceId: string }
  | { ok: false; reason: "invalid"; issues: string[] };

function note(id: string, x = 0): DesignFrame {
  return { id, kind: "note", title: id, x, y: 0, w: 200, h: 120, text: id, pageId: "page-1", createdBy: "person" };
}
function canvas(revision: number, ...frames: DesignFrame[]): DesignCanvas {
  return { ...emptyDesignCanvas(), revision, frames };
}
const moveTo = (id: string, x: number) => (doc: DesignCanvas): DesignCanvas => ({
  ...doc,
  frames: doc.frames.map((frame) => (frame.id === id ? { ...frame, x } : frame)),
});
const addNote = (id: string) => (doc: DesignCanvas): DesignCanvas => ({ ...doc, frames: [...doc.frames, note(id)] });
const xOf = (doc: DesignCanvas | undefined, id: string) => doc?.frames.find((frame) => frame.id === id)?.x;
const ids = (doc: DesignCanvas | undefined) => doc?.frames.map((frame) => frame.id) ?? [];

let calls: BotTestIpcCall[];
let stored: DesignCanvas;
let saveReplies: Array<(doc: DesignCanvas, base: number) => SaveReply | Promise<SaveReply>>;
let controller: Controller;
let movedTo: string[];

function Probe({ chatId, workspaceId = "workspace-1" }: { chatId: string; workspaceId?: string }) {
  controller = useDesignCanvas(workspaceId, chatId, { onMoved: (id) => movedTo.push(id) });
  return null;
}

const saves = () => calls.filter((call) => call.channel === "designCanvas:save");
const gets = () => calls.filter((call) => call.channel === "designCanvas:get");
/** Lets pending IPC promises and the React updates they cause settle. */
async function settle() {
  for (let index = 0; index < 5; index += 1) await act(async () => {});
}
async function tick(ms: number) {
  await act(async () => {
    mock.timers.tick(ms);
  });
  await settle();
}
async function mount(chatId = "chat-1") {
  const view = render(<Probe chatId={chatId} />);
  await settle();
  return view;
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  stored = canvas(4, note("a"));
  saveReplies = [];
  movedTo = [];
  calls = installBotTestIpc({
    "designCanvas:get": () => structuredClone(stored),
    "designCanvas:save": (_chatId, doc, base) => {
      const reply = saveReplies.shift();
      if (reply) return reply(doc as DesignCanvas, base as number);
      stored = { ...(doc as DesignCanvas), revision: (base as number) + 1 };
      return { ok: true, revision: stored.revision };
    },
  });
});

afterEach(() => {
  cleanup();
  mock.timers.reset();
});

test("the canvas loads, then two quick edits make one save from the loaded revision", async () => {
  await mount();
  assert.equal(controller.status, "ready");
  assert.deepEqual(ids(controller.doc), ["a"]);

  await act(async () => controller.change(moveTo("a", 50)));
  await tick(400);
  await act(async () => controller.change(addNote("b")));
  assert.equal(xOf(controller.doc, "a"), 50, "edits show at once");
  await tick(799);
  assert.equal(saves().length, 0, "still inside the 800 ms debounce");
  await tick(1);

  assert.equal(saves().length, 1);
  const [chatId, doc, base, options] = saves()[0]!.args as [string, DesignCanvas, number, { workspaceId?: string }];
  assert.equal(chatId, "chat-1");
  assert.equal(base, 4);
  assert.equal(options.workspaceId, "workspace-1", "the save names the workspace whose canvas this is");
  assert.deepEqual(ids(doc), ["a", "b"]);
  assert.equal(xOf(doc, "a"), 50);
  assert.equal(controller.status, "ready");
});

test("a conflicting save takes the other window's canvas and reapplies this edit on top", async () => {
  await mount();
  // Another window added "c" and saved revision 5 first.
  const theirs = canvas(5, note("a"), note("c", 900));
  saveReplies.push(() => ({ ok: false, reason: "conflict", doc: theirs }));

  await act(async () => controller.change(moveTo("a", 300)));
  await tick(800);

  assert.equal(saves().length, 2, "the edit is saved again straight after the conflict");
  const [, retried, base] = saves()[1]!.args as [string, DesignCanvas, number];
  assert.equal(base, 5);
  assert.deepEqual(ids(retried), ["a", "c"], "their frame is kept");
  assert.equal(xOf(retried, "a"), 300, "and so is this window's move");
  assert.deepEqual(ids(controller.doc), ["a", "c"]);
  assert.equal(xOf(controller.doc, "a"), 300);
  assert.equal(controller.status, "ready");
});

test("an edit that conflicts twice is not retried forever", async () => {
  await mount();
  saveReplies.push(
    () => ({ ok: false, reason: "conflict", doc: canvas(5, note("a"), note("c")) }),
    () => ({ ok: false, reason: "conflict", doc: canvas(6, note("a"), note("c"), note("d")) }),
  );
  await act(async () => controller.change(moveTo("a", 300)));
  await tick(800);
  await tick(5000);
  assert.equal(saves().length, 2);
  assert.equal(controller.status, "error");
  assert.deepEqual(ids(controller.doc), ["a", "c", "d"], "the latest stored canvas is shown");
  assert.equal(xOf(controller.doc, "a"), 300, "with this window's edit still on top");

  // The next edit saves both, on the newest stored revision.
  await act(async () => controller.change(addNote("b")));
  await tick(800);
  assert.equal(saves().length, 3);
  const [, doc, base] = saves()[2]!.args as [string, DesignCanvas, number];
  assert.equal(base, 6);
  assert.deepEqual(ids(doc), ["a", "c", "d", "b"]);
  assert.equal(xOf(doc, "a"), 300, "the edit that conflicted twice is not lost");
  assert.equal(controller.status, "ready");
});

test("an update from elsewhere reloads an idle canvas but waits while an edit is pending", async () => {
  await mount();
  assert.equal(gets().length, 1);

  stored = canvas(5, note("a"), note("remote"));
  await act(async () => emitBotTestNotification("designCanvas:updated", { workspaceId: "workspace-1", chatId: "chat-1", revision: 5 }));
  await settle();
  assert.equal(gets().length, 2);
  assert.deepEqual(ids(controller.doc), ["a", "remote"]);

  await act(async () => emitBotTestNotification("designCanvas:updated", { workspaceId: "workspace-2", chatId: "chat-1", revision: 9 }));
  await act(async () => emitBotTestNotification("designCanvas:updated", { workspaceId: "workspace-1", chatId: "chat-1", revision: 5 }));
  await settle();
  assert.equal(gets().length, 2, "another workspace's update and an already-held revision are ignored");

  // Another chat of the same workspace changed the shared canvas.
  stored = canvas(6, note("a"), note("remote"), note("from-b"));
  await act(async () => emitBotTestNotification("designCanvas:updated", { workspaceId: "workspace-1", chatId: "chat-b", revision: 6 }));
  await settle();
  assert.equal(gets().length, 3);
  assert.deepEqual(ids(controller.doc), ["a", "remote", "from-b"]);

  await act(async () => controller.change(moveTo("a", 70)));
  stored = canvas(7, note("a"), note("remote"), note("from-b"), note("later"));
  await act(async () => emitBotTestNotification("designCanvas:updated", { workspaceId: "workspace-1", chatId: "chat-1", revision: 7 }));
  await settle();
  assert.equal(gets().length, 3, "a pending edit is not thrown away by a reload");
  assert.equal(xOf(controller.doc, "a"), 70);

  saveReplies.push(() => ({ ok: false, reason: "conflict", doc: structuredClone(stored) }));
  await tick(800);
  assert.deepEqual(ids(controller.doc), ["a", "remote", "from-b", "later"]);
  assert.equal(xOf(controller.doc, "a"), 70);
});

test("leaving the canvas saves a pending edit at once", async () => {
  const view = await mount();
  await act(async () => controller.change(addNote("b")));
  assert.equal(saves().length, 0);
  view.unmount();
  await settle();
  assert.equal(saves().length, 1, "saved without waiting for the debounce");
  assert.deepEqual(ids(saves()[0]!.args[1] as DesignCanvas), ["a", "b"]);
});

test("an edit that cannot be saved as the canvas closes keeps trying, and is saved once the app can", async () => {
  const view = await mount();
  saveReplies.push(() => {
    throw new Error("store busy");
  });
  await act(async () => controller.change(addNote("b")));
  view.unmount();
  await settle();
  assert.equal(saves().length, 1, "leaving tried at once");
  assert.deepEqual(ids(stored), ["a"]);

  await tick(DESIGN_CANVAS_CLOSED_RETRY_MS[0]!);
  assert.equal(saves().length, 2, "and again after the canvas closed");
  assert.deepEqual(ids(stored), ["a", "b"], "the edit reached the store");
  await tick(60_000);
  assert.equal(saves().length, 2, "nothing more once it is saved");
});

test("a closed canvas stops retrying on its own after a few tries", async () => {
  const view = await mount();
  for (let index = 0; index < 20; index += 1) {
    saveReplies.push(() => {
      throw new Error("chat is gone");
    });
  }
  await act(async () => controller.change(addNote("b")));
  view.unmount();
  await settle();
  for (const delay of DESIGN_CANVAS_CLOSED_RETRY_MS) await tick(delay);
  const tries = saves().length;
  assert.equal(tries, DESIGN_CANVAS_CLOSED_RETRY_MS.length + 1);
  await tick(120_000);
  assert.equal(saves().length, tries, "no retry loop");
  // The edit is still held for the next quit, close or reload; let it save so no session outlives the test.
  saveReplies.length = 0;
  await act(async () => {
    await window.__aidenFlushPendingSaves?.();
  });
  assert.deepEqual(ids(stored), ["a", "b"]);
});

test("unsaved canvas edits keep the app's close guard dirty until they are saved, even after the canvas closes", async () => {
  const dataset = document.documentElement.dataset;
  const designDirty = () => (dataset.aidenDirtySources ?? "").split(" ").includes("design");
  const view = await mount();
  for (let index = 0; index < 20; index += 1) {
    saveReplies.push(() => {
      throw new Error("store busy");
    });
  }
  await act(async () => controller.change(addNote("b")));
  assert.equal(designDirty(), true, "an edit waiting to save is unsaved work");
  view.unmount();
  await settle();
  for (const delay of DESIGN_CANVAS_CLOSED_RETRY_MS) await tick(delay);
  assert.equal(designDirty(), true, "still unsaved after the closed canvas stopped retrying");
  assert.equal(dataset.aidenDirty, "1");

  // Quitting tries once more; the save fails again, so the guard stays dirty and main asks.
  await act(async () => {
    await window.__aidenFlushPendingSaves?.();
  });
  assert.equal(designDirty(), true, "a failed teardown flush leaves the work guarded");

  // A later flush that saves releases it.
  saveReplies.length = 0;
  await act(async () => {
    await window.__aidenFlushPendingSaves?.();
  });
  assert.deepEqual(ids(stored), ["a", "b"]);
  assert.equal(designDirty(), false);
  assert.equal(dataset.aidenDirty, "0");
});

test("quitting while a closed canvas still holds unsaved edits saves them", async () => {
  const view = await mount();
  saveReplies.push(() => {
    throw new Error("store busy");
  });
  await act(async () => controller.change(addNote("b")));
  view.unmount();
  await settle();
  assert.deepEqual(ids(stored), ["a"]);
  await act(async () => {
    await window.__aidenFlushPendingSaves?.();
  });
  assert.deepEqual(ids(stored), ["a", "b"], "the app's own flush before quitting saved it");
});

test("undo and redo step through recorded edits, and unrecorded edits fold into the last one", async () => {
  await mount();
  assert.equal(controller.canUndo, false);
  await act(async () => controller.change(moveTo("a", 10)));
  await act(async () => controller.change(moveTo("a", 20), { record: false }));
  await act(async () => controller.change(moveTo("a", 30), { record: false }));
  await act(async () => controller.change(addNote("b")));
  assert.equal(controller.canUndo, true);

  await act(async () => controller.undo());
  assert.deepEqual(ids(controller.doc), ["a"]);
  assert.equal(xOf(controller.doc, "a"), 30);
  await act(async () => controller.undo());
  assert.equal(xOf(controller.doc, "a"), 0, "the drag undoes as one step");
  assert.equal(controller.canUndo, false);
  assert.equal(controller.canRedo, true);

  await act(async () => controller.redo());
  assert.equal(xOf(controller.doc, "a"), 30);
  await tick(800);
  assert.equal(saves().length, 1, "undo and redo are saved like any edit");
  assert.equal(xOf(saves()[0]!.args[1] as DesignCanvas, "a"), 30);
});

test("a save says which pages an undo took off, so the store does not remember them as the person's removals", async () => {
  await mount();
  const page: DesignFrame = { id: "p", kind: "file", title: "q.html", path: "design/q.html", x: 0, y: 400, w: 640, h: 436, designWidth: 1280, pageId: "page-1", createdBy: "aiden" };
  const dropPage = (doc: DesignCanvas): DesignCanvas => ({ ...doc, frames: doc.frames.filter((frame) => frame.id !== "p") });
  const undoneOf = (index: number) => (saves()[index]!.args[3] as { undone?: string[] } | undefined)?.undone;
  await act(async () => controller.change((doc) => ({ ...doc, frames: [...doc.frames, page] })));
  await tick(800);
  assert.equal(undoneOf(0), undefined);

  await act(async () => controller.undo());
  await tick(800);
  assert.deepEqual(undoneOf(1), ["design/q.html"], "the undo took the page off");

  await act(async () => controller.redo());
  await tick(800);
  // Within one save: an undo takes the page off, a redo puts it back, then the person deletes it.
  await act(async () => controller.undo());
  await act(async () => controller.redo());
  await act(async () => controller.change(dropPage));
  await tick(800);
  assert.equal(saves().length, 4);
  assert.deepEqual(ids(saves()[3]!.args[1] as DesignCanvas), ["a"]);
  assert.equal(undoneOf(3), undefined, "deleting the page is the person's removal");

  // An undo and redo within one save leave the page shown; another window then takes it off.
  await act(async () => controller.change((doc) => ({ ...doc, frames: [...doc.frames, page] })));
  await act(async () => controller.undo());
  await act(async () => controller.redo());
  await tick(800);
  assert.equal(undoneOf(4), undefined);
  stored = { ...stored, revision: stored.revision + 1, frames: stored.frames.filter((frame) => frame.id !== "p") };
  await act(async () => emitBotTestNotification("designCanvas:updated", { workspaceId: "workspace-1", chatId: "chat-1", revision: stored.revision }));
  await settle();
  assert.deepEqual(ids(controller.doc), ["a"]);
  await act(async () => controller.change(moveTo("a", 50)));
  await tick(800);
  assert.equal(saves().length, 6);
  assert.equal(undoneOf(5), undefined, "the other window's removal is not called an undo of this one");
});

test("an undo waiting to save does not take back a frame another window added", async () => {
  await mount();
  await act(async () => controller.change(addNote("b")));
  await act(async () => controller.undo());
  assert.deepEqual(ids(controller.doc), ["a"]);
  // Another window added "c" before this window's edits were saved.
  saveReplies.push(() => ({ ok: false, reason: "conflict", doc: canvas(5, note("a"), note("c", 900)) }));
  await tick(800);

  const [, retried] = saves()[1]!.args as [string, DesignCanvas, number];
  assert.deepEqual(ids(retried), ["a", "c"], "their frame is saved, and the undone note stays gone");
  assert.deepEqual(ids(controller.doc), ["a", "c"]);
});

test("after taking in another window's canvas, undo still takes back this window's edit but not what that window added", async () => {
  await mount();
  await act(async () => controller.change(moveTo("a", 10)));
  saveReplies.push(() => ({ ok: false, reason: "conflict", doc: canvas(5, note("a"), note("c", 900)) }));
  await tick(800);
  assert.deepEqual(ids(controller.doc), ["a", "c"]);
  assert.equal(controller.canUndo, true, "taking in their canvas keeps this window's history");

  await act(async () => controller.undo());
  assert.deepEqual(ids(controller.doc), ["a", "c"]);
  assert.equal(xOf(controller.doc, "a"), 0);
  await tick(800);
  assert.deepEqual(ids(stored), ["a", "c"]);
  assert.equal(xOf(stored, "a"), 0);
});

/** Aiden saves `doc` in reply `turn` and an idle canvas hears about it. */
async function aidenSaves(doc: DesignCanvas, turn: string) {
  stored = doc;
  await act(async () => emitBotTestNotification("designCanvas:updated", { workspaceId: "workspace-1", chatId: "chat-1", revision: doc.revision, aidenTurn: turn }));
  await settle();
}

test("all of one Aiden reply's canvas changes undo as one step, after which the person's own edits still undo", async () => {
  await mount();
  await act(async () => controller.change(moveTo("a", 10)));
  await tick(800);
  assert.equal(stored.revision, 5);

  await aidenSaves(canvas(6, note("a", 10), note("b", 400)), "reply-1");
  await aidenSaves(canvas(7, note("a", 10), note("b", 400), note("c", 800)), "reply-1");
  assert.deepEqual(ids(controller.doc), ["a", "b", "c"]);

  await act(async () => controller.undo());
  assert.deepEqual(ids(controller.doc), ["a"], "both of the reply's frames go in one undo");
  assert.equal(xOf(controller.doc, "a"), 10);
  await act(async () => controller.undo());
  assert.equal(xOf(controller.doc, "a"), 0, "the person's move before the reply is still undoable");

  await act(async () => controller.redo());
  await act(async () => controller.redo());
  assert.deepEqual(ids(controller.doc), ["a", "b", "c"]);
  await tick(800);
  assert.deepEqual(ids(stored), ["a", "b", "c"]);
});

test("undoing a turn that used a page keeps the picker on the stored claim", async () => {
  stored = { ...canvas(4, note("a")), pages: [{ id: "page-1", name: "Page 1" }, { id: "p2", name: "Pricing" }] };
  await mount();
  await act(async () => controller.change(moveTo("a", 10)));
  await tick(800);
  // Aiden's reply makes Pricing this chat's page and adds a note there.
  await aidenSaves({ ...stored, revision: 6, chatPages: { "chat-1": "p2" }, frames: [note("a", 10), { ...note("b"), pageId: "p2" }] }, "reply-1");
  assert.deepEqual(controller.doc?.chatPages, { "chat-1": "p2" });

  // Undoing the reply sends the old claims; the store keeps its own and says so.
  saveReplies.push((doc, base) => {
    stored = { ...doc, revision: base + 1, chatPages: { "chat-1": "p2" } };
    return { ok: true, revision: stored.revision, chatPages: { "chat-1": "p2" }, namedFor: {} };
  });
  await act(async () => controller.undo());
  await tick(800);
  assert.deepEqual(ids(controller.doc), ["a"]);
  assert.deepEqual(controller.doc?.chatPages, { "chat-1": "p2" }, "the canvas shows the stored claim");

  // The claim is in every kept step, so the next undo does not bring the stale one back.
  await act(async () => controller.undo());
  assert.equal(xOf(controller.doc, "a"), 0);
  assert.deepEqual(controller.doc?.chatPages, { "chat-1": "p2" });
  await tick(800);
  assert.deepEqual(stored.chatPages, { "chat-1": "p2" });
});

/** A save reply that answers only once `release` is called, as a save still on its way. */
function heldReply(answer: (doc: DesignCanvas, base: number) => SaveReply) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  saveReplies.push(async (doc, base) => {
    await gate;
    return answer(doc, base);
  });
  return () => act(async () => release());
}

test("a save's stored claims do not undo a second undo made while that save was on its way", async () => {
  stored = {
    ...canvas(4, note("a")),
    pages: [{ id: "page-1", name: "Page 1" }, { id: "p", name: "P" }, { id: "pa", name: "Pa" }],
    chatPages: { "chat-1": "pa", "chat-b": "p" },
  };
  await mount();
  // The person deletes P, chat-b's page; chat-b moves to Page 1.
  await act(async () => controller.change((doc) => deletePage(doc, "p")));
  await tick(800);
  // This chat's reply makes Page 1 its page.
  await aidenSaves({ ...stored, revision: 6, chatPages: { "chat-1": "page-1", "chat-b": "page-1" } }, "reply-1");

  // Undoing the reply sends chat-1 back to Pa; the store keeps its claim on Page 1.
  const release = heldReply((doc, base) => {
    stored = { ...doc, revision: base + 1, chatPages: { "chat-1": "page-1", "chat-b": "page-1" } };
    return { ok: true, revision: stored.revision, chatPages: { "chat-1": "page-1", "chat-b": "page-1" }, namedFor: {} };
  });
  await act(async () => controller.undo());
  await tick(800);
  // Before that save answers, the person undoes the delete: P is back with chat-b on it.
  await act(async () => controller.undo());
  assert.equal(controller.doc?.chatPages["chat-b"], "p");
  await release();
  await settle();
  assert.deepEqual(controller.doc?.chatPages, { "chat-1": "page-1", "chat-b": "p" }, "only what the store changed is applied");
  assert.ok(controller.doc?.pages.some((page) => page.id === "p"));
});

test("a page renamed while a save was on its way keeps the person's name and does not follow its chat again", async () => {
  stored = {
    ...canvas(4, note("a")),
    pages: [{ id: "page-1", name: "Page 1" }, { id: "P", name: "Chat A", namedFor: "chat-a" }],
    chatPages: { "chat-a": "page-1" },
  };
  await mount();
  const release = heldReply((doc, base) => {
    stored = { ...doc, revision: base + 1, chatPages: { "chat-a": "P" } };
    return { ok: true, revision: stored.revision, chatPages: { "chat-a": "P" }, namedFor: { P: "chat-a" } };
  });
  await act(async () => controller.change(moveTo("a", 50)));
  await tick(800);
  await act(async () => controller.change((doc) => renamePage(doc, "P", "Bar")));
  await release();
  await settle();
  assert.deepEqual(controller.doc?.pages[1], { id: "P", name: "Bar" });
  assert.equal(controller.doc?.chatPages["chat-a"], "P");
});

test("a reply's change the canvas fetched before hearing whose it was still undoes with the rest of that reply", async () => {
  await mount();
  await act(async () => controller.change(moveTo("a", 10)));
  await tick(800);
  // Aiden has already saved revision 7 by the time the fetch for revision 6 reads the store.
  stored = canvas(7, note("a", 10), note("b", 400), note("c", 800));
  await act(async () => emitBotTestNotification("designCanvas:updated", { workspaceId: "workspace-1", chatId: "chat-1", revision: 6, aidenTurn: "reply-1" }));
  await settle();
  assert.deepEqual(ids(controller.doc), ["a", "b", "c"]);
  await act(async () => emitBotTestNotification("designCanvas:updated", { workspaceId: "workspace-1", chatId: "chat-1", revision: 7, aidenTurn: "reply-1" }));
  await settle();

  await act(async () => controller.undo());
  assert.deepEqual(ids(controller.doc), ["a"], "both of the reply's frames go in one undo");
  assert.equal(xOf(controller.doc, "a"), 10);
  await act(async () => controller.undo());
  assert.equal(xOf(controller.doc, "a"), 0, "the person's move before the reply is still undoable");
  assert.equal(controller.canUndo, false);

  // A save's conflict can bring a reply's revision before its announcement too.
  await act(async () => controller.redo());
  await act(async () => controller.redo());
  saveReplies.push(() => ({ ok: false, reason: "conflict", doc: canvas(8, note("a", 10), note("b", 400), note("c", 800), note("d", 1200)) }));
  await tick(800);
  assert.deepEqual(ids(controller.doc).sort(), ["a", "b", "c", "d"]);
  await act(async () => emitBotTestNotification("designCanvas:updated", { workspaceId: "workspace-1", chatId: "chat-1", revision: 8, aidenTurn: "reply-2" }));
  await settle();
  await act(async () => controller.undo());
  assert.deepEqual(ids(controller.doc).sort(), ["a", "b", "c"], "the second reply's frame undoes on its own");
});

test("another chat's reply is never this chat's undo step, and this chat's redo survives it", async () => {
  await mount();
  await act(async () => controller.change(addNote("mine")));
  await tick(800);
  await act(async () => controller.undo());
  await tick(800);
  assert.equal(controller.canRedo, true);
  // Chat B's reply adds two frames to the shared canvas.
  const base = stored.revision;
  stored = canvas(base + 2, note("a"), note("b-1", 400), note("b-2", 800));
  for (const revision of [base + 1, base + 2]) {
    await act(async () =>
      emitBotTestNotification("designCanvas:updated", { workspaceId: "workspace-1", chatId: "chat-b", revision, aidenTurn: "reply-b" }),
    );
  }
  await settle();
  assert.deepEqual(ids(controller.doc), ["a", "b-1", "b-2"]);
  assert.equal(controller.canUndo, false, "chat B's frames are not an undo step here");
  await act(async () => controller.redo());
  assert.deepEqual(ids(controller.doc).sort(), ["a", "b-1", "b-2", "mine"], "this chat's redo still comes back, beside B's frames");
  await act(async () => controller.undo());
  assert.deepEqual(ids(controller.doc), ["a", "b-1", "b-2"], "and undo takes back only this chat's own frame");
});

test("a save answered moved drops its edits and names the workspace the chat is in now", async () => {
  const designDirty = () => (document.documentElement.dataset.aidenDirtySources ?? "").split(" ").includes("design");
  await mount();
  saveReplies.push(() => ({ ok: false, reason: "moved", workspaceId: "workspace-2" }));
  await act(async () => controller.change(addNote("b")));
  assert.equal(designDirty(), true);
  await tick(800);
  assert.deepEqual(movedTo, ["workspace-2"]);
  await tick(10_000);
  assert.equal(saves().length, 1, "the edits are not tried again on the old workspace");
  assert.notEqual(controller.status, "saving");
  assert.equal(designDirty(), false, "quitting does not ask about edits that can no longer be saved");
});

test("a moved answer reaching a canvas that has already closed does nothing", async () => {
  const view = await mount();
  let answer!: (reply: SaveReply) => void;
  calls = installBotTestIpc({
    "designCanvas:get": () => structuredClone(stored),
    "designCanvas:save": () => new Promise<SaveReply>((resolve) => (answer = resolve)),
  });
  await act(async () => controller.change(addNote("b")));
  await tick(800);
  view.unmount();
  await act(async () => answer({ ok: false, reason: "moved", workspaceId: "workspace-2" }));
  await settle();
  assert.deepEqual(movedTo, []);
});

test("undoing a reply leaves an edit the person made without a step of its own during it, such as a text frame growing", async () => {
  await mount();
  await aidenSaves(canvas(5, note("a"), note("b", 400)), "reply-1");
  await act(async () => controller.change(moveTo("a", 30), { record: false }));
  await tick(800);
  assert.equal(stored.revision, 6);
  await aidenSaves(canvas(7, note("a", 30), note("b", 400), note("c", 800)), "reply-1");

  await act(async () => controller.undo());
  assert.deepEqual(ids(controller.doc), ["a"], "the reply's frames go in one undo");
  assert.equal(xOf(controller.doc, "a"), 30, "and the person's edit stays");
  assert.equal(controller.canUndo, false);
  await act(async () => controller.redo());
  assert.deepEqual(ids(controller.doc), ["a", "b", "c"]);
  assert.equal(xOf(controller.doc, "a"), 30);
});

test("the person's edit between two of a reply's changes, or another reply, starts a new undo step", async () => {
  await mount();
  await aidenSaves(canvas(5, note("a"), note("b", 400)), "reply-1");
  await act(async () => controller.change(moveTo("b", 500)));
  await tick(800);
  await aidenSaves(canvas(7, note("a"), note("b", 500), note("c", 800)), "reply-1");
  await aidenSaves(canvas(8, note("a"), note("b", 500), note("c", 800), note("d", 1200)), "reply-2");

  await act(async () => controller.undo());
  assert.deepEqual(ids(controller.doc), ["a", "b", "c"], "the second reply's change undoes alone");
  await act(async () => controller.undo());
  assert.deepEqual(ids(controller.doc), ["a", "b"], "then the first reply's change after the person's edit");
  await act(async () => controller.undo());
  assert.equal(xOf(controller.doc, "b"), 400, "then the person's move");
  await act(async () => controller.undo());
  assert.deepEqual(ids(controller.doc), ["a"], "then the reply's first change");
  assert.equal(controller.canUndo, false);
});

test("a change no reply announced is carried into the history instead of becoming undoable", async () => {
  await mount();
  await act(async () => controller.change(moveTo("a", 10)));
  await tick(800);
  // Revision 6 came from another window, 7 from Aiden: together they are not one reply's.
  stored = canvas(7, note("a", 10), note("other", 400), note("aiden", 800));
  await act(async () => emitBotTestNotification("designCanvas:updated", { workspaceId: "workspace-1", chatId: "chat-1", revision: 6 }));
  await act(async () => emitBotTestNotification("designCanvas:updated", { workspaceId: "workspace-1", chatId: "chat-1", revision: 7, aidenTurn: "reply-1" }));
  await settle();
  assert.deepEqual(ids(controller.doc), ["a", "other", "aiden"]);

  await act(async () => controller.undo());
  assert.deepEqual(ids(controller.doc), ["a", "other", "aiden"]);
  assert.equal(xOf(controller.doc, "a"), 0, "the person's own move undoes, and nothing of theirs or Aiden's goes");
  assert.equal(controller.canUndo, false);
});

test("a visual the person sent to the open canvas undoes as their own step, one send at a time", async () => {
  await mount();
  await act(async () => controller.change(moveTo("a", 10)));
  await tick(800);
  // Two Send to canvas placements land in main, each announced as the person's own step.
  for (const [revision, frames] of [
    [6, [note("a", 10), note("sent-1", 400)]],
    [7, [note("a", 10), note("sent-1", 400), note("sent-2", 800)]],
  ] as const) {
    stored = canvas(revision, ...frames);
    await act(async () =>
      emitBotTestNotification("designCanvas:updated", { workspaceId: "workspace-1", chatId: "chat-1", revision, step: `send-to-canvas:${revision}` }),
    );
    await settle();
  }
  assert.deepEqual(ids(controller.doc), ["a", "sent-1", "sent-2"]);

  await act(async () => controller.undo());
  assert.deepEqual(ids(controller.doc), ["a", "sent-1"], "undo takes back only the latest send");
  await act(async () => controller.undo());
  assert.deepEqual(ids(controller.doc), ["a"]);
  assert.equal(xOf(controller.doc, "a"), 10, "the move before the sends stays");
  await tick(800);
  assert.deepEqual(ids(stored), ["a"], "the undone frames are saved off the canvas");

  await act(async () => controller.redo());
  assert.deepEqual(ids(controller.doc), ["a", "sent-1"]);
});

test("a save the app cannot deliver reports an error and waits for the next edit instead of retrying forever", async () => {
  await mount();
  saveReplies.push(() => {
    throw new Error("chat is gone");
  });
  await act(async () => controller.change(moveTo("a", 10)));
  await tick(800);
  assert.equal(controller.status, "error");
  await tick(10_000);
  assert.equal(saves().length, 1, "no retry loop");

  await act(async () => controller.change(addNote("b")));
  await tick(800);
  assert.equal(saves().length, 2);
  const [, doc] = saves()[1]!.args as [string, DesignCanvas, number];
  assert.equal(xOf(doc, "a"), 10, "the failed edit is still saved");
  assert.deepEqual(ids(doc), ["a", "b"]);
  assert.equal(controller.status, "ready");
});

test("an update from elsewhere that lands while a save is in flight is fetched once the save is done", async () => {
  await mount();
  saveReplies.push((doc, base) => {
    // Another window saves straight after this one, while this save is still on its way back.
    stored = canvas(base + 2, ...doc.frames, note("remote", 900));
    emitBotTestNotification("designCanvas:updated", { workspaceId: "workspace-1", chatId: "chat-1", revision: base + 2 });
    return { ok: true, revision: base + 1 };
  });
  await act(async () => controller.change(moveTo("a", 10)));
  await tick(800);
  await settle();
  assert.deepEqual(ids(controller.doc), ["a", "remote"]);
  assert.equal(xOf(controller.doc, "a"), 10);
});

test("an update announced while the initial read is still in flight is refetched as soon as the read lands", async () => {
  let resolveInitialGet!: (doc: DesignCanvas) => void;
  let firstRead = true;
  stored = canvas(0);
  calls = installBotTestIpc({
    "designCanvas:get": () => {
      if (firstRead) {
        firstRead = false;
        return new Promise<DesignCanvas>((resolve) => {
          resolveInitialGet = resolve;
        });
      }
      return structuredClone(stored);
    },
    "designCanvas:save": (_chatId, doc, base) => {
      stored = { ...(doc as DesignCanvas), revision: (base as number) + 1 };
      return { ok: true, revision: stored.revision };
    },
  });

  render(<Probe chatId="chat-1" />);
  await settle();
  assert.equal(controller.status, "loading");

  // Main's designPagesOnEntry saves revision 1 and broadcasts before the initial get resolves.
  stored = canvas(1, note("entry-page"));
  await act(async () => emitBotTestNotification("designCanvas:updated", { workspaceId: "workspace-1", chatId: "chat-1", revision: 1 }));
  await act(async () => resolveInitialGet(canvas(0)));
  await settle();

  assert.equal(gets().length, 2, "the stale initial revision triggers an immediate refetch");
  assert.equal(controller.doc?.revision, 1);
  assert.deepEqual(ids(controller.doc), ["entry-page"]);
});

test("saving now says whether the stored canvas caught up, so readers of it can wait or stop", async () => {
  await mount();
  await act(async () => controller.change(addNote("b")));
  let saved: boolean | undefined;
  await act(async () => {
    saved = await controller.flush();
  });
  assert.equal(saved, true);
  assert.deepEqual(ids(stored), ["a", "b"], "main now reads the new frame");

  saveReplies.push(() => ({ ok: false, reason: "invalid", issues: ["too big"] }));
  await act(async () => controller.change(addNote("c")));
  await act(async () => {
    saved = await controller.flush();
  });
  assert.equal(saved, false, "the stored canvas is still missing c");
  assert.deepEqual(ids(stored), ["a", "b"]);
  assert.deepEqual(ids(controller.doc), ["a", "b", "c"], "the unsaved edit is kept on screen");

  await act(async () => controller.change(moveTo("c", 30)));
  await act(async () => {
    saved = await controller.flush();
  });
  assert.equal(saved, true, "the next save takes the kept edit with it");
  assert.deepEqual(ids(stored), ["a", "b", "c"]);
});
