import assert from "node:assert/strict";
import test from "node:test";
import { createChatStore } from "./chat-store-core.js";
import {
  APPEND_RECONCILIATION_REQUIRED,
  AppendReconciliationRequiredError,
  appendChatMessageWithReconciliation,
} from "./chat-append-commit.js";
import { temporaryDirectory } from "../shared/temp-dir-test-support.js";

test("a post-install store rejection reconciles as one committed renderer send", async (t) => {
  const directory = await temporaryDirectory(t, "aiden-append-reconcile-");
  let rejectDirectorySyncAt: number | undefined;
  let directorySyncs = 0;
  const store = createChatStore(async () => directory, undefined, {
    syncFile: async () => undefined,
    syncDirectory: async () => {
      directorySyncs += 1;
      if (directorySyncs === rejectDirectorySyncAt) {
        throw new Error("injected post-rename directory sync failure");
      }
    },
  });
  const chat = await store.create({ title: "Reconcile append" });
  const messageId = "main-minted-message";

  rejectDirectorySyncAt = directorySyncs + 2;
  const recovered = await appendChatMessageWithReconciliation({
    messageId,
    append: () =>
      store.appendMessage(chat.id, {
        id: messageId,
        role: "user",
        content: "send exactly once",
        skill: { version: 1, name: "Review", source: "global" },
      }),
    recover: () => store.get(chat.id),
  });

  assert.deepEqual(
    recovered.messages.map((message) => message.id),
    [messageId],
  );
  assert.equal(recovered.messages[0]?.skill?.name, "Review");
  assert.equal((await store.get(chat.id))?.messages.length, 1);
});

test("definitely absent and indeterminate appends remain distinct", async () => {
  const original = new Error("append failed before install");
  await assert.rejects(
    appendChatMessageWithReconciliation({
      messageId: "not-installed",
      append: async () => {
        throw original;
      },
      recover: async () => null,
    }),
    (error: unknown) => error === original,
  );
  await assert.rejects(
    appendChatMessageWithReconciliation({
      messageId: "unknown",
      append: async () => {
        throw original;
      },
      recover: async () => {
        throw new Error("disk unavailable");
      },
    }),
    (error: unknown) =>
      error instanceof AppendReconciliationRequiredError &&
      error.message.includes(APPEND_RECONCILIATION_REQUIRED),
  );
});
