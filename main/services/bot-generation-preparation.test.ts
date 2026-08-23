import assert from "node:assert/strict";
import test from "node:test";
import {
  assertExactBotProviderDispatch,
  prepareBotGeneration,
} from "./bot-generation-preparation.js";

const bot = {
  id: "bot-1",
  revision: "botrev:bot-1",
  name: "Researcher",
  instructions: "Be careful.",
  avatar: "prism" as const,
  createdAt: 1,
  updatedAt: 2,
};

const workspace = {
  botId: bot.id,
  workspaceId: "8604cafe-0648-4b86-bdaa-fc6f27cc4781",
  homePath: "/private/aiden/bots/home-8604cafe-0648-4b86-bdaa-fc6f27cc4781",
  createdAt: 3,
  incarnation: { device: "4", inode: "5" },
};

const chat = {
  botId: bot.id,
  workspaceId: workspace.workspaceId,
  providerId: "provider-1",
  model: "model-1",
};

test("provider dispatch preserves both the admitted connection identity and model", () => {
  const expected = { provider: "provider-1", model: "model-1" };
  assert.doesNotThrow(() => assertExactBotProviderDispatch(expected, expected));
  assert.throws(
    () => assertExactBotProviderDispatch(expected, { ...expected, provider: "provider-2" }),
    /AI connection or model changed/u,
  );
  assert.throws(
    () => assertExactBotProviderDispatch(expected, { ...expected, model: "model-2" }),
    /AI connection or model changed/u,
  );
});

function fixture(
  overrides: Partial<Parameters<typeof prepareBotGeneration>[0]> = {},
) {
  const calls: string[] = [];
  return {
    calls,
    input: {
      chat,
      bot,
      requested: {
        workspaceId: workspace.workspaceId,
        providerId: chat.providerId,
        model: chat.model,
      },
      resolveManagedWorkspace: async (botId: string) => {
        calls.push(`workspace:${botId}`);
        return workspace;
      },
      resolveRuntime: async (providerId: string, model: string) => {
        calls.push(`runtime:${providerId}/${model}`);
        return { provider: { id: providerId }, model: { id: model }, marker: "exact" };
      },
      ...overrides,
    },
  };
}

test("prepares an exact main-only managed-home workspace and persisted runtime", async () => {
  const { input, calls } = fixture();
  const prepared = await prepareBotGeneration(input);
  assert.deepEqual(calls, ["workspace:bot-1", "runtime:provider-1/model-1"]);
  assert.equal(prepared.managedWorkspace, workspace);
  assert.deepEqual(prepared.workspace, {
    id: workspace.workspaceId,
    name: bot.name,
    folderPath: workspace.homePath,
    permission: "full",
    createdAt: workspace.createdAt,
    updatedAt: workspace.createdAt,
  });
  assert.equal(prepared.providerId, chat.providerId);
  assert.equal(prepared.model, chat.model);
  assert.equal("marker" in prepared.runtime && prepared.runtime.marker, "exact");
  assert.equal("managedWorktree" in prepared.workspace, false);
});

test("fails before effects when renderer provider/model differs from persisted selection", async () => {
  const provider = fixture({
    requested: { ...fixture().input.requested, providerId: "renderer-override" },
  });
  await assert.rejects(prepareBotGeneration(provider.input), /saved AI connection changed/u);
  assert.deepEqual(provider.calls, []);

  const model = fixture({
    requested: { ...fixture().input.requested, model: "renderer-override" },
  });
  await assert.rejects(prepareBotGeneration(model.input), /saved AI connection changed/u);
  assert.deepEqual(model.calls, []);
});

test("requires a complete persisted provider/model pair without fallback", async () => {
  for (const incomplete of [
    { ...chat, providerId: undefined },
    { ...chat, model: undefined },
  ]) {
    const candidate = fixture({ chat: incomplete });
    await assert.rejects(prepareBotGeneration(candidate.input), /exact AI connection and model/u);
    assert.deepEqual(candidate.calls, []);
  }
});

test("rejects managed-home identity, requested workspace drift, and unsafe-path drift", async () => {
  const cases = [
    { chat: { ...chat, botId: "bot-2" } },
    { requested: { ...fixture().input.requested, workspaceId: "different" } },
    {
      resolveManagedWorkspace: async () => ({ ...workspace, botId: "bot-2" }),
    },
    {
      resolveManagedWorkspace: async () => ({ ...workspace, homePath: "relative/home" }),
    },
  ];
  for (const overrides of cases) {
    const candidate = fixture(overrides);
    await assert.rejects(
      prepareBotGeneration(candidate.input),
      /persisted workspace identity|managed home workspace is unavailable/u,
    );
    assert.equal(candidate.calls.some((call) => call.startsWith("runtime:")), false);
  }
});

test("legacy visible-workspace chats execute from the verified managed home", async () => {
  const legacyWorkspaceId = "legacy-visible-workspace";
  const candidate = fixture({
    chat: { ...chat, workspaceId: legacyWorkspaceId },
    requested: {
      workspaceId: legacyWorkspaceId,
      providerId: chat.providerId,
      model: chat.model,
    },
  });
  const prepared = await prepareBotGeneration(candidate.input);
  assert.equal(prepared.workspace.id, workspace.workspaceId);
  assert.equal(prepared.workspace.folderPath, workspace.homePath);
});

test("rejects a runtime that aliases or falls back from the persisted pair", async () => {
  const provider = fixture({
    resolveRuntime: async () => ({
      provider: { id: "fallback-provider" },
      model: { id: chat.model },
    }),
  });
  await assert.rejects(prepareBotGeneration(provider.input), /no longer resolves exactly/u);

  const model = fixture({
    resolveRuntime: async () => ({
      provider: { id: chat.providerId },
      model: { id: "fallback-model" },
    }),
  });
  await assert.rejects(prepareBotGeneration(model.input), /no longer resolves exactly/u);
});

test("propagates unavailable-provider errors and honors cancellation boundaries", async () => {
  const unavailable = fixture({
    resolveRuntime: async () => {
      throw new Error("Provider is unavailable.");
    },
  });
  await assert.rejects(prepareBotGeneration(unavailable.input), /Provider is unavailable/u);

  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const cancelled = fixture({ signal: controller.signal });
  await assert.rejects(prepareBotGeneration(cancelled.input), /cancelled/u);
  assert.deepEqual(cancelled.calls, []);
});
