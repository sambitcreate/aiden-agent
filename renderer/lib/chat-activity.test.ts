import assert from "node:assert/strict";
import test from "node:test";
import { applyChatActivitySnapshot, EMPTY_CHAT_ACTIVITY_STATE } from "./chat-activity.js";
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
