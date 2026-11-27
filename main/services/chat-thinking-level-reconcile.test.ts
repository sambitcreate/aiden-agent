import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { applyChatMetadataUpdate, type ChatMetadataUpdatedPatch } from "../../renderer/shared/chat-metadata-update.js";
import { createChatStore } from "./chat-store-core.js";
import { reconcileTurnThinkingLevel } from "./chat-thinking-level-reconcile.js";
import { resolveGenerationThinkingLevel } from "./generation-runtime.js";
import { temporaryDirectory } from "../shared/temp-dir-test-support.js";

// A Codex model that offers its default levels plus xhigh, but not max.
const PROVIDER = "openai-codex";
const MODEL = "codex-model";
const runtimeModel = { reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } } as const;

async function fixture(t: TestContext) {
  const root = await temporaryDirectory(t, "aiden-thinking-reconcile-");
  const chatStore = createChatStore(async () => root);
  const broadcasts: ChatMetadataUpdatedPatch[] = [];
  await chatStore.create({ id: "chat-1", title: "Chat", providerId: PROVIDER, model: MODEL });
  return {
    root,
    chatStore,
    broadcasts,
    deps: { chatStore, broadcast: (update: ChatMetadataUpdatedPatch) => broadcasts.push(update) },
  };
}

test("a chat level the model no longer supports is replaced by the level the turn ran with", async (t) => {
  const f = await fixture(t);
  await f.chatStore.setChatModelSelection("chat-1", PROVIDER, MODEL, undefined, "max");
  const atSend = (await f.chatStore.get("chat-1"))!;
  // The renderer cache the person is looking at.
  let rendererCopy = structuredClone(atSend);

  // The turn asks for the chat's own level; main clamps it.
  const sent = resolveGenerationThinkingLevel(PROVIDER, runtimeModel, atSend.thinkingLevel);
  assert.notEqual(sent, "max");
  const wrote = await reconcileTurnThinkingLevel(f.deps, {
    chat: atSend,
    providerId: PROVIDER,
    model: MODEL,
    requested: atSend.thinkingLevel,
    resolved: sent,
  });

  assert.equal(wrote, true);
  assert.equal((await f.chatStore.get("chat-1"))?.thinkingLevel, sent);
  assert.equal((await f.chatStore.list()).find((meta) => meta.id === "chat-1")?.thinkingLevel, sent);
  assert.equal((await createChatStore(async () => f.root).get("chat-1"))?.thinkingLevel, sent, "a fresh read agrees");
  assert.equal(f.broadcasts.length, 1);
  rendererCopy = applyChatMetadataUpdate(rendererCopy, f.broadcasts[0]!);
  assert.equal(rendererCopy.thinkingLevel, sent, "the open chat shows the level that ran");
  assert.equal(rendererCopy.title, atSend.title);
  assert.equal(rendererCopy.updatedAt, atSend.updatedAt, "the sidebar order does not move");
});

test("a newer selection made while the turn starts is never overwritten", async (t) => {
  const f = await fixture(t);
  await f.chatStore.setChatModelSelection("chat-1", PROVIDER, MODEL, undefined, "max");
  const atSend = (await f.chatStore.get("chat-1"))!;
  const sent = resolveGenerationThinkingLevel(PROVIDER, runtimeModel, atSend.thinkingLevel);

  await f.chatStore.setChatModelSelection("chat-1", PROVIDER, MODEL, undefined, "low");
  const wrote = await reconcileTurnThinkingLevel(f.deps, {
    chat: atSend,
    providerId: PROVIDER,
    model: MODEL,
    requested: atSend.thinkingLevel,
    resolved: sent,
  });

  assert.equal(wrote, false);
  assert.equal((await f.chatStore.get("chat-1"))?.thinkingLevel, "low");
  assert.deepEqual(f.broadcasts, []);
});

test("only a turn that ran the chat's own level on the chat's own model is reconciled", async (t) => {
  const f = await fixture(t);
  await f.chatStore.setChatModelSelection("chat-1", PROVIDER, MODEL, undefined, "max");
  const atSend = (await f.chatStore.get("chat-1"))!;
  const attempts = [
    { requested: undefined, providerId: PROVIDER, model: MODEL },
    { requested: "high" as const, providerId: PROVIDER, model: MODEL },
    { requested: "max" as const, providerId: PROVIDER, model: "other-model" },
  ];
  for (const attempt of attempts) {
    assert.equal(
      await reconcileTurnThinkingLevel(f.deps, { chat: atSend, ...attempt, resolved: "medium" }),
      false,
      JSON.stringify(attempt),
    );
  }
  assert.equal(
    await reconcileTurnThinkingLevel(f.deps, {
      chat: atSend,
      providerId: PROVIDER,
      model: MODEL,
      requested: "max",
      resolved: "max",
    }),
    false,
    "a supported level needs no write",
  );
  await f.chatStore.create({ id: "bot-chat", botId: "bot-1", providerId: PROVIDER, model: MODEL });
  const bot = (await f.chatStore.get("bot-chat"))!;
  assert.equal(
    await reconcileTurnThinkingLevel(f.deps, {
      chat: { ...bot, thinkingLevel: "max" },
      providerId: PROVIDER,
      model: MODEL,
      requested: "max",
      resolved: "medium",
    }),
    false,
  );
  assert.equal((await f.chatStore.get("chat-1"))?.thinkingLevel, "max");
  assert.equal((await f.chatStore.get("bot-chat"))?.thinkingLevel, undefined);
  assert.deepEqual(f.broadcasts, []);
});

test("a chat with no level of its own stays without one after its saved level is clamped", async (t) => {
  const f = await fixture(t);
  const atSend = (await f.chatStore.get("chat-1"))!;
  assert.equal(atSend.thinkingLevel, undefined);
  // Custom: the renderer sends the per-model saved level, which the model no longer offers.
  const sent = resolveGenerationThinkingLevel(PROVIDER, runtimeModel, "max");
  assert.notEqual(sent, "max");

  const wrote = await reconcileTurnThinkingLevel(f.deps, {
    chat: atSend,
    providerId: PROVIDER,
    model: MODEL,
    requested: "max",
    resolved: sent,
  });

  assert.equal(wrote, false);
  assert.equal((await f.chatStore.get("chat-1"))?.thinkingLevel, undefined);
  assert.equal((await f.chatStore.list()).find((meta) => meta.id === "chat-1")?.thinkingLevel, undefined);
  assert.deepEqual(f.broadcasts, []);
});
