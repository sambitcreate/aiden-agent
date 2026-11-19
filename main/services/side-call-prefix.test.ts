// Side calls on the parent's cached prefix (docs/plans/prompt-cache-hit-rate.md,
// phase 4). The end-to-end cases run a real chat turn through the prompt
// prefix harness with the ledger on its stream, then send a side question
// (the real BtwService) or a same-model review (the real advisor tool) and
// render that request through the same offline adapter: its tools, system
// and messages must extend the parent's last request byte for byte.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  createModels,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import type { BtwEventV1 } from "../../renderer/shared/btw.js";
import {
  ADVISOR_CONTINUATION_INSTRUCTION,
  AdvisorRuntime,
  type AdvisorCandidate,
  type AdvisorRuntimeDependencies,
} from "./advisor-runtime.js";
import { snapshotAdvisorRuntimeMessages } from "./advisor-context.js";
import { chatPromptPrefixCompacted, forgetChatPromptCacheState } from "./chat-prompt-cache-state.js";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";
import {
  comparePromptRequests,
  createPromptPrefixHarness,
  type PromptProviderContext,
  type RecordedPromptRequest,
} from "./prompt-prefix-harness.js";
import { BtwOperationRegistry } from "./rpiv-btw/operation-registry.js";
import { BtwService, type BtwOwner } from "./rpiv-btw/service-core.js";
import {
  chatSideCallPrefixes,
  createSideCallPrefixLedger,
  oneOffCallOptions,
  sideCallContinuation,
  withSideCallPrefixLedger,
  type SideCallPrefixLedger,
} from "./side-call-prefix.js";
import type { Chat } from "./types.js";

const CHAT_ID = "chat-a";
const LIVE_TTL = () => 300_000;

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "model-a",
    name: "Model A",
    api: "anthropic-messages",
    provider: "provider-a",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
    ...overrides,
  } as Model<Api>;
}

function reply(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "provider-a",
    model: "model-a",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 5,
    ...overrides,
  };
}

const context = normalizeContext({
  systemPrompt: "You are Aiden.",
  messages: [{ role: "user", content: "Hello", timestamp: 1 }],
  tools: [],
});

describe("side-call prefix ledger", () => {
  test("a continuation replays the parent's request options and appends after its reply", async () => {
    const ledger = createSideCallPrefixLedger({ ttlMs: LIVE_TTL });
    const finished = ledger.begin(CHAT_ID, model(), context, {
      sessionId: "session-a",
      reasoning: "high",
      toolChoice: "auto",
      apiKey: "parent-secret",
    } as SimpleStreamOptions);
    assert.equal(await ledger.latest(CHAT_ID), undefined, "a request with no reply yet is not a prefix");
    const parentReply = reply("Hi there.");
    finished(parentReply);
    const prefix = await ledger.latest(CHAT_ID);
    assert.ok(prefix);

    const question = { role: "user" as const, content: "Side question", timestamp: 9 };
    const request = sideCallContinuation(prefix, [question], { apiKey: "side-secret", maxTokens: 64 });
    // The system prompt travels as the context's first message.
    assert.deepEqual(request.context.messages, [...context.messages, parentReply, question]);
    assert.equal(request.options.sessionId, "session-a");
    assert.equal(request.options.reasoning, "high");
    assert.equal(request.options.toolChoice, "auto");
    assert.equal(request.options.cacheRetention, "short");
    assert.equal(request.options.disableContinuation, true);
    // The side call sends its own credentials, never the parent's.
    assert.equal(request.options.apiKey, "side-secret");
    assert.equal(request.options.maxTokens, 64);
  });

  test("a later parent request does not change a prefix already read", async () => {
    const ledger = createSideCallPrefixLedger({ ttlMs: LIVE_TTL });
    const messages = [...context.messages];
    ledger.begin(CHAT_ID, model(), { ...context, messages })(reply("One."));
    const prefix = await ledger.latest(CHAT_ID);
    messages.push({ role: "user", content: "Edited in place", timestamp: 2 });
    assert.deepEqual(prefix?.context.messages, context.messages);
  });

  test("the prefix lapses with the provider's cache lifetime", async () => {
    let now = 1_000;
    const ledger = createSideCallPrefixLedger({ ttlMs: LIVE_TTL, now: () => now });
    ledger.begin(CHAT_ID, model(), context)(reply("Hi."));
    now += 299_999;
    assert.ok(await ledger.latest(CHAT_ID));
    now += 1;
    assert.equal(await ledger.latest(CHAT_ID), undefined);
  });

  test("no prefix is kept without a documented cache lifetime", async () => {
    const ledger = createSideCallPrefixLedger({ ttlMs: () => 0 });
    ledger.begin(CHAT_ID, model(), context)(reply("Hi."));
    assert.equal(await ledger.latest(CHAT_ID), undefined);
  });

  test("a request that cannot be replayed faithfully clears the chat's prefix", async () => {
    const refused: SimpleStreamOptions[] = [
      { cacheRetention: "none" },
      { headers: { "x-extra": "1" } },
      { onPayload: () => undefined },
      { metadata: { user_id: "u" } },
    ];
    for (const options of refused) {
      const ledger = createSideCallPrefixLedger({ ttlMs: LIVE_TTL });
      ledger.begin(CHAT_ID, model(), context)(reply("Earlier."));
      ledger.begin(CHAT_ID, model(), context, options)(reply("Later."));
      assert.equal(await ledger.latest(CHAT_ID), undefined, JSON.stringify(Object.keys(options)));
    }
  });

  test("a failed or aborted reply is not a prefix", async () => {
    for (const stopReason of ["error", "aborted"] as const) {
      const ledger = createSideCallPrefixLedger({ ttlMs: LIVE_TTL });
      ledger.begin(CHAT_ID, model(), context)(reply("", { stopReason }));
      assert.equal(await ledger.latest(CHAT_ID), undefined);
    }
  });

  test("a reply to a superseded request does not overwrite the newer one", async () => {
    const ledger = createSideCallPrefixLedger({ ttlMs: LIVE_TTL });
    const first = ledger.begin(CHAT_ID, model(), context);
    const newer = normalizeContext({ systemPrompt: "Newer.", messages: [{ role: "user", content: "Hello", timestamp: 1 }] });
    const second = ledger.begin(CHAT_ID, model(), newer);
    const newerReply = reply("Newer reply.");
    second(newerReply);
    first(reply("Stale reply."));
    assert.deepEqual((await ledger.latest(CHAT_ID))?.context.messages, newer.messages);
    assert.equal((await ledger.latest(CHAT_ID))?.response, newerReply);
  });

  test("only the most recent chats keep a prefix", async () => {
    const ledger = createSideCallPrefixLedger({ ttlMs: LIVE_TTL, maxChats: 2 });
    for (const chat of ["one", "two", "three"]) ledger.begin(chat, model(), context)(reply(chat));
    assert.equal(await ledger.latest("one"), undefined);
    assert.ok(await ledger.latest("two"));
    assert.ok(await ledger.latest("three"));
  });

  test("forget drops the chat's prefix, as a completed compaction does", async () => {
    const ledger = createSideCallPrefixLedger({ ttlMs: LIVE_TTL });
    ledger.begin(CHAT_ID, model(), context)(reply("Hi."));
    ledger.forget(CHAT_ID);
    assert.equal(await ledger.latest(CHAT_ID), undefined);
  });

  test("one-off options never write a cache", async () => {
    assert.deepEqual(oneOffCallOptions({ maxTokens: 10 }), { maxTokens: 10, cacheRetention: "none" });
    assert.equal(oneOffCallOptions({ cacheRetention: "long" as const }).cacheRetention, "none");
  });
});

const listFiles: AgentTool = {
  name: "list_files",
  label: "List files",
  description: "List the files in the workspace.",
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "a.ts\nb.ts" }], details: undefined }),
};

function ledgerHarness(): { harness: ReturnType<typeof createPromptPrefixHarness>; ledger: SideCallPrefixLedger } {
  const ledger = createSideCallPrefixLedger({ ttlMs: LIVE_TTL });
  const harness = createPromptPrefixHarness({
    wrapStream: (streamFn) => withSideCallPrefixLedger(streamFn, { ledger, chatKey: CHAT_ID }),
  });
  return { harness, ledger };
}

function runtimeFor(target: Model<Api>, streamSimple: ResolvedModelRuntime["streams"]["streamSimple"]): ResolvedModelRuntime {
  return {
    provider: {
      id: target.provider,
      kind: "anthropic",
      label: "Provider",
      baseUrl: target.baseUrl,
      models: [target.id],
      needsKey: true,
    },
    model: target,
    models: createModels(),
    apiKey: "side-secret",
    headers: undefined,
    streams: { streamSimple },
  } as ResolvedModelRuntime;
}

type SentRequest = { context: PromptProviderContext; options: SimpleStreamOptions | undefined };
type ScriptedAnswer = string | "throw" | "error" | "empty";

/**
 * A provider stream that keeps every request it was sent and answers each in
 * turn: a text, a thrown dispatch, a provider error, or an empty reply.
 */
function scriptedStream(answers: ScriptedAnswer[], sent: SentRequest[]) {
  return ((streamModel: Model<Api>, streamContext: PromptProviderContext, options?: SimpleStreamOptions) => {
    sent.push({ context: streamContext, options });
    const answer = answers[Math.min(sent.length, answers.length) - 1]!;
    if (answer === "throw") throw new Error("Provider dispatch failed.");
    const stream = createAssistantMessageEventStream();
    const identity = { provider: streamModel.provider, model: streamModel.id, api: streamModel.api };
    queueMicrotask(() => {
      if (answer === "error") {
        stream.push({ type: "error", reason: "error", error: reply("", { ...identity, stopReason: "error", errorMessage: "Upstream failed." }) });
        return;
      }
      const text = answer === "empty" ? "" : answer;
      const message = reply(text, identity);
      if (text) stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  }) as ResolvedModelRuntime["streams"]["streamSimple"];
}

/** A provider stream that answers `text` and keeps every request it was sent. */
function capturingStream(text: string, sent: Array<{ context: PromptProviderContext; options: SimpleStreamOptions | undefined }>) {
  return ((streamModel: Model<Api>, streamContext: PromptProviderContext, options?: SimpleStreamOptions) => {
    sent.push({ context: streamContext, options });
    const stream = createAssistantMessageEventStream();
    const message = reply(text, { provider: streamModel.provider, model: streamModel.id, api: streamModel.api });
    queueMicrotask(() => {
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  }) as ResolvedModelRuntime["streams"]["streamSimple"];
}

function assertExtends(parent: RecordedPromptRequest, side: RecordedPromptRequest): void {
  assert.equal(side.wire[0]?.kind, "tools", "the side call keeps the parent's tools declared");
  assert.deepEqual(comparePromptRequests(parent, side).wire, undefined, "the side call extends the parent's request");
  assert.ok(side.wire.length > parent.wire.length, "the side call appends after the parent's request");
}

async function sideQuestion(service: BtwService, question: string): Promise<BtwEventV1[]> {
  const events: BtwEventV1[] = [];
  const owner: BtwOwner = {
    documentId: "document-a",
    isDestroyed: () => false,
    send: (_channel, event) => events.push(event),
    onInvalidated: () => () => {},
  };
  await service.start(CHAT_ID, question, owner);
  const deadline = Date.now() + 2_000;
  while (!events.some((event) => event.type === "terminal")) {
    if (Date.now() > deadline) throw new Error("Side question timed out.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return events;
}

function btwService(
  harnessModel: Model<Api>,
  ledger: SideCallPrefixLedger,
  parentReply: AssistantMessage | undefined,
  sent: Array<{ context: PromptProviderContext; options: SimpleStreamOptions | undefined }>,
  streamSimple: ResolvedModelRuntime["streams"]["streamSimple"] = capturingStream("It lists the workspace.", sent),
): BtwService {
  const chat: Chat = {
    id: CHAT_ID,
    title: "Chat",
    workspaceId: "workspace-a",
    providerId: harnessModel.provider,
    model: harnessModel.id,
    createdAt: 1,
    updatedAt: 2,
    messages: [
      { id: "user-a", role: "user", content: "Which files are there?", createdAt: 1 },
      { id: "assistant-a", role: "assistant", content: "Two: a.ts and b.ts.", createdAt: 2, ...(parentReply ? { pi: parentReply } : {}) },
    ],
  };
  return new BtwService({
    getChat: async () => chat,
    resolveRuntime: async () => runtimeFor(harnessModel, streamSimple),
    isChatBusy: () => false,
    recordUsage: async () => {},
    registry: new BtwOperationRegistry(2),
    parentPrefix: (chatId) => ledger.latest(chatId),
  });
}

type AdvisorToolName = "advisor" | "list_files";

/**
 * Runs one executor turn whose first reply calls the tools in `order` (the
 * advisor on the executor's own model) and then answers. The review's
 * provider requests land in `sent`.
 */
async function advisorTurn(input: {
  answers: ScriptedAnswer[];
  sent: SentRequest[];
  order: AdvisorToolName[];
  effort?: "high";
  /** The chat's reasoning on the executor's requests. */
  parentReasoning?: "high";
  /** false: the advisor sees no live transcript, so an earlier call has no result. */
  liveMessages?: boolean;
}) {
  const ledger = createSideCallPrefixLedger({ ttlMs: LIVE_TTL });
  const harness = createPromptPrefixHarness({
    wrapStream: (streamFn) => {
      const ledgered = withSideCallPrefixLedger(streamFn, { ledger, chatKey: CHAT_ID });
      // A review at an effort needs a thinking model; the chat runs on the same one.
      return input.effort
        ? (streamModel, streamContext, options) =>
          ledgered({ ...streamModel, reasoning: true }, streamContext, { ...options, reasoning: input.parentReasoning })
        : ledgered;
    },
  });
  const target = input.effort ? ({ ...harness.model, reasoning: true } as Model<Api>) : harness.model;
  const candidate: AdvisorCandidate = {
    providerId: target.provider,
    providerLabel: "Provider",
    modelId: target.id,
    modelLabel: target.name,
    efforts: input.effort ? [input.effort] : [],
  };
  const streamSimple = scriptedStream(input.answers, input.sent);
  const advisor = new AdvisorRuntime({
    attempts: {
      initialize: async () => undefined,
      prepare: async () => undefined,
      markDispatchStarted: async () => undefined,
      settle: async () => undefined,
      markUsageRecorded: async () => undefined,
    },
    listCandidates: async () => [candidate],
    resolveRuntime: async () => runtimeFor(target, streamSimple),
    recordUsage: async () => undefined,
    recordUnreportedUsage: async () => undefined,
  } as unknown as AdvisorRuntimeDependencies);
  let listRuns = 0;
  const countedList: AgentTool = { ...listFiles, execute: async (...args) => { listRuns += 1; return listFiles.execute(...args); } };
  const extension = await advisor.extensionForGeneration({
    scope: {
      usageSource: "chat",
      interactionSurface: "desktop",
      bot: false,
      child: false,
      rendererOwner: true,
      excluded: false,
    },
    executor: { providerId: target.provider, modelId: target.id },
    executorTools: [countedList],
    getLiveMessages: (toolCallId) => {
      const state = harness.agentState();
      return input.liveMessages === false || !state ? [] : snapshotAdvisorRuntimeMessages(state, toolCallId);
    },
    sideCallPrefix: () => ledger.latest(CHAT_ID),
  });
  assert.ok(extension?.tools?.[0]);
  const calls = input.order.map((name) =>
    name === "advisor"
      ? fauxToolCall("advisor", { providerId: target.provider, modelId: target.id, ...(input.effort ? { effort: input.effort } : {}) })
      : fauxToolCall("list_files", {}),
  );
  const requests = await harness.turn({
    prompt: "Should we migrate the storage now?",
    systemPrompt: `You are Aiden.\n\n${extension.systemPrompt ?? ""}`,
    tools: [countedList, ...extension.tools],
    responses: [
      fauxAssistantMessage(calls, { stopReason: "toolUse" }),
      fauxAssistantMessage("The advisor says to check the boundary first."),
    ],
  });
  return {
    harness,
    executorRequest: requests[0]!,
    /** The executor's request after the tools ran: it carries the advisor's result. */
    finalRequest: requests[requests.length - 1]!,
    listRuns: () => listRuns,
  };
}

describe("side calls on the parent prefix", () => {
  test("a side question continues the parent's last request with its tools, system and messages", async () => {
    const { harness, ledger } = ledgerHarness();
    const requests = await harness.turn({
      prompt: "Which files are there?",
      systemPrompt: "You are Aiden, working in a small repository.",
      tools: [listFiles],
      responses: [
        fauxAssistantMessage(fauxToolCall("list_files", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("Two: a.ts and b.ts."),
      ],
    });
    const parent = requests[requests.length - 1]!;
    const prefix = await ledger.latest(CHAT_ID);
    assert.ok(prefix, "the ledger holds the turn's last request");

    const sent: Array<{ context: PromptProviderContext; options: SimpleStreamOptions | undefined }> = [];
    const events = await sideQuestion(btwService(harness.model, ledger, prefix.response, sent), "What does list_files do?");
    const last = events[events.length - 1];
    assert.equal(last?.type === "terminal" && last.status, "completed");
    assert.equal(sent.length, 1);
    const [request] = sent;
    const side = await harness.record(request!.context, { turn: 2, step: 1 });
    assertExtends(parent, side);
    assert.ok(side.carries("What does list_files do?"));
    assert.equal(request!.options?.cacheRetention, "short");
    assert.equal(request!.options?.disableContinuation, true);
    assert.equal(request!.options?.apiKey, "side-secret");
    assert.equal(harness.networkCalls, 0);
  });

  test("a side question without a live parent prefix sends an isolated one-off request", async () => {
    const { harness, ledger } = ledgerHarness();
    await harness.turn({
      prompt: "Which files are there?",
      systemPrompt: "You are Aiden.",
      tools: [listFiles],
      responses: [fauxAssistantMessage("Two: a.ts and b.ts.")],
    });
    const parentReply = (await ledger.latest(CHAT_ID))!.response;
    ledger.forget(CHAT_ID);
    const sent: Array<{ context: PromptProviderContext; options: SimpleStreamOptions | undefined }> = [];
    await sideQuestion(btwService(harness.model, ledger, parentReply, sent), "Why?");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.options?.cacheRetention, "none");
    assert.deepEqual((sent[0]!.context as { tools?: unknown[] }).tools ?? [], []);
  });

  test("a side question after a newer chat message does not continue a stale prefix", async () => {
    const { harness, ledger } = ledgerHarness();
    await harness.turn({
      prompt: "Which files are there?",
      systemPrompt: "You are Aiden.",
      tools: [listFiles],
      responses: [fauxAssistantMessage("Two: a.ts and b.ts.")],
    });
    // The chat's last reply is not the one the ledger recorded (an edit or a later turn).
    const other = reply("A different reply.", { timestamp: 123, provider: harness.model.provider, model: harness.model.id });
    const sent: Array<{ context: PromptProviderContext; options: SimpleStreamOptions | undefined }> = [];
    await sideQuestion(btwService(harness.model, ledger, other, sent), "Why?");
    assert.equal(sent[0]!.options?.cacheRetention, "none");
  });

  test("a same-model advisor review continues the executor's request and runs no tool", async () => {
    const sent: SentRequest[] = [];
    const run = await advisorTurn({ answers: ["Check the boundary first."], sent, order: ["advisor", "list_files"] });
    assert.equal(sent.length, 1, "the review sent one request");
    const [request] = sent;
    const review = await run.harness.record(request!.context, { turn: 2, step: 1 });
    assertExtends(run.executorRequest, review);
    assert.ok(review.carries(ADVISOR_CONTINUATION_INSTRUCTION));
    assert.ok(review.carries("Not run: the task is paused for an advisor review."), "a call after the advisor has not run");
    assert.equal(request!.options?.cacheRetention, "short");
    assert.equal(request!.options?.disableContinuation, true);
    assert.equal(request!.options?.apiKey, "side-secret");
    // The executor's turn ran its own list_files call once; the review ran none.
    assert.equal(run.listRuns(), 1);
    assert.ok(run.finalRequest.carries("Check the boundary first."));
    assert.equal(run.harness.networkCalls, 0);
  });

  test("an advisor review after a finished tool call carries that call's real result", async () => {
    const sent: SentRequest[] = [];
    const run = await advisorTurn({ answers: ["Looks fine."], sent, order: ["list_files", "advisor"] });
    assert.equal(sent.length, 1);
    const [request] = sent;
    assert.equal(request!.options?.cacheRetention, "short");
    const review = await run.harness.record(request!.context, { turn: 2, step: 1 });
    assertExtends(run.executorRequest, review);
    assert.ok(review.carries("a.ts\nb.ts"), "the review sees list_files' output");
    assert.equal(review.carries("Not run: the task is paused for an advisor review."), false);
    assert.equal(run.listRuns(), 1);
  });

  test("an advisor review whose earlier call has no result yet is a separate request", async () => {
    const sent: SentRequest[] = [];
    const run = await advisorTurn({ answers: ["Looks fine."], sent, order: ["list_files", "advisor"], liveMessages: false });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.options?.cacheRetention, "none");
    assert.deepEqual((sent[0]!.context as { tools?: unknown[] }).tools ?? [], []);
    assert.ok(run.finalRequest.carries("Looks fine."));
  });

  test("an advisor review at a different effort is a separate one-off request", async () => {
    const sent: SentRequest[] = [];
    await advisorTurn({ answers: ["Looks fine."], sent, order: ["advisor"], effort: "high" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.options?.cacheRetention, "none");
    assert.equal(sent[0]!.options?.reasoning, "high");
    assert.deepEqual((sent[0]!.context as { tools?: unknown[] }).tools ?? [], []);
  });

  test("an advisor review at the executor's effort continues its request", async () => {
    const sent: SentRequest[] = [];
    const run = await advisorTurn({ answers: ["Looks fine."], sent, order: ["advisor"], effort: "high", parentReasoning: "high" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.options?.cacheRetention, "short");
    assert.equal(sent[0]!.options?.reasoning, "high");
    assertExtends(run.executorRequest, await run.harness.record(sent[0]!.context, { turn: 2, step: 1 }));
  });

  const failureLabel = { throw: "throws", error: "errors", empty: "answers nothing" } as const;

  for (const failure of ["throw", "error", "empty"] as const) {
    test(`an advisor continuation that ${failureLabel[failure]} falls back to the separate review`, async () => {
      const sent: SentRequest[] = [];
      const run = await advisorTurn({ answers: [failure, "Check the boundary first."], sent, order: ["advisor"] });
      assert.equal(sent.length, 2);
      assert.equal(sent[0]!.options?.cacheRetention, "short");
      assert.equal(sent[1]!.options?.cacheRetention, "none");
      assert.deepEqual((sent[1]!.context as { tools?: unknown[] }).tools ?? [], []);
      assert.ok(run.finalRequest.carries("Advisor guidance"));
      assert.ok(run.finalRequest.carries("Check the boundary first."));
    });
  }

  for (const failure of ["throw", "error", "empty"] as const) {
    test(`a side question whose continuation ${failureLabel[failure]} falls back to the isolated request`, async () => {
      const { harness, ledger } = ledgerHarness();
      await harness.turn({
        prompt: "Which files are there?",
        systemPrompt: "You are Aiden.",
        tools: [listFiles],
        responses: [fauxAssistantMessage("Two: a.ts and b.ts.")],
      });
      const prefix = await ledger.latest(CHAT_ID);
      assert.ok(prefix);
      const sent: SentRequest[] = [];
      const events = await sideQuestion(
        btwService(harness.model, ledger, prefix.response, sent, scriptedStream([failure, "It lists the workspace."], sent)),
        "Why?",
      );
      assert.equal(sent.length, 2);
      assert.equal(sent[0]!.options?.cacheRetention, "short");
      assert.equal(sent[1]!.options?.cacheRetention, "none");
      assert.ok(events.some((event) => event.type === "reset"), "the side panel drops the continuation's partial answer");
      const last = events[events.length - 1];
      assert.equal(last?.type === "terminal" && last.status, "completed");
      assert.equal(last?.type === "terminal" && last.answer, "It lists the workspace.");
    });
  }

  test("a side call replays the parent's thinking, tool choice and cache marker; only its output cap differs", async () => {
    const ledger = createSideCallPrefixLedger({ ttlMs: LIVE_TTL });
    let parent: SentRequest | undefined;
    const harness = createPromptPrefixHarness({
      wrapStream: (streamFn) => {
        const ledgered = withSideCallPrefixLedger(streamFn, { ledger, chatKey: CHAT_ID });
        // The chat's own settings, as llm-client passes them.
        return (streamModel, streamContext, options) => {
          const chatOptions = { ...options, reasoning: "high" as const, toolChoice: "auto" as const };
          parent = { context: streamContext as PromptProviderContext, options: chatOptions };
          return ledgered(streamModel, streamContext, chatOptions);
        };
      },
    });
    await harness.turn({
      prompt: "Which files are there?",
      systemPrompt: "You are Aiden.",
      tools: [listFiles],
      responses: [fauxAssistantMessage("Two: a.ts and b.ts.")],
    });
    const prefix = await ledger.latest(CHAT_ID);
    assert.ok(prefix && parent);
    const sent: SentRequest[] = [];
    await sideQuestion(btwService(harness.model, ledger, prefix.response, sent), "Why?");
    assert.equal(sent.length, 1);
    const parentRequest = await harness.record(parent.context, { turn: 1, step: 1 }, parent.options);
    const side = await harness.record(sent[0]!.context, { turn: 2, step: 1 }, sent[0]!.options);
    assertExtends(parentRequest, side);
    assert.ok(parentRequest.settings.thinking, "the parent request thinks");
    assert.ok(parentRequest.settings.tool_choice, "the parent request names its tool choice");
    const { max_tokens: _parentCap, ...parentSettings } = parentRequest.settings;
    const { max_tokens: sideCap, ...sideSettings } = side.settings;
    assert.deepEqual(sideSettings, parentSettings, "thinking, tool choice and every cache-keyed setting match");
    assert.equal(typeof sideCap, "number");
    assert.ok(parentRequest.cacheMarkers.length > 0);
    assert.deepEqual(side.cacheMarkers, parentRequest.cacheMarkers, "the same retention marks the request");
  });
});

describe("memory the parent prefix stated", () => {
  const FACT = "- [memory:fact-1] Prefers tabs over spaces.";

  test("a prefix stating a fact replays only while the fact is still approved", async () => {
    const ledger = createSideCallPrefixLedger({ ttlMs: LIVE_TTL });
    const withFact = normalizeContext({
      systemPrompt: `You are Aiden.\n\n${FACT}`,
      messages: [{ role: "user", content: "Hello", timestamp: 1 }],
    });
    let approved: string[] = [FACT];
    ledger.begin(CHAT_ID, model(), withFact, undefined, async () => approved)(reply("Hi."));
    assert.ok(await ledger.latest(CHAT_ID));
    approved = [];
    assert.equal(await ledger.latest(CHAT_ID), undefined, "a removed fact blocks the prefix");
    approved = [FACT];
    assert.equal(await ledger.latest(CHAT_ID), undefined, "the dropped prefix does not come back");

    const unreadable = async (): Promise<string[]> => { throw new Error("store unreadable"); };
    for (const reader of [undefined, unreadable]) {
      ledger.begin(CHAT_ID, model(), withFact, undefined, reader)(reply("Hi."));
      assert.equal(await ledger.latest(CHAT_ID), undefined, "a fact nobody can confirm blocks the prefix");
    }
    ledger.begin(CHAT_ID, model(), context)(reply("Hi."));
    assert.ok(await ledger.latest(CHAT_ID), "a prefix with no facts needs no confirmation");
  });

  async function factTurn(approved: { lines: string[] }) {
    const ledger = createSideCallPrefixLedger({ ttlMs: LIVE_TTL });
    const harness = createPromptPrefixHarness({
      wrapStream: (streamFn) =>
        withSideCallPrefixLedger(streamFn, { ledger, chatKey: CHAT_ID, approvedMemoryFacts: async () => approved.lines }),
    });
    await harness.turn({
      prompt: "Which files are there?",
      systemPrompt: `You are Aiden.\n\n${FACT}`,
      tools: [listFiles],
      responses: [fauxAssistantMessage("Two: a.ts and b.ts.")],
    });
    const parentReply = (await ledger.latest(CHAT_ID))?.response;
    assert.ok(parentReply);
    return { harness, ledger, parentReply };
  }

  test("a side question while the fact is approved continues the request that states it", async () => {
    const { harness, ledger, parentReply } = await factTurn({ lines: [FACT] });
    const sent: SentRequest[] = [];
    await sideQuestion(btwService(harness.model, ledger, parentReply, sent), "Why?");
    assert.equal(sent[0]!.options?.cacheRetention, "short");
    assert.ok(JSON.stringify(sent[0]!.context).includes("Prefers tabs over spaces."));
  });

  test("a side question after the fact is forgotten sends no fact text", async () => {
    const approved = { lines: [FACT] };
    const { harness, ledger, parentReply } = await factTurn(approved);
    approved.lines = [];
    const sent: SentRequest[] = [];
    await sideQuestion(btwService(harness.model, ledger, parentReply, sent), "Why?");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.options?.cacheRetention, "none");
    assert.equal(JSON.stringify(sent[0]!.context).includes("Prefers tabs over spaces."), false);
  });

  test("the ledger keeps tool declarations, not their implementations", async () => {
    const { ledger } = await factTurn({ lines: [FACT] });
    const prefix = await ledger.latest(CHAT_ID);
    const declared = [
      ...((prefix?.context as { tools?: unknown[] }).tools ?? []),
      ...(prefix?.context.messages ?? []).flatMap((message) => (message.role === "system" ? message.toolsAdded ?? [] : [])),
    ] as Array<Record<string, unknown>>;
    assert.ok(declared.some((tool) => tool.name === "list_files"));
    for (const tool of declared) assert.equal(typeof tool.execute, "undefined", String(tool.name));
  });
});

describe("chat prompt-cache state", () => {
  const cached = model({ promptCache: { short: 300 } } as Partial<Model<Api>>);

  test("a completed compaction drops the chat's side-call prefix", async () => {
    chatSideCallPrefixes.begin("compacted-chat", cached, context)(reply("Hi."));
    assert.ok(await chatSideCallPrefixes.latest("compacted-chat"));
    chatPromptPrefixCompacted("compacted-chat");
    assert.equal(await chatSideCallPrefixes.latest("compacted-chat"), undefined);
  });

  test("forgetting a chat's context profile drops its side-call prefix", async () => {
    chatSideCallPrefixes.begin("deleted-chat", cached, context)(reply("Hi."));
    chatSideCallPrefixes.begin("other-chat", cached, context)(reply("Hi."));
    forgetChatPromptCacheState("deleted-chat");
    assert.equal(await chatSideCallPrefixes.latest("deleted-chat"), undefined);
    assert.ok(await chatSideCallPrefixes.latest("other-chat"), "other chats keep theirs");
    chatSideCallPrefixes.forget("other-chat");
  });
});
