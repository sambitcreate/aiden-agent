import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { rendererDocumentOwner, windowDocumentOwner } from "./renderer-document-owner.js";

/** A main frame as Electron reports it: its identity changes when its document is replaced across processes. */
function mainFrame(processId: number, routingId: number, frameToken: string) {
  return { processId, routingId, frameToken, detached: false, parent: null, isDestroyed: () => false, send: () => undefined };
}

/** A window's web contents: navigation and destruction are events, the main frame can be swapped. */
function windowContents(id: number) {
  const emitter = new EventEmitter();
  let destroyed = false;
  const contents = Object.assign(emitter, {
    id,
    mainFrame: mainFrame(7, 1, "first"),
    isDestroyed: () => destroyed,
    destroy() {
      destroyed = true;
      emitter.emit("destroyed");
    },
  });
  return contents;
}

type Contents = ReturnType<typeof windowContents>;
const asWebContents = (contents: Contents) => contents as unknown as Electron.WebContents;

/** The owner an IPC request from the window's main frame captures. */
function requestOwner(contents: Contents) {
  const frame = contents.mainFrame;
  const event = { sender: contents, senderFrame: frame, processId: frame.processId, frameId: frame.routingId };
  return rendererDocumentOwner(event as unknown as Electron.IpcMainInvokeEvent, () => new Error("not the active document"));
}

test("a window's document, minted in main, is the same owner its own requests name", () => {
  const contents = windowContents(4);
  const minted = windowDocumentOwner(asWebContents(contents));
  const requested = requestOwner(contents);
  // The Bot panel's later read from this window finds the owner it already has.
  assert.equal(minted.id, requested.id);
  assert.equal(minted.documentId, requested.documentId);
  assert.equal(minted.isDestroyed(), false);
});

test("a minted owner goes stale when its window navigates, swaps its main frame or closes", () => {
  const navigated = windowContents(1);
  const before = windowDocumentOwner(asWebContents(navigated));
  let invalidated = 0;
  before.onInvalidated(() => {
    invalidated += 1;
  });
  navigated.emit("did-navigate");
  assert.equal(before.isDestroyed(), true);
  assert.equal(invalidated, 1);
  assert.throws(() => before.send("browser:event" as never, {}), /no longer active/u);
  assert.equal(windowDocumentOwner(asWebContents(navigated)).isDestroyed(), false, "the new document can own it again");

  const swapped = windowContents(2);
  const old = windowDocumentOwner(asWebContents(swapped));
  swapped.mainFrame = mainFrame(9, 3, "second");
  assert.equal(old.isDestroyed(), true);
  assert.notEqual(windowDocumentOwner(asWebContents(swapped)).documentId, old.documentId);

  const closed = windowContents(3);
  const last = windowDocumentOwner(asWebContents(closed));
  closed.destroy();
  assert.equal(last.isDestroyed(), true);
  assert.throws(() => windowDocumentOwner(asWebContents(closed)), /no longer active/u);
});
