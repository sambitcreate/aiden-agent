import assert from "node:assert/strict";
import test from "node:test";
import type { RendererDocumentOwner } from "../services/renderer-document-owner.js";
import type { Chat } from "../services/types.js";
import { applyComputerUseSettingChange } from "./chat-computer-use-setting.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

const owner: RendererDocumentOwner = {
  id: 1,
  documentId: "1:1:computer-use-setting",
  isDestroyed: () => false,
  send: () => undefined,
  onInvalidated: () => () => undefined,
};

test("disable closes the exact Live authority before a deferred setting write can yield", async () => {
  const write = deferred<Chat>();
  const order: string[] = [];
  let actionExecutions = 0;
  const changing = applyComputerUseSettingChange(owner, "assistant-chat", false, {
    begin: () => {
      order.push("begin");
      return () => order.push("release");
    },
    status: async () => {
      throw new Error("disable must not query readiness");
    },
    persist: async () => {
      order.push("persist");
      return write.promise;
    },
    revokeLive: (chatId) => {
      assert.equal(chatId, "assistant-chat");
      order.push("live-close");
    },
  });

  assert.deepEqual(order, ["live-close", "begin", "persist"]);
  if (!order.includes("live-close")) actionExecutions += 1;
  assert.equal(actionExecutions, 0, "no action may execute after disable intent");

  write.resolve({ id: "assistant-chat", computerUseEnabled: false } as Chat);
  const updated = await changing;
  assert.equal(updated.computerUseEnabled, false);
  assert.deepEqual(order, ["live-close", "begin", "persist", "release"]);
});

test("a rejected setting write cannot restore the synchronously revoked Live authority", async () => {
  const order: string[] = [];
  const failure = new Error("STORE_FAILURE_SENTINEL");
  await assert.rejects(
    applyComputerUseSettingChange(owner, "assistant-chat", false, {
      begin: () => {
        order.push("begin");
        return () => order.push("release");
      },
      status: async () => {
        throw new Error("disable must not query readiness");
      },
      persist: async () => {
        order.push("persist");
        throw failure;
      },
      revokeLive: () => order.push("live-close"),
    }),
    failure,
  );
  assert.deepEqual(order, ["live-close", "begin", "persist", "release"]);
});
