import assert from "node:assert/strict";
import test from "node:test";
import { AidenRemoteChatService } from "./aiden-remote-chats.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import { FakeHost, FEATURES, UNHANDLED, setup } from "./peer-remote-chat-test-host.js";
import { remoteHostCapabilities } from "../../renderer/lib/hosts/remote-host-adapter.js";
import type { Chat } from "../../renderer/lib/types.js";

/**
 * The composer context meter for a chat on a paired Mac, end to end: the
 * renderer adapter, main's real live IPC handlers, operation builder and
 * contract check, and the host's real chat service. The host's projection is
 * a stand-in shaped like the desktop's own `chatContextPressure`, with the
 * breakdown and prompt cache the wire must never carry.
 */

const CONTEXT_FEATURES = [...FEATURES, "chat-context-pressure-v1"];

function desktopProjection(contextWindow: number) {
  return {
    contextTokens: 9_000,
    contextWindow,
    inputBudgetTokens: contextWindow - 28_000,
    reservedTokens: 28_000,
    percentOfWindow: (9_000 / contextWindow) * 100,
    percentOfUsableInput: (9_000 / (contextWindow - 28_000)) * 100,
    shouldCompact: false,
    messageTokens: 3_000,
    staticTokens: 6_000,
    providerUsageTokens: 8_500,
    compressibleHistoryMessages: 2,
    source: "estimated" as const,
    computedAt: 1_787_166_120_000,
    breakdown: {
      categories: [{ id: "mcp-tools" as const, tokens: 6_000 }],
      deferred: [{ id: "mcp-tools" as const, tokens: 400, count: 1, servers: [{ name: "Acme internal tracker", count: 1, tokens: 400 }] }],
    },
    promptCache: { ttlMs: 300_000, lastRequestAt: 1_787_166_000_000 },
  };
}

function contextHost(features = CONTEXT_FEATURES, project: "projects" | "cannot" = "projects") {
  const host = new FakeHost("host_b", [{ id: "u1", role: "user", content: "Hello", createdAt: 1_100 }]);
  host.features = features;
  host.chat = { ...host.chat, providerId: "provider-1", model: "small-model" } as Chat;
  const priced: string[] = [];
  const unused = {} as never;
  const configured = new Map([["provider-1/small-model", 32_000], ["custom:local/org/large-model", 200_000]]);
  const chats = new AidenRemoteChatService({
    application: {
      get: async (id: string) => ({ chat: id === host.chat.id ? host.chat : null }),
    } as unknown as ConstructorParameters<typeof AidenRemoteChatService>[0]["application"],
    chatStore: unused,
    generation: unused,
    streams: unused,
    models: {
      resolve: async (providerId?: string, modelId?: string) => {
        if (!configured.has(`${providerId}/${modelId}`)) {
          throw new AidenRemoteServiceError("invalid_request", "Choose a configured Aiden provider and model.", 400);
        }
        return { providerId: providerId!, modelId: modelId!, thinkingLevels: [], supportsImages: false };
      },
    },
    bots: unused,
    botMutations: unused,
    contextPressure: async (_chatId, selection) => {
      const pair = selection ? `${selection.providerId}/${selection.modelId}` : `${host.chat.providerId}/${host.chat.model}`;
      priced.push(pair);
      return project === "cannot" ? null : desktopProjection(configured.get(pair)!);
    },
  });
  host.routes = async (input) => {
    const url = new URL(input.path, "https://host.invalid");
    const context = /^\/chats\/([^/]+)\/context$/u.exec(url.pathname);
    if (!context || (input.method ?? "GET") !== "GET") return UNHANDLED;
    const providerId = url.searchParams.get("providerId");
    const modelId = url.searchParams.get("modelId");
    const selection = providerId && modelId ? { providerId, modelId } : undefined;
    return JSON.parse(JSON.stringify(await chats.contextPressure(context[1]!, selection))) as unknown;
  };
  return { host, priced };
}

test("a paired Mac's meter reads the host's projection for the chat's model or a picked one", async () => {
  const { host, priced } = contextHost();
  const harness = await setup(host);
  try {
    assert.equal(harness.adapter.capabilities().has("contextPressure"), true);
    const own = await harness.adapter.contextPressure("chat-1");
    assert.ok(own.ok);
    assert.equal(own.value?.contextWindow, 32_000);
    assert.equal(own.value?.contextTokens, 9_000);
    assert.equal(own.value?.source, "estimated");
    // Only the headline counts reach this Mac's renderer.
    assert.equal(/Acme|breakdown|promptCache|compressible|providerUsage/u.test(JSON.stringify(own.value)), false);

    const picked = await harness.adapter.contextPressure("chat-1", { providerId: "custom:local", modelId: "org/large-model" });
    assert.ok(picked.ok);
    assert.equal(picked.value?.contextWindow, 200_000);
    assert.deepEqual(priced, ["provider-1/small-model", "custom:local/org/large-model"]);

    // A model the host has not configured is refused there, not guessed at here.
    const retired = await harness.adapter.contextPressure("chat-1", { providerId: "provider-1", modelId: "retired-model" });
    assert.equal(retired.ok, false);
    assert.equal(!retired.ok && retired.error.remoteCode, "invalid_request");
    // An id the host's URL rules cannot carry never leaves this Mac.
    const unsendable = await harness.adapter.contextPressure("chat-1", { providerId: "provider-1", modelId: "model with spaces" });
    assert.equal(unsendable.ok, false);
    assert.equal(priced.length, 2);
    assert.equal(host.calls.filter((call) => call.includes("/context")).length, 3);
  } finally {
    harness.close();
  }
});

test("a host that cannot project answers null, and one without the feature is never asked", async () => {
  const quiet = contextHost(CONTEXT_FEATURES, "cannot");
  const harness = await setup(quiet.host);
  try {
    assert.deepEqual(await harness.adapter.contextPressure("chat-1"), { ok: true, value: null });
  } finally {
    harness.close();
  }

  const older = contextHost(FEATURES);
  const olderHarness = await setup(older.host);
  try {
    assert.equal(olderHarness.adapter.capabilities().has("contextPressure"), false);
    const refused = await olderHarness.adapter.contextPressure("chat-1");
    assert.equal(!refused.ok && refused.error.code, "unsupported");
    assert.equal(older.host.calls.some((call) => call.includes("/context")), false);
  } finally {
    olderHarness.close();
  }
});

test("the meter needs both the host's feature and its chat:read grant", () => {
  const features = ["chat-context-pressure-v1"];
  assert.equal(remoteHostCapabilities({ features, capabilities: ["chat:read"] }).has("contextPressure"), true);
  assert.equal(remoteHostCapabilities({ features, capabilities: ["chat:write"] }).has("contextPressure"), false);
  assert.equal(remoteHostCapabilities({ features: [], capabilities: ["chat:read"] }).has("contextPressure"), false);
});
