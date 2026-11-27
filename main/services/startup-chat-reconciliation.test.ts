import assert from "node:assert/strict";
import test from "node:test";
import { createChatStore } from "./chat-store-core.js";
import { reconcileChatScopedStores } from "./startup-chat-reconciliation.js";
import { temporaryDirectory } from "../shared/temp-dir-test-support.js";

test("hidden feature chats stay in the startup reconciliation set", async (t) => {
  const directory = await temporaryDirectory(t, "aiden-startup-reconcile-");
  const store = createChatStore(async () => directory);
  const regular = await store.create({ workspaceId: "default" });
  const bot = await store.create({ workspaceId: "default", botId: "bot-1" });
  const owned = await store.create({ owner: { kind: "design-project", projectId: "project-1" } });

  const seen: string[][] = [];
  const recorder = {
    reconcileChats: async (ids: ReadonlySet<string>) => {
      seen.push([...ids].sort());
    },
  };
  const ids = await reconcileChatScopedStores(createChatStore(async () => directory), [recorder, recorder]);

  const expected = [regular.id, bot.id, owned.id].sort();
  assert.deepEqual([...ids].sort(), expected);
  // Every chat-scoped store (effects, compaction sessions) keeps state for hidden chats.
  assert.deepEqual(seen, [expected, expected]);
});
