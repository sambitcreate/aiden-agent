// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { emitBotTestNotification, installBotTestIpc, type BotTestIpcCall } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { act, cleanup, render } from "@testing-library/react";
import {
  emptyDesignCanvas,
  type DesignCanvas,
  type DesignFrame,
} from "../shared/design-canvas/schema";
import { useDesignCanvas } from "./use-design-canvas";

type Controller = ReturnType<typeof useDesignCanvas>;
type SaveReply =
  | { ok: true; revision: number }
  | { ok: false; reason: "conflict"; doc: DesignCanvas }
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
let saveReplies: Array<(doc: DesignCanvas, base: number) => SaveReply>;
let controller: Controller;

function Probe({ chatId }: { chatId: string }) {
  controller = useDesignCanvas(chatId);
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
  const [chatId, doc, base] = saves()[0]!.args as [string, DesignCanvas, number];
  assert.equal(chatId, "chat-1");
  assert.equal(base, 4);
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
});

test("an update from elsewhere reloads an idle canvas but waits while an edit is pending", async () => {
  await mount();
  assert.equal(gets().length, 1);

  stored = canvas(5, note("a"), note("remote"));
  await act(async () => emitBotTestNotification("designCanvas:updated", { chatId: "chat-1", revision: 5 }));
  await settle();
  assert.equal(gets().length, 2);
  assert.deepEqual(ids(controller.doc), ["a", "remote"]);

  await act(async () => emitBotTestNotification("designCanvas:updated", { chatId: "other-chat", revision: 9 }));
  await act(async () => emitBotTestNotification("designCanvas:updated", { chatId: "chat-1", revision: 5 }));
  await settle();
  assert.equal(gets().length, 2, "another chat's update and an already-held revision are ignored");

  await act(async () => controller.change(moveTo("a", 70)));
  stored = canvas(6, note("a"), note("remote"), note("later"));
  await act(async () => emitBotTestNotification("designCanvas:updated", { chatId: "chat-1", revision: 6 }));
  await settle();
  assert.equal(gets().length, 2, "a pending edit is not thrown away by a reload");
  assert.equal(xOf(controller.doc, "a"), 70);

  saveReplies.push(() => ({ ok: false, reason: "conflict", doc: structuredClone(stored) }));
  await tick(800);
  assert.deepEqual(ids(controller.doc), ["a", "remote", "later"]);
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

test("after taking in another window's canvas, undo cannot remove what that window added", async () => {
  await mount();
  await act(async () => controller.change(moveTo("a", 10)));
  saveReplies.push(() => ({ ok: false, reason: "conflict", doc: canvas(5, note("a"), note("c", 900)) }));
  await tick(800);
  assert.deepEqual(ids(controller.doc), ["a", "c"]);

  await act(async () => controller.undo());
  assert.deepEqual(ids(controller.doc), ["a", "c"]);
  await tick(800);
  assert.deepEqual(ids(stored), ["a", "c"]);
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
    emitBotTestNotification("designCanvas:updated", { chatId: "chat-1", revision: base + 2 });
    return { ok: true, revision: base + 1 };
  });
  await act(async () => controller.change(moveTo("a", 10)));
  await tick(800);
  await settle();
  assert.deepEqual(ids(controller.doc), ["a", "remote"]);
  assert.equal(xOf(controller.doc, "a"), 10);
});
