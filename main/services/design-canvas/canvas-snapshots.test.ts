import assert from "node:assert/strict";
import test from "node:test";
import type { ChatGenerationOwner } from "../chat-generation-owner.js";
import { DesignCanvasSnapshots } from "./canvas-snapshots.js";

function windowOwner(id = 3, documentId = "doc") {
  const sent: { channel: string; payload: { requestId: string; chatId: string } }[] = [];
  const owner: ChatGenerationOwner = {
    id,
    documentId,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload: payload as { requestId: string; chatId: string } }),
    onInvalidated: () => () => undefined,
  };
  return { owner, sent };
}

const PNG = "data:image/png;base64,iVBORw0KGgo=";

test("the window that owns the reply answers with a PNG of its canvas", async () => {
  const snapshots = new DesignCanvasSnapshots();
  const window = windowOwner();
  const pending = snapshots.request({ chatId: "chat-1", owner: window.owner });
  assert.equal(window.sent[0]?.channel, "designCanvas:snapshot");
  assert.equal(window.sent[0]?.payload.chatId, "chat-1");
  const id = window.sent[0]!.payload.requestId;
  assert.equal(snapshots.answer(id, PNG, windowOwner(4).owner), false, "another window cannot answer");
  assert.equal(snapshots.answer(id, PNG, window.owner), true);
  assert.deepEqual(await pending, { data: "iVBORw0KGgo=", mimeType: "image/png" });
});

test("anything but a PNG data URL, an off-screen canvas or no answer gives no picture", async () => {
  const snapshots = new DesignCanvasSnapshots(10);
  for (const answer of [null, "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,not base64!", "https://example.com/x.png"]) {
    const window = windowOwner();
    const pending = snapshots.request({ chatId: "chat-1", owner: window.owner });
    snapshots.answer(window.sent[0]!.payload.requestId, answer, window.owner);
    assert.equal(await pending, null, String(answer));
  }
  assert.equal(await snapshots.request({ chatId: "chat-1", owner: windowOwner().owner }), null, "timed out");
  assert.equal(await snapshots.request({ chatId: "chat-1", owner: { ...windowOwner().owner, kind: "remote" } }), null);
});
