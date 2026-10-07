import assert from "node:assert/strict";
import test from "node:test";
import {
  parseBotAccessUpdateInput,
  parseBotApprovalDecision,
  parseBotAvatarRequestId,
  parseBotAvatarSuggestionInput,
  parseBotChatCreate,
  parseBotCreate,
  parseBotCreateWithAccess,
  parseBotSend,
  parseBotSessionAction,
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

test("Resume and Dismiss take an exact Bot id and a bounded request id", () => {
  assert.deepEqual(parseBotSessionAction({ botId: "bot:1", requestId: "desk-7f3a" }, "resume"), {
    botId: "bot:1",
    requestId: "desk-7f3a",
  });
  assert.throws(() => parseBotSessionAction({ botId: "bot:1" }, "resume"), /request id/u);
  assert.throws(() => parseBotSessionAction({ botId: "bot:1", requestId: "" }, "dismiss"), /request id/u);
  assert.throws(() => parseBotSessionAction({ botId: "bot:1", requestId: "a b" }, "dismiss"), /request id/u);
  assert.throws(() => parseBotSessionAction({ botId: "bot:1", requestId: "x".repeat(201) }, "resume"), /request id/u);
  assert.throws(() => parseBotSessionAction({ botId: "../x", requestId: "r" }, "resume"), /bot id/u);
  assert.throws(() => parseBotSessionAction({ botId: "bot:1", requestId: "r", extra: true }, "resume"), /fields/u);
  assert.throws(() => parseBotSessionAction(null, "dismiss"), /fields/u);
});

test("a desktop Bot message carries text or images and its send UUID as request id", () => {
  assert.deepEqual(parseBotSend({ botId: "bot:1", text: "hi", requestId: "8f1c" }), {
    botId: "bot:1",
    text: "hi",
    requestId: "8f1c",
  });
  assert.deepEqual(
    parseBotSend({
      botId: "bot:1",
      text: "",
      requestId: "r",
      whenBusy: "steer",
      attachments: [{ type: "image", mimeType: "image/png", data: "iVBOR" }],
    }),
    {
      botId: "bot:1",
      text: "",
      requestId: "r",
      whenBusy: "steer",
      attachments: [{ type: "image", mimeType: "image/png", data: "iVBOR" }],
    },
  );
  assert.throws(() => parseBotSend({ botId: "bot:1", text: "  ", requestId: "r" }), /text or an image/u);
  assert.throws(() => parseBotSend({ botId: "bot:1", text: "hi" }), /request id/u);
  assert.throws(() => parseBotSend({ botId: "bot:1", text: "hi", requestId: "r", whenBusy: "now" }), /busy/u);
  assert.throws(
    () =>
      parseBotSend({
        botId: "bot:1",
        text: "hi",
        requestId: "r",
        attachments: [{ type: "image", mimeType: "application/pdf", data: "x" }],
      }),
    /attachments/u,
  );
  assert.throws(() => parseBotSend({ botId: "bot:1", text: "hi", requestId: "r", providerId: "x" }), /fields/u);
});

test("a Bot approval answer names its waitId and allow or deny, nothing else", () => {
  const waitId = "3f1c2b9a-7d4e-4a1b-9c2d-5e6f7a8b9c0d";
  assert.deepEqual(parseBotApprovalDecision({ waitId, decision: "allow" }), { waitId, decision: "allow" });
  assert.deepEqual(parseBotApprovalDecision({ waitId, decision: "deny" }), { waitId, decision: "deny" });
  assert.throws(() => parseBotApprovalDecision({ waitId, decision: "always" }), /decision/u);
  assert.throws(() => parseBotApprovalDecision({ waitId: "a/b", decision: "allow" }), /approval id/u);
  assert.throws(() => parseBotApprovalDecision({ waitId: "x".repeat(65), decision: "allow" }), /approval id/u);
  assert.throws(() => parseBotApprovalDecision({ waitId, decision: "allow", scope: "always" }), /fields/u);
  assert.throws(() => parseBotApprovalDecision(null), /fields/u);
});
