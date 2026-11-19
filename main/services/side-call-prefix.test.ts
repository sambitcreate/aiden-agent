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
  test("a continuation replays the parent's request options and appends after its reply", () => {
    const ledger = createSideCallPrefixLedger({ ttlMs: LIVE_TTL });
    const finished = ledger.begin(CHAT_ID, model(), context, {
      sessionId: "session-a",
      reasoning: "high",
      toolChoice: "auto",
      apiKey: "parent-secret",
    } as SimpleStreamOptions);
    assert.equal(ledger.latest(CHAT_ID), undefined, "a request with no reply yet is not a prefix");
    const parentReply = reply("Hi there.");
    finished(parentReply);
    const prefix = ledger.latest(CHAT_ID);
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

  test("a later parent request does not change a prefix already read", () => {
    const ledger = createSideCallPrefixLedger({ ttlMs: LIVE_TTL });
    const messages = [...context.messages];
    ledger.begin(CHAT_ID, model(), { ...context, messages })(reply("One."));
    const prefix = ledger.latest(CHAT_ID);
    messages.push({ role: "user", content: "Edited in place", timestamp: 2 });
    assert.deepEqual(prefix?.context.messages, context.messages);
  });

  test("the prefix lapses with the provider's cache lifetime", () => {
    let now = 1_000;
    const ledger = createSideCallPrefixLedger({ ttlMs: LIVE_TTL, now: () => now });
    ledger.begin(CHAT_ID, model(), context)(reply("Hi."));
    now += 299_999;
    assert.ok(ledger.latest(CHAT_ID));
    now += 1;
    assert.equal(ledger.latest(CHAT_ID), undefined);
  });

  test("no prefix is kept without a documented cache lifetime", () => {
    const ledger = createSideCallPrefixLedger({ ttlMs: () => 0 });
    ledger.begin(CHAT_ID, model(), context)(reply("Hi."));
    assert.equal(ledger.latest(CHAT_ID), undefined);
  });

  test("a request that cannot be replayed faithfully clears the chat's prefix", () => {
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
      assert.equal(ledger.latest(CHAT_ID), undefined, JSON.stringify(Object.keys(options)));
    }
  });

  test("a failed or aborted reply is not a prefix", () => {
    for (const stopReason of ["error", "aborted"] as const) {
      const ledger = createSideCallPrefixLedger({ ttlMs: LIVE_TTL });
      ledger.begin(CHAT_ID, model(), context)(reply("", { stopReason }));
      assert.equal(ledger.latest(CHAT_ID), undefined);
    }
  });

  test("a reply to a superseded request does not overwrite the newer one", () => {
    const ledger = createSideCallPrefixLedger({ ttlMs: LIVE_TTL });
    const first = ledger.begin(CHAT_ID, model(), context);
    const newer = normalizeContext({ systemPrompt: "Newer.", messages: [{ role: "user", content: "Hello", timestamp: 1 }] });
    const second = ledger.begin(CHAT_ID, model(), newer);
    const newerReply = reply("Newer reply.");
    second(newerReply);
    first(reply("Stale reply."));
    assert.deepEqual(ledger.latest(CHAT_ID)?.context.messages, newer.messages);
    assert.equal(ledger.latest(CHAT_ID)?.response, newerReply);
  });

  test("only the most recent chats keep a prefix", () => {
    const ledger = createSideCallPrefixLedger({ ttlMs: LIVE_TTL, maxChats: 2 });
    for (const chat of ["one", "two", "three"]) ledger.begin(chat, model(), context)(reply(chat));
    assert.equal(ledger.latest("one"), undefined);
    assert.ok(ledger.latest("two"));
    assert.ok(ledger.latest("three"));
  });

  test("forget drops the chat's prefix, as a completed compaction does", () => {
    const ledger = createSideCallPrefixLedger({ ttlMs: LIVE_TTL });
    ledger.begin(CHAT_ID, model(), context)(reply("Hi."));
    ledger.forget(CHAT_ID);
    assert.equal(ledger.latest(CHAT_ID), undefined);
  });

  test("one-off options never write a cache", () => {
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
    resolveRuntime: async () => runtimeFor(harnessModel, capturingStream("It lists the workspace.", sent)),
    isChatBusy: () => false,
    recordUsage: async () => {},
    registry: new BtwOperationRegistry(2),
    parentPrefix: (chatId) => ledger.latest(chatId),
  });
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
    const prefix = ledger.latest(CHAT_ID);
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
    const parentReply = ledger.latest(CHAT_ID)!.response;
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
    const { harness, ledger } = ledgerHarness();
    const target = harness.model;
    const candidate: AdvisorCandidate = {
      providerId: target.provider,
      providerLabel: "Provider",
      modelId: target.id,
      modelLabel: target.name,
      efforts: [],
    };
    const sent: Array<{ context: PromptProviderContext; options: SimpleStreamOptions | undefined }> = [];
    const streamSimple = capturingStream("Check the boundary first.", sent);
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
      getLiveMessages: () => [],
      sideCallPrefix: () => ledger.latest(CHAT_ID),
    });
    assert.ok(extension?.tools?.[0]);
    const requests = await harness.turn({
      prompt: "Should we migrate the storage now?",
      systemPrompt: `You are Aiden.\n\n${extension.systemPrompt ?? ""}`,
      tools: [countedList, ...extension.tools],
      responses: [
        fauxAssistantMessage(
          [
            fauxToolCall("advisor", { providerId: target.provider, modelId: target.id }),
            fauxToolCall("list_files", {}),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("The advisor says to check the boundary first."),
      ],
    });
    const executorRequest = requests[0]!;
    assert.equal(sent.length, 1, "the review sent one request");
    const [request] = sent;
    const review = await harness.record(request!.context, { turn: 2, step: 1 });
    assertExtends(executorRequest, review);
    assert.ok(review.carries(ADVISOR_CONTINUATION_INSTRUCTION));
    assert.equal(request!.options?.cacheRetention, "short");
    assert.equal(request!.options?.disableContinuation, true);
    assert.equal(request!.options?.apiKey, "side-secret");
    // The executor's turn ran its own list_files call once; the review ran none.
    assert.equal(listRuns, 1);
    assert.equal(harness.networkCalls, 0);
  });
});
