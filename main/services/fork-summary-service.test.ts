import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  forkSummaryHoldsSend,
  type ChatForkSummaryV1,
} from "../../renderer/shared/chat-copy-contract.js";
import { ForkSummaryService, type ForkSummaryServiceDeps } from "./fork-summary-service.js";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";
import {
  appendPiMessages,
  beginPiVisibleTurnLease,
  ensurePiForkSummary,
  PiCompactionSessionStore,
  projectVisibleHistoryWithoutSkills,
  syncChatMessagesToPiSession,
} from "./pi-compaction-session-store.js";
import { createInMemoryPiSession } from "./pi-session-repository-port.js";
import type { Chat, ChatMessage } from "./types.js";

const PROVIDER = "fork-summary";
const MODEL = "fork-summary-model";

function runtimeFixture() {
  const faux = fauxProvider({
    api: "openai-completions",
    provider: PROVIDER,
    models: [{ id: MODEL, contextWindow: 100_000, maxTokens: 1_000 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const runtime: ResolvedModelRuntime = {
    provider: {
      id: PROVIDER, kind: "openai", label: "Fork summary test",
      baseUrl: "https://fork-summary.invalid/v1", models: [MODEL], needsKey: false,
    },
    model,
    models,
    apiKey: undefined,
    headers: undefined,
    streams: {
      streamSimple: () => {
        throw new Error("The registered faux provider must own the summary.");
      },
    },
  };
  return { faux, model, runtime };
}

function visible(id: string, role: "user" | "assistant", content: string): ChatMessage {
  return { id, role, content, createdAt: 1 };
}

const SOURCE_MESSAGES = [
  visible("u1", "user", "PRE_CUT_PROMPT"),
  visible("a1", "assistant", "PRE_CUT_ANSWER"),
  visible("u2", "user", "POST_CUT_PROMPT"),
  visible("a2", "assistant", "POST_CUT_ANSWER"),
];

/** A source chat and its fork after `a1`, with a pending summary. */
function chatsFixture(instructions?: string): Map<string, Chat> {
  const source: Chat = {
    id: "source", title: "Source", providerId: PROVIDER, model: MODEL,
    messages: SOURCE_MESSAGES, createdAt: 1, updatedAt: 1,
  };
  const fork: Chat = {
    id: "fork", title: "Source (fork)", providerId: PROVIDER, model: MODEL,
    messages: [visible("f-u1", "user", "PRE_CUT_PROMPT"), visible("f-a1", "assistant", "PRE_CUT_ANSWER")],
    forkedFrom: {
      chatId: "source", messageId: "a1", position: "after", at: 2,
      summary: { state: "pending", afterMessageId: "f-a1", ...(instructions ? { instructions } : {}) },
    },
    createdAt: 2, updatedAt: 2,
  };
  return new Map([[source.id, source], [fork.id, fork]]);
}

function serviceFixture(
  chats: Map<string, Chat>,
  runtime: ResolvedModelRuntime,
  overrides: Partial<ForkSummaryServiceDeps> = {},
) {
  const published: Array<ChatForkSummaryV1 | undefined> = [];
  const usage: AssistantMessage[] = [];
  const service = new ForkSummaryService({
    getChat: async (id) => structuredClone(chats.get(id) ?? null),
    updateForkSummary: async (id, next) => {
      const chat = chats.get(id);
      if (!chat?.forkedFrom) return null;
      const summary = next(chat.forkedFrom.summary, chat);
      if (summary === null) return null;
      const { summary: _previous, ...lineage } = chat.forkedFrom;
      chat.forkedFrom = summary ? { ...lineage, summary } : lineage;
      return structuredClone(chat);
    },
    journalEntriesAfter: async () => undefined,
    skillsEnabled: async () => false,
    resolveRuntime: async () => runtime,
    recordUsage: (message) => void usage.push(message),
    published: (chat) => void published.push(chat.forkedFrom?.summary),
    ...overrides,
  });
  return { service, published, usage, summary: () => chats.get("fork")?.forkedFrom?.summary };
}

function payloadText(context: unknown): string {
  return JSON.stringify(context);
}

function contextTexts(messages: readonly AgentMessage[]): string[] {
  return messages.flatMap((message) => {
    if (message.role === "branchSummary") return [`branch:${message.summary}`];
    if (message.role !== "user" && message.role !== "assistant") return [];
    if (typeof message.content === "string") return [message.content];
    return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
  });
}

test("a fork summary covers only what the source did after the fork point", async () => {
  const { faux, model, runtime } = runtimeFixture();
  const payloads: string[] = [];
  faux.setResponses([
    (context) => {
      payloads.push(payloadText(context));
      return fauxAssistantMessage("The user asked a follow-up and got POST_CUT_ANSWER.");
    },
  ]);
  const chats = chatsFixture("the follow-up");
  const { service, published, usage, summary } = serviceFixture(chats, runtime);

  assert.equal(forkSummaryHoldsSend(chats.get("fork")!.forkedFrom), true);
  await service.run("fork");

  assert.equal(payloads.length, 1);
  assert.match(payloads[0]!, /POST_CUT_PROMPT/u);
  assert.match(payloads[0]!, /POST_CUT_ANSWER/u);
  assert.doesNotMatch(payloads[0]!, /PRE_CUT_PROMPT/u);
  assert.match(payloads[0]!, /the follow-up/u, "the user's focus reaches the summarizer");

  const ready = summary();
  assert.equal(ready?.state, "ready");
  assert.equal(ready?.text, "The user asked a follow-up and got POST_CUT_ANSWER.");
  assert.equal(ready?.instructions, "the follow-up");
  assert.equal(forkSummaryHoldsSend(chats.get("fork")!.forkedFrom), false);
  assert.deepEqual(published.map((item) => item?.state), ["ready"]);
  assert.equal(usage.length, 1, "the summary's model usage is recorded");

  // The fork's next turn sees the summary right after its last copied
  // message and before the new prompt, once.
  const fork = chats.get("fork")!;
  const session = await createInMemoryPiSession("fork");
  assert.equal(await ensurePiForkSummary(session, fork.messages, ready, model, true), true);
  assert.equal(await ensurePiForkSummary(session, fork.messages, ready, model, true), false);
  await syncChatMessagesToPiSession(
    session,
    [...fork.messages, visible("f-u2", "user", "A different follow-up")],
    model,
    true,
  );
  const texts = contextTexts((await session.buildContext()).messages);
  assert.equal(texts.length, 4);
  assert.deepEqual(texts.slice(0, 2), ["PRE_CUT_PROMPT", "PRE_CUT_ANSWER"]);
  assert.match(texts[2]!, /^branch:This chat was forked from another chat\./u);
  assert.match(texts[2]!, /got POST_CUT_ANSWER/u);
  assert.equal(texts[3], "A different follow-up");

  // With Skills off, the projected context still carries it in place.
  const projected = await projectVisibleHistoryWithoutSkills(
    await createInMemoryPiSession("fork-skill-free"),
    fork.messages,
    model,
    ready,
  );
  const projectedTexts = contextTexts((await projected.buildContext()).messages);
  assert.deepEqual(projectedTexts.slice(0, 2), ["PRE_CUT_PROMPT", "PRE_CUT_ANSWER"]);
  assert.match(projectedTexts[2]!, /got POST_CUT_ANSWER/u);
});

test("with Skills on, the summary reads the source journal after the cut", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-fork-summary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PiCompactionSessionStore({ root: async () => root });
  const { faux, model, runtime } = runtimeFixture();
  const reply = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") =>
    fauxAssistantMessage(content, { stopReason });

  // The source's second turn ran a tool; only the journal records the call.
  const journal = await store.openChat("source");
  const settle = async (history: ChatMessage[], generated: AgentMessage[], assistantId: string) => {
    await syncChatMessagesToPiSession(journal, history, model, true);
    const lease = await beginPiVisibleTurnLease(journal);
    await appendPiMessages(journal, generated);
    await lease.commit(assistantId);
  };
  await settle(SOURCE_MESSAGES.slice(0, 1), [reply([{ type: "text", text: "PRE_CUT_ANSWER" }])], "a1");
  await settle(SOURCE_MESSAGES.slice(0, 3), [
    reply([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "notes.md" } }], "toolUse"),
    {
      role: "toolResult", toolCallId: "call-1", toolName: "read",
      content: [{ type: "text", text: "POST_CUT_TOOL_OUTPUT" }], isError: false, timestamp: 2,
    },
    reply([{ type: "text", text: "POST_CUT_ANSWER" }]),
  ], "a2");

  const payloads: string[] = [];
  faux.setResponses([
    (context) => {
      payloads.push(payloadText(context));
      return fauxAssistantMessage("Read notes.md.");
    },
  ]);
  const chats = chatsFixture();
  const { service, summary } = serviceFixture(chats, runtime, {
    skillsEnabled: async () => true,
    journalEntriesAfter: (chatId, messageId) => store.journalEntriesAfter(chatId, messageId),
  });
  await service.run("fork");

  assert.equal(summary()?.state, "ready");
  assert.match(payloads[0]!, /read\(path=\\"notes\.md\\"\)/u);
  assert.doesNotMatch(payloads[0]!, /PRE_CUT_PROMPT/u);
  assert.deepEqual(summary()?.files, { read: ["notes.md"], modified: [] });
});

test("a failed summary holds sends until it is retried or skipped", async () => {
  const { faux, runtime } = runtimeFixture();
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider is down" }),
    fauxAssistantMessage("Recovered summary."),
  ]);
  const chats = chatsFixture();
  const { service, summary } = serviceFixture(chats, runtime);

  await service.run("fork");
  assert.equal(summary()?.state, "failed");
  assert.ok(summary()?.error);
  assert.equal(forkSummaryHoldsSend(chats.get("fork")!.forkedFrom), true);
  await assert.rejects(service.skip("missing"), /no unfinished summary/u);

  await service.retry("fork");
  assert.equal(summary()?.state, "pending");
  await service.run("fork");
  assert.equal(summary()?.state, "ready");
  assert.equal(summary()?.text, "Recovered summary.");
  await assert.rejects(service.retry("fork"), /no failed summary/u);

  // Continue without summary turns a failed fork into a plain fork.
  const skipped = chatsFixture();
  const skipping = serviceFixture(skipped, runtime, {
    resolveRuntime: async () => {
      throw new Error("missing credential");
    },
  });
  await skipping.service.run("fork");
  assert.equal(skipping.summary()?.error, "The original chat's model is unavailable.");
  await skipping.service.skip("fork");
  assert.equal(skipping.summary(), undefined);
  assert.equal(forkSummaryHoldsSend(skipped.get("fork")!.forkedFrom), false);
  assert.equal(skipped.get("fork")!.forkedFrom?.chatId, "source", "the lineage itself stays");
});

test("cancelling a running summary leaves it failed, and an interrupted one fails at startup", async () => {
  const { faux, runtime } = runtimeFixture();
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  faux.setResponses([
    async () => {
      started();
      await released;
      return fauxAssistantMessage("Too late.");
    },
  ]);
  const chats = chatsFixture();
  const { service, summary } = serviceFixture(chats, runtime);
  const running = service.run("fork");
  await providerStarted;
  assert.equal(service.isRunning("fork"), true);
  await assert.rejects(service.skip("fork"), /Cancel the summary/u);
  assert.equal(service.cancel("fork"), true);
  release();
  await running;
  assert.deepEqual(
    { state: summary()?.state, error: summary()?.error },
    { state: "failed", error: "Summary cancelled." },
  );
  assert.equal(service.cancel("fork"), false);

  const interrupted = chatsFixture();
  const recovery = serviceFixture(interrupted, runtime);
  await recovery.service.settleInterrupted("fork");
  assert.equal(recovery.summary()?.state, "failed");
  assert.deepEqual(recovery.published.map((item) => item?.state), ["failed"]);
});
