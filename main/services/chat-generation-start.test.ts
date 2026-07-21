import assert from "node:assert/strict";
import test from "node:test";
import { startGenerationAndMaybeTitle } from "./chat-generation-start.js";
import type { ChatStartParams } from "./types.js";

const params: ChatStartParams = {
  chatId: "chat-1",
  workspaceId: "workspace-1",
  providerId: "openai-codex",
  model: "gpt-5.4",
  messages: [{ role: "user", content: "Help me" }],
};

test("does not start title generation when chat initialization was cancelled", async () => {
  let titleStarts = 0;
  const started = await startGenerationAndMaybeTitle(
    {
      start: async () => false,
      startTitle: () => {
        titleStarts += 1;
      },
    },
    "stream-1",
    params,
  );

  assert.equal(started, false);
  assert.equal(titleStarts, 0);
});

test("starts one title request only after chat initialization succeeds", async () => {
  const titleInputs: Array<{ chatId: string; providerId: string; model: string }> = [];
  const started = await startGenerationAndMaybeTitle(
    {
      start: async () => true,
      startTitle: (input) => titleInputs.push(input),
    },
    "stream-1",
    params,
  );

  assert.equal(started, true);
  assert.deepEqual(titleInputs, [
    { chatId: "chat-1", providerId: "openai-codex", model: "gpt-5.4" },
  ]);
});
