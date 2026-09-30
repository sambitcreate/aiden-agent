import assert from "node:assert/strict";
import test from "node:test";
import { applyChatActivitySnapshot, chatRowStateFor, EMPTY_CHAT_ACTIVITY_STATE } from "./chat-activity.js";
import { applyChatReadMarkersSnapshot } from "./chat-read-markers.js";
import { parseChatActivitySnapshot } from "../shared/chat-activity.js";

test("chat activity snapshots are validated and deduplicated without dropping active chats", () => {
  assert.deepEqual(
    parseChatActivitySnapshot({
      revision: 4,
      activeChatIds: ["chat-a", "chat-a", "chat-b"],
    }),
    { revision: 4, activeChatIds: ["chat-a", "chat-b"] },
  );

  for (const value of [
    null,
    {},
    { revision: -1, activeChatIds: [] },
    { revision: 1.5, activeChatIds: [] },
    { revision: 1, activeChatIds: ["/private/chat"] },
  ]) {
    assert.equal(parseChatActivitySnapshot(value), null);
  }

  const activeChatIds = Array.from({ length: 257 }, (_, index) => `chat-${index}`);
  assert.deepEqual(parseChatActivitySnapshot({ revision: 5, activeChatIds }), {
    revision: 5,
    activeChatIds,
  });
});

test("late activity snapshots cannot overwrite newer sidebar state", () => {
  const newer = applyChatActivitySnapshot(EMPTY_CHAT_ACTIVITY_STATE, {
    revision: 3,
    activeChatIds: ["chat-new"],
  });
  const stale = applyChatActivitySnapshot(newer, {
    revision: 2,
    activeChatIds: ["chat-old"],
  });
  assert.equal(stale, newer);
  assert.deepEqual([...stale.activeChatIds], ["chat-new"]);

  const settled = applyChatActivitySnapshot(newer, {
    revision: 4,
    activeChatIds: [],
  });
  assert.deepEqual([...settled.activeChatIds], []);
});

test("attention snapshots drive row state with approval ahead of input and work", () => {
  const snapshot = parseChatActivitySnapshot({
    revision: 7,
    activeChatIds: ["both", "asking", "busy"],
    approvalChatIds: ["both", "both"],
    inputChatIds: ["both", "asking"],
  });
  assert.ok(snapshot);
  assert.deepEqual(snapshot.approvalChatIds, ["both"]);
  const state = applyChatActivitySnapshot(EMPTY_CHAT_ACTIVITY_STATE, snapshot);
  assert.equal(chatRowStateFor(state, "both"), "needs_approval");
  assert.equal(chatRowStateFor(state, "asking"), "needs_input");
  assert.equal(chatRowStateFor(state, "busy"), "working");
  assert.equal(chatRowStateFor(state, "quiet"), "idle");
  assert.equal(chatRowStateFor(state, "quiet", true), "working");

  const cleared = applyChatActivitySnapshot(state, { revision: 8, activeChatIds: ["both"] });
  assert.equal(chatRowStateFor(cleared, "both"), "working");
  assert.equal(chatRowStateFor(cleared, "asking"), "idle");
});

test("activity snapshots with malformed attention ids are rejected whole", () => {
  assert.equal(
    parseChatActivitySnapshot({ revision: 1, activeChatIds: [], approvalChatIds: ["../x"] }),
    null,
  );
  assert.equal(
    parseChatActivitySnapshot({ revision: 1, activeChatIds: [], inputChatIds: "chat-a" }),
    null,
  );
  assert.deepEqual(
    parseChatActivitySnapshot({ revision: 1, activeChatIds: [], inputChatIds: [] }),
    { revision: 1, activeChatIds: [] },
  );
});

test("a late read-marker snapshot cannot resurrect an unread dot", () => {
  const newer = { revision: 5, baselineAt: 10, readThrough: { a: 200 } };
  const older = { revision: 4, baselineAt: 10, readThrough: {} };
  assert.equal(applyChatReadMarkersSnapshot(newer, older), newer);
  assert.equal(applyChatReadMarkersSnapshot(null, older), older);
});
