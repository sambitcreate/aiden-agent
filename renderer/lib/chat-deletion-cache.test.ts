import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { isChatCacheDeleted, removeDeletedChatFromCache } from "./chat-deletion-cache.js";
import { queryKeys } from "./queries.js";
import { chatMessageQueue } from "./chat-message-queue.js";

test("successful deletion removes the exact transcript and tombstones late terminal delivery", async () => {
  const queryClient = new QueryClient();
  const deletedKey = queryKeys.chat("deleted-chat");
  const retainedKey = queryKeys.chat("retained-chat");
  queryClient.setQueryData(deletedKey, { id: "deleted-chat", messages: ["stale"] });
  queryClient.setQueryData(retainedKey, { id: "retained-chat", messages: ["keep"] });
  const queue = chatMessageQueue("deleted-chat");
  queue.add({ id: "queued", text: "unsent", attachments: [] });

  await removeDeletedChatFromCache(queryClient, "deleted-chat");
  assert.deepEqual(queue.getSnapshot().messages, []);
  assert.equal(queue.getSnapshot().paused, true);

  assert.equal(queryClient.getQueryData(deletedKey), undefined);
  assert.deepEqual(queryClient.getQueryData(retainedKey), {
    id: "retained-chat",
    messages: ["keep"],
  });
  assert.equal(isChatCacheDeleted("deleted-chat"), true);
  assert.equal(isChatCacheDeleted("retained-chat"), false);

  const queuedTerminal = { id: "deleted-chat", messages: ["late assistant"] };
  if (!isChatCacheDeleted(queuedTerminal.id)) {
    queryClient.setQueryData(queryKeys.chat(queuedTerminal.id), queuedTerminal);
  }
  assert.equal(queryClient.getQueryData(deletedKey), undefined);
  queryClient.clear();
});

test("deletion cancellation prevents an older in-flight read from reinstalling the chat", async () => {
  const queryClient = new QueryClient();
  let resolveRead: ((value: { id: string }) => void) | undefined;
  const read = queryClient.fetchQuery({
    queryKey: queryKeys.chat("in-flight-chat"),
    queryFn: () =>
      new Promise<{ id: string }>((resolve) => {
        resolveRead = resolve;
      }),
  });

  await Promise.resolve();
  await removeDeletedChatFromCache(queryClient, "in-flight-chat");
  resolveRead?.({ id: "in-flight-chat" });
  await assert.rejects(read);
  assert.equal(queryClient.getQueryData(queryKeys.chat("in-flight-chat")), undefined);
  queryClient.clear();
});
