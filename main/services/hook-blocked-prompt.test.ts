import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fauxProvider, type Api, type Model } from "@earendil-works/pi-ai";
import { createChatStore } from "./chat-store-core.js";
import { isHookBlockedPrompt, parseHookBlockedPrompt, withoutHookBlockedPrompts } from "./hook-blocked-prompt.js";
import {
  PiCompactionSessionStore,
  projectVisibleHistoryWithoutSkills,
  syncChatMessagesToPiSession,
} from "./pi-compaction-session-store.js";
import { buildChatRenamePrompt } from "./chat-title-policy.js";

const BLOCKED = "deploy with key sk-live-BLOCKED-7f3a";

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function fauxModel(): Model<Api> {
  return fauxProvider({
    api: "openai-completions",
    provider: `hook-blocked-${Math.random().toString(36).slice(2)}`,
    models: [{ id: "hook-blocked-model", contextWindow: 8_000, maxTokens: 1_000 }],
  }).getModel() as Model<Api>;
}

test("only a user message with a well-formed mark counts as hook-blocked, and its reason stays bounded", () => {
  assert.equal(isHookBlockedPrompt({ role: "user", hookBlocked: { reason: "secrets" } }), true);
  assert.equal(isHookBlockedPrompt({ role: "assistant", hookBlocked: { reason: "secrets" } }), false);
  assert.equal(isHookBlockedPrompt({ role: "user", hookBlocked: { reason: 3 } }), false);
  assert.equal(isHookBlockedPrompt({ role: "user", hookBlocked: ["secrets"] }), false);
  assert.equal(isHookBlockedPrompt({ role: "user" }), false);
  assert.equal(parseHookBlockedPrompt({ reason: "   " })?.reason, "A hook blocked this prompt.");
  assert.ok(parseHookBlockedPrompt({ reason: "x".repeat(10_000) })!.reason.length <= 500);
  assert.deepEqual(
    withoutHookBlockedPrompts([
      { role: "user", content: "a" },
      { role: "user", content: "b", hookBlocked: { reason: "no" } },
      { role: "assistant", content: "c" },
    ]).map((message) => message.content),
    ["a", "c"],
  );
});

test("a prompt a hook blocked on turn N never reaches the model on turn N+1, a fork, or a title prompt", async (t) => {
  const chatsRoot = await tempDir(t, "aiden-hook-blocked-chats-");
  const store = createChatStore(async () => chatsRoot);
  const chat = await store.create({ workspaceId: "workspace" });
  await store.appendMessage(chat.id, { role: "user", content: "Summarize the release notes" });
  await store.appendMessage(chat.id, { role: "assistant", content: "Here is the summary." });

  // Turn N: the hook refuses the prompt; it stays visible and is marked.
  const blockedChat = await store.appendMessage(chat.id, { role: "user", content: BLOCKED });
  const blockedId = blockedChat.messages[blockedChat.messages.length - 1]!.id;
  assert.equal(await store.setPromptHookBlock(chat.id, blockedId, "Blocked by hook scan: secrets in prompt"), true);
  // Turn N+1.
  await store.appendMessage(chat.id, { role: "user", content: "Then list the open issues" });
  const replied = await store.appendMessage(chat.id, { role: "assistant", content: "Three issues are open." });
  const lastReplyId = replied.messages[replied.messages.length - 1]!.id;

  const stored = (await store.get(chat.id))!;
  assert.equal(stored.messages.find((message) => message.id === blockedId)?.content, BLOCKED, "still visible");
  assert.equal(stored.messages.find((message) => message.id === blockedId)?.hookBlocked?.reason, "Blocked by hook scan: secrets in prompt");

  const model = fauxModel();
  const piRoot = await tempDir(t, "aiden-hook-blocked-pi-");
  const sessions = new PiCompactionSessionStore({ root: async () => piRoot });
  const session = await sessions.openChat(chat.id);
  await syncChatMessagesToPiSession(session, stored.messages, model, false);
  const context = JSON.stringify(await session.buildContext());
  assert.doesNotMatch(context, /sk-live-BLOCKED/);
  assert.match(context, /Then list the open issues/);
  assert.match(context, /Summarize the release notes/);

  // The skill-free projection (skills off) leaves it out too.
  const skillFree = await projectVisibleHistoryWithoutSkills(session, stored.messages, model);
  assert.doesNotMatch(JSON.stringify(await skillFree.buildContext()), /sk-live-BLOCKED/);

  // A title prompt never quotes it.
  assert.doesNotMatch(JSON.stringify(buildChatRenamePrompt(stored.messages)), /sk-live-BLOCKED/);

  // A fork that includes the blocked prompt carries the mark, so the copy keeps it out as well.
  const fork = await store.copyVisibleHistory({
    sourceChatId: chat.id,
    forkAt: { messageId: lastReplyId, position: "after" },
  });
  const copied = fork.messages.find((message) => message.content === BLOCKED);
  assert.ok(copied?.hookBlocked, "the fork keeps the mark");
  const forkSession = await sessions.openChat(fork.id);
  await syncChatMessagesToPiSession(forkSession, fork.messages, model, false);
  assert.doesNotMatch(JSON.stringify(await forkSession.buildContext()), /sk-live-BLOCKED/);
});

test("a renderer append can't mark a prompt, and clearing the mark lets a retried prompt through", async (t) => {
  const chatsRoot = await tempDir(t, "aiden-hook-blocked-clear-");
  const store = createChatStore(async () => chatsRoot);
  const chat = await store.create({});
  const appended = await store.appendMessage(chat.id, {
    role: "user",
    content: "hello",
    hookBlocked: { reason: "forged" },
  } as Parameters<typeof store.appendMessage>[1]);
  const id = appended.messages[appended.messages.length - 1]!.id;
  assert.equal((await store.get(chat.id))!.messages[0]!.hookBlocked, undefined);

  assert.equal(await store.setPromptHookBlock(chat.id, id, "Blocked by a hook: no"), true);
  assert.equal(await store.setPromptHookBlock(chat.id, id, undefined), true);
  assert.equal((await store.get(chat.id))!.messages[0]!.hookBlocked, undefined);
  assert.equal(await store.setPromptHookBlock(chat.id, id, undefined), false, "nothing to clear");
  assert.equal(await store.setPromptHookBlock(chat.id, "missing", "x"), false);
});
