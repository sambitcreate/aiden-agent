// Which chats count as live on a workspace's canvas.

import assert from "node:assert/strict";
import test from "node:test";
import { createDesignLiveChats } from "./liveness.js";

test("which chats are live takes one index read for any number of chats; a gone chat or one in another workspace is not live", async () => {
  let reads = 0;
  const liveChats = createDesignLiveChats({
    list: async (workspaceId?: string) => {
      reads += 1;
      const all = [
        { id: "chat-1", workspaceId: "ws-1" },
        { id: "chat-2", workspaceId: "ws-2" },
        { id: "chat-3", workspaceId: "ws-1" },
      ];
      return all.filter((meta) => workspaceId === undefined || meta.workspaceId === workspaceId);
    },
  });
  assert.deepEqual([...(await liveChats(["chat-1", "chat-2", "chat-3", "chat-gone"], "ws-1"))].sort(), ["chat-1", "chat-3"]);
  assert.equal(reads, 1);
  assert.deepEqual([...(await liveChats([], "ws-1"))], []);
  assert.equal(reads, 1, "nothing to check reads nothing");
});
