import assert from "node:assert/strict";
import test from "node:test";
import type { ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import { createDesignDirectEditMessagePort } from "./design-direct-edit-message-port.js";

const artifact: ChatHtmlArtifactV1 = {
  version: 1,
  kind: "html",
  id: "a".repeat(64),
  title: "Checkout",
  mimeType: "text/html",
  size: 10,
  mediaId: `design:${"b".repeat(64)}`,
};

test("the production chat adapter appends a direct-edit artifact exactly once", async () => {
  const messages: Array<{ role: string; content: string; htmlArtifacts?: ChatHtmlArtifactV1[] }> =
    [];
  const port = createDesignDirectEditMessagePort({
    async get() {
      return { messages } as never;
    },
    async appendMessage(_chatId, message) {
      messages.push(message as (typeof messages)[number]);
      return {} as never;
    },
  });
  await port.ensureArtifactMessage({ chatId: "chat:one", artifact, createdAt: 10 });
  await port.ensureArtifactMessage({ chatId: "chat:one", artifact, createdAt: 11 });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]?.htmlArtifacts, [artifact]);
});

test("the production chat adapter rejects a conflicting deterministic media identity", async () => {
  const port = createDesignDirectEditMessagePort({
    async get() {
      return {
        messages: [
          {
            role: "assistant",
            content: "",
            htmlArtifacts: [{ ...artifact, id: "c".repeat(64) }],
          },
        ],
      } as never;
    },
    async appendMessage() {
      assert.fail("a conflicting artifact must not be appended");
    },
  });
  await assert.rejects(
    port.ensureArtifactMessage({ chatId: "chat:one", artifact, createdAt: 10 }),
    /conflicts/iu,
  );
});
