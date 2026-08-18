import assert from "node:assert/strict";
import test from "node:test";
import { parseBotChatCreate, parseBotCreate, parseBotUpdate } from "./bot-params.js";

test("bot mutation and conversation envelopes are exact and bounded", () => {
  const fields = { name: "Reviewer", description: "Checks work", instructions: "Be precise.", avatar: "prism" as const };
  assert.deepEqual(parseBotCreate(fields), fields);
  assert.deepEqual(parseBotUpdate({ id: "bot-1", ...fields }), { id: "bot-1", ...fields });
  assert.deepEqual(parseBotChatCreate({ botId: "bot-1", workspaceId: "workspace-1" }), {
    botId: "bot-1", workspaceId: "workspace-1", providerId: undefined, model: undefined,
  });
  assert.throws(() => parseBotCreate({ ...fields, systemPrompt: "forged" }), /Invalid bot creation fields/u);
  assert.throws(
    () => parseBotChatCreate({ botId: "bot-1", workspaceId: "workspace-1", instructions: "forged" }),
    /Invalid bot chat creation fields/u,
  );
});
