import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxProvider, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  appendPiMessages,
  beginPiGenerationTurn,
  beginPiVisibleTurnLease,
  PiCompactionSessionStore,
  syncChatMessagesToPiSession,
} from "./pi-compaction-session-store.js";
import type { PiSessionPort } from "./pi-session-port.js";
import type { ChatMessage } from "./types.js";

const model = fauxProvider({
  api: "openai-completions",
  provider: "faux-fork",
  models: [{ id: "faux-fork", contextWindow: 100_000, maxTokens: 1_000 }],
}).getModel() as Model<Api>;

function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 2,
  };
}

function visible(id: string, role: "user" | "assistant", content: string): ChatMessage {
  return { id, role, content, createdAt: 1 };
}

/** One settled generation turn the way the runtime records it. */
async function settledTurn(
  session: PiSessionPort,
  history: readonly ChatMessage[],
  generated: readonly AgentMessage[],
  assistantId: string,
): Promise<void> {
  await syncChatMessagesToPiSession(session, history, model, true);
  const lease = await beginPiVisibleTurnLease(session);
  await appendPiMessages(session, generated);
  await lease.commit(assistantId);
}

function texts(messages: readonly AgentMessage[]): string[] {
  return messages.flatMap((message) => {
    if (message.role === "compactionSummary") return [`summary:${message.summary}`];
    if (message.role === "toolResult") {
      return message.content.flatMap((part) => (part.type === "text" ? [`tool:${part.text}`] : []));
    }
    if (message.role !== "user" && message.role !== "assistant") return [];
    if (typeof message.content === "string") return [message.content];
    return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
  });
}

async function storeFixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-fork-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new PiCompactionSessionStore({ root: async () => root }) };
}

/** u0 → a0, a checkpoint, u1 → tool call → a1, then u2 → a2 after the cut. */
async function sourceWithTurns(store: PiCompactionSessionStore): Promise<void> {
  const source = await store.openChat("source");
  await settledTurn(source, [visible("u0", "user", "hello")], [reply([{ type: "text", text: "hi" }])], "a0");
  await source.appendCompaction({
    id: "checkpoint", summary: "PRE_CUT_SUMMARY", retainedTail: [], tokensBefore: 100,
  });
  const turnOne = [visible("u0", "user", "hello"), visible("a0", "assistant", "hi"), visible("u1", "user", "find the file")];
  await settledTurn(source, turnOne, [
    reply([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } }], "toolUse"),
    {
      role: "toolResult", toolCallId: "call-1", toolName: "read",
      content: [{ type: "text", text: "PRE_CUT_TOOL_OUTPUT" }], isError: false, timestamp: 2,
    },
    reply([{ type: "text", text: "found it" }]),
  ], "a1");
  await settledTurn(
    source,
    [...turnOne, visible("a1", "assistant", "found it"), visible("u2", "user", "POST_CUT_PROMPT")],
    [reply([{ type: "text", text: "POST_CUT_ANSWER" }])],
    "a2",
  );
}

test("a fork carries model context through the cut and nothing after it", async (t) => {
  const { root, store } = await storeFixture(t);
  await sourceWithTurns(store);

  const forked = await store.forkChat({
    sourceChatId: "source",
    targetChatId: "fork",
    targetCreatedAt: Date.now(),
    messages: ["u0", "a0", "u1", "a1"].map((sourceId) => ({ sourceId, id: `f-${sourceId}` })),
  });
  assert.equal(forked, true);

  // A fresh process must see the same settled journal: the copied turn is
  // committed, so recovery has nothing to roll back.
  const reopened = await new PiCompactionSessionStore({ root: async () => root }).openChat("fork");
  const context = texts((await reopened.buildContext()).messages);
  assert.deepEqual(context, [
    "summary:PRE_CUT_SUMMARY",
    "find the file",
    "tool:PRE_CUT_TOOL_OUTPUT",
    "found it",
  ]);

  // The fork's next turn appends only its new prompt, not the copied ones.
  await syncChatMessagesToPiSession(reopened, [
    visible("f-u0", "user", "hello"),
    visible("f-a0", "assistant", "hi"),
    visible("f-u1", "user", "find the file"),
    visible("f-a1", "assistant", "found it"),
    visible("f-u2", "user", "a different follow-up"),
  ], model, true);
  const after = (await reopened.getBranch()).flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  assert.deepEqual(
    after.filter((message) => message.role === "user").map((message) => texts([message])[0]),
    ["hello", "find the file", "a different follow-up"],
  );

  // The source journal is untouched by the fork.
  const source = texts((await store.openChat("source").then((session) => session.buildContext())).messages);
  assert.ok(source.includes("POST_CUT_ANSWER"));
});

test("a fork of a fork can cut at an earlier inherited reply", async (t) => {
  const { root, store } = await storeFixture(t);
  await sourceWithTurns(store);
  const fork = (sourceChatId: string, targetChatId: string, sourceIds: string[], prefix: string) =>
    store.forkChat({
      sourceChatId, targetChatId, targetCreatedAt: Date.now(),
      messages: sourceIds.map((sourceId) => ({ sourceId, id: `${prefix}${sourceId}` })),
    });
  assert.equal(await fork("source", "fork", ["u0", "a0", "u1", "a1"], "f-"), true);

  // Reopen so the nested fork reads the copied journal from disk.
  const reopened = new PiCompactionSessionStore({ root: async () => root });
  assert.equal(await reopened.forkChat({
    sourceChatId: "fork", targetChatId: "nested", targetCreatedAt: Date.now(),
    messages: [{ sourceId: "f-u0", id: "g-u0" }, { sourceId: "f-a0", id: "g-a0" }],
  }), true);
  // The same cut taken in the original chat is the oracle.
  assert.equal(await fork("source", "direct", ["u0", "a0"], "d-"), true);

  const nested = await reopened.openChat("nested");
  const direct = await reopened.openChat("direct");
  assert.deepEqual(
    texts((await nested.buildContext()).messages),
    texts((await direct.buildContext()).messages),
  );
  assert.deepEqual(texts((await nested.buildContext()).messages), ["hello", "hi"]);

  // The nested fork's next turn appends only its new prompt.
  await syncChatMessagesToPiSession(nested, [
    visible("g-u0", "user", "hello"),
    visible("g-a0", "assistant", "hi"),
    visible("g-u1", "user", "another question"),
  ], model, true);
  assert.deepEqual(texts((await nested.buildContext()).messages), ["hello", "hi", "another question"]);
});

test("a fork without a provable journal boundary creates no journal", async (t) => {
  const { store } = await storeFixture(t);
  const fork = (sourceChatId: string, targetChatId: string, sourceId: string) =>
    store.forkChat({
      sourceChatId, targetChatId, targetCreatedAt: Date.now(),
      messages: [{ sourceId, id: `${targetChatId}-message` }],
    });

  assert.equal(await fork("missing", "fork-missing", "u1"), false);
  assert.equal(await store.hasChatHistory("fork-missing"), false);

  await sourceWithTurns(store);
  assert.equal(await fork("source", "fork-unsynced", "never-synchronized"), false);
  assert.equal(await store.hasChatHistory("fork-unsynced"), false);

  // A reply whose generation envelope never committed is not a settled cut.
  const running = await store.openChat("running");
  await syncChatMessagesToPiSession(running, [visible("u1", "user", "start")], model, true);
  await beginPiGenerationTurn(running);
  await appendPiMessages(running, [reply([{ type: "text", text: "partial" }])], "a1");
  assert.equal(await fork("running", "fork-running", "a1"), false);
  assert.equal(await store.hasChatHistory("fork-running"), false);
});

test("a branch imports only into an empty journal as one root-to-tip path", async (t) => {
  const { store } = await storeFixture(t);
  const source = await store.openChat("import-source");
  await source.appendMessage({ role: "user", content: "one", timestamp: 1 });
  await source.appendMessage({ role: "user", content: "two", timestamp: 2 });
  const branch = await source.getBranch();

  const occupied = await store.openChat("import-occupied");
  await occupied.appendMessage({ role: "user", content: "existing", timestamp: 1 });
  await assert.rejects(occupied.importBranch(branch), /empty journal/u);

  const empty = await store.openChat("import-empty");
  await assert.rejects(empty.importBranch([...branch].reverse()), /root-to-tip/u);
  await empty.importBranch(branch);
  assert.deepEqual(texts((await empty.buildContext()).messages), ["one", "two"]);
});
