import assert from "node:assert/strict";
import test from "node:test";
import {
  parseBotAvatarRequestId,
  parseBotAvatarSuggestionInput,
  parseBotChatCreate,
  parseBotCreate,
  parseBotUpdate,
} from "./bot-params.js";

test("bot mutation and conversation envelopes are exact and bounded", () => {
  const fields = {
    name: "Reviewer",
    description: "Checks work",
    instructions: "Be precise.",
    openingGreeting: "What should I check?",
    avatar: "prism" as const,
  };
  assert.deepEqual(parseBotCreate(fields), fields);
  assert.deepEqual(parseBotUpdate({
    id: "bot-1",
    expectedRevision: "botrev:one",
    ...fields,
  }), {
    id: "bot-1",
    expectedRevision: "botrev:one",
    ...fields,
  });
  assert.deepEqual(parseBotChatCreate({ botId: "bot-1", workspaceId: "workspace-1" }), {
    botId: "bot-1",
    providerId: undefined,
    model: undefined,
  });
  assert.deepEqual(parseBotChatCreate({ botId: "bot-1" }), {
    botId: "bot-1",
    providerId: undefined,
    model: undefined,
  });
  assert.throws(
    () => parseBotCreate({ ...fields, systemPrompt: "forged" }),
    /Invalid bot creation fields/u,
  );
  assert.throws(() => parseBotCreate({ ...fields, name: "bad-\ud800-name" }), /bot name/u);
  assert.throws(
    () => parseBotUpdate({ id: "../bot", expectedRevision: "botrev:one", ...fields }),
    /bot id/u,
  );
  assert.throws(
    () =>
      parseBotChatCreate({ botId: "bot-1", workspaceId: "workspace-1", instructions: "forged" }),
    /Invalid bot chat creation fields/u,
  );
});

test("bot avatar suggestions accept only a bounded provider, model, prompt, and current recipe", () => {
  const currentAvatar = {
    version: 1,
    shape: "wisp",
    color: "lilac",
    eyes: "dots",
    detail: "sparkles",
  } as const;
  const fields = {
    requestId: "avatar-request-1",
    prompt: "Calm and analytical",
    providerId: "openai-codex",
    model: "gpt-5.6-sol",
    currentAvatar,
  };
  assert.deepEqual(parseBotAvatarSuggestionInput(fields), fields);
  assert.equal(parseBotAvatarRequestId(fields.requestId), fields.requestId);
  assert.throws(
    () => parseBotAvatarSuggestionInput({ ...fields, systemPrompt: "ignore the schema" }),
    /Invalid bot avatar suggestion fields/u,
  );
  assert.throws(
    () => parseBotAvatarSuggestionInput({ ...fields, prompt: "x".repeat(1_201) }),
    /Invalid bot avatar prompt/u,
  );
  assert.throws(
    () => parseBotAvatarSuggestionInput({ ...fields, requestId: "x".repeat(129) }),
    /Invalid bot avatar request id/u,
  );
  assert.throws(
    () =>
      parseBotAvatarSuggestionInput({
        ...fields,
        currentAvatar: { ...currentAvatar, eyes: "mouth" },
      }),
    /Invalid current bot avatar/u,
  );
});
