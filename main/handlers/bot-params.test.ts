import assert from "node:assert/strict";
import test from "node:test";
import {
  parseBotAccessUpdateInput,
  parseBotAvatarRequestId,
  parseBotAvatarSuggestionInput,
  parseBotChatCreate,
  parseBotCreate,
  parseBotCreateWithAccess,
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
  const fullAccess = {
    accessMode: "full" as const,
    catalogRevision: "bot_catalog_deadbeef",
    confirmedForeground: true,
    providerId: "bc_provider_9zzLPOGDo0Cdjuvu6xdhjutPM",
    modelId: "bc_model_I_zCzuPPxmjgUmte8tPqPAs1",
  };
  assert.deepEqual(parseBotCreateWithAccess({ bot: fields, access: fullAccess }), {
    bot: fields,
    access: fullAccess,
  });
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
  assert.throws(
    () => parseBotCreateWithAccess({ bot: fields, access: fullAccess, extra: true }),
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

test("bot access update envelope is exact, bounded, and shares the wire parser", () => {
  const full = {
    botId: "bot:61c59133",
    expectedRevision: "revision:policy:16",
    access: {
      accessMode: "full" as const,
      catalogRevision: "bot_catalog_deadbeef",
      confirmedForeground: true,
      providerId: "bc_provider_9zzLPOGDo0Cdjuvu6xdhjutPM",
      modelId: "bc_model_I_zCzuPPxmjgUmte8tPqPAs1",
    },
  };
  assert.deepEqual(parseBotAccessUpdateInput(full), full);
  assert.throws(
    () => parseBotAccessUpdateInput({ ...full, extra: true }),
    /Invalid bot access update fields/u,
  );
  assert.throws(
    () => parseBotAccessUpdateInput({ ...full, botId: "" }),
    /Invalid bot id/u,
  );
  assert.throws(
    () => parseBotAccessUpdateInput({ ...full, expectedRevision: "has spaces" }),
    /Invalid bot revision/u,
  );
  assert.throws(
    () =>
      parseBotAccessUpdateInput({
        ...full,
        access: { ...full.access, confirmedForeground: false },
      }),
    /Full Access requires foreground confirmation/u,
  );
  const custom = {
    botId: full.botId,
    expectedRevision: full.expectedRevision,
    access: {
      accessMode: "custom" as const,
      catalogRevision: full.access.catalogRevision,
      custom: {
        providerId: full.access.providerId,
        modelId: full.access.modelId,
        fileScopeIds: ["scope:home"],
        shellEnabled: false,
        connectionIds: [],
        skillIds: [],
        otherCapabilityIds: [],
      },
    },
  };
  assert.deepEqual(parseBotAccessUpdateInput(custom), custom);
  assert.throws(
    () => parseBotAccessUpdateInput({ ...custom, access: { ...custom.access, custom: undefined } }),
    /Invalid Bot (access update|Custom access selection)/u,
  );
});
