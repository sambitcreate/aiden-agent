// The goal reviewer against a real chat turn: the prompt prefix harness runs
// the turn with the side-call ledger on its stream, then the review request is
// rendered through the same offline adapter and must extend the turn's last
// request byte for byte, or fall back to an isolated, tool-free request.

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";

import {
  comparePromptRequests,
  createPromptPrefixHarness,
  type PromptProviderContext,
} from "../prompt-prefix-harness.js";
import { createSideCallPrefixLedger, withSideCallPrefixLedger } from "../side-call-prefix.js";
import type { StoredProvider } from "../types.js";
import type { UsageRequestRecord } from "../usage-store-core.js";
import { goalReviewMaxTokens, reviewGoal, type GoalReviewerDependencies } from "./goal-reviewer.js";

const CHAT_ID = "chat-goal";
const goal = { objective: "Make the test suite pass", rounds: 2, maxRounds: 50 };
const DONE = '{"verdict": "done", "reason": "The last run shows 12 passing tests."}';

let listRuns = 0;
const listFiles: AgentTool = {
  name: "list_files",
  label: "List files",
  description: "List the files in the workspace.",
  parameters: Type.Object({}),
  execute: async () => {
    listRuns += 1;
    return { content: [{ type: "text", text: "a.ts\nb.ts" }], details: undefined };
  },
};

type Answer = { text: string } | { toolCall: true } | "error" | "timeout" | "throw";
type Sent = { context: PromptProviderContext; options: SimpleStreamOptions | undefined };

/** A provider that keeps every request and answers each in turn. */
function scripted(answers: Answer[], sent: Sent[]) {
  return (
    streamModel: Model<Api>,
    streamContext: PromptProviderContext,
    options?: SimpleStreamOptions,
  ) => {
    sent.push({ context: streamContext, options });
    const answer = answers[Math.min(sent.length, answers.length) - 1]!;
    if (answer === "throw") throw new Error("dispatch failed");
    const stream = createAssistantMessageEventStream();
    const base = {
      role: "assistant" as const,
      api: streamModel.api,
      provider: streamModel.provider,
      model: streamModel.id,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 90,
        cacheWrite: 0,
        totalTokens: 105,
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      },
      timestamp: 9,
    };
    queueMicrotask(() => {
      if (answer === "error" || answer === "timeout") {
        const message = {
          ...base,
          content: [],
          stopReason: answer === "error" ? "error" : "aborted",
          errorMessage: "no",
        } as AssistantMessage;
        stream.push({
          type: "error",
          reason: message.stopReason as "error" | "aborted",
          error: message,
        });
        return;
      }
      const message = (
        "toolCall" in answer
          ? {
              ...base,
              content: [{ type: "toolCall", id: "call-1", name: "list_files", arguments: {} }],
              stopReason: "toolUse",
            }
          : { ...base, content: [{ type: "text", text: answer.text }], stopReason: "stop" }
      ) as AssistantMessage;
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    });
    return stream;
  };
}

const provider: StoredProvider = {
  id: "provider-a",
  kind: "anthropic",
  label: "Provider",
  baseUrl: "https://example.invalid",
  models: ["model-a"],
  needsKey: true,
} as StoredProvider;

async function chatTurn(reasoning?: "high") {
  listRuns = 0;
  const ledger = createSideCallPrefixLedger({ ttlMs: () => 300_000 });
  const harness = createPromptPrefixHarness({
    wrapStream: (streamFn) => {
      const ledgered = withSideCallPrefixLedger(streamFn, { ledger, chatKey: CHAT_ID });
      // A chat that thinks: its requests carry the reasoning level.
      return reasoning
        ? (streamModel, streamContext, options) =>
            ledgered({ ...streamModel, reasoning: true }, streamContext, { ...options, reasoning })
        : ledgered;
    },
  });
  const requests = await harness.turn({
    prompt: "/goal Make the test suite pass",
    systemPrompt: "You are Aiden, working in a small repository.",
    tools: [listFiles],
    responses: [
      fauxAssistantMessage(fauxToolCall("list_files", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("I listed the files and ran the tests: 12 passing."),
    ],
  });
  return { harness, ledger, parent: requests[requests.length - 1]! };
}

const transcript: AgentMessage[] = [
  { role: "user", content: "/goal Make the test suite pass", timestamp: 1 },
  {
    role: "assistant",
    content: [{ type: "text", text: "12 passing." }],
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
    timestamp: 2,
  },
] as AgentMessage[];

function dependencies(input: {
  model: Model<Api>;
  answers: Answer[];
  sent: Sent[];
  prefix: GoalReviewerDependencies["prefix"];
  refusal?: string;
}) {
  const usage: UsageRequestRecord[] = [];
  const spent: number[] = [];
  const deps: GoalReviewerDependencies = {
    runtime: {
      model: input.model,
      provider,
      apiKey: "review-secret",
      streams: { streamSimple: scripted(input.answers, input.sent) as never },
    },
    prefix: input.prefix,
    messages: async () => transcript,
    spendingRefusal: async () => input.refusal,
    countSpend: (message) => spent.push(message.usage.cost.total),
    recordUsage: (record) => {
      usage.push(record);
    },
  };
  return { deps, usage, spent };
}

const open = () => new AbortController().signal;

test("the review continues the chat's last request, runs no tool and is accounted as goal-review", async () => {
  const { harness, ledger, parent } = await chatTurn();
  const sent: Sent[] = [];
  const { deps, usage, spent } = dependencies({
    model: harness.model,
    answers: [{ text: "```json\n" + DONE + "\n```" }],
    sent,
    prefix: () => ledger.latest(CHAT_ID),
  });
  const outcome = await reviewGoal(deps, { goal, allowWait: false, signal: open() });
  assert.deepEqual(outcome, {
    kind: "verdict",
    verdict: { verdict: "done", reason: "The last run shows 12 passing tests." },
    via: "continuation",
  });
  assert.equal(sent.length, 1);
  const review = await harness.record(sent[0]!.context, { turn: 2, step: 1 });
  assert.equal(review.wire[0]?.kind, "tools", "the review keeps the chat's tools declared");
  assert.equal(
    comparePromptRequests(parent, review).wire,
    undefined,
    "the review extends the chat's request",
  );
  assert.ok(review.wire.length > parent.wire.length);
  assert.ok(
    review.carries("<untrusted_objective>\nMake the test suite pass\n</untrusted_objective>"),
  );
  assert.equal(sent[0]!.options?.cacheRetention, "short");
  assert.equal(sent[0]!.options?.maxTokens, 400);
  assert.equal(sent[0]!.options?.timeoutMs, 60_000);
  assert.equal(sent[0]!.options?.maxRetries, 0);
  assert.equal(sent[0]!.options?.apiKey, "review-secret");
  assert.equal(listRuns, 1, "only the chat's own turn ran list_files");
  assert.deepEqual(
    usage.map((record) => [record.source, record.status]),
    [["goal-review", "completed"]],
  );
  assert.deepEqual(spent, [0.03]);
  assert.equal(harness.networkCalls, 0);
});

test("a reply that calls a tool is no verdict, and the tool never runs", async () => {
  const { harness, ledger } = await chatTurn();
  const sent: Sent[] = [];
  const { deps } = dependencies({
    model: harness.model,
    answers: [{ toolCall: true }],
    sent,
    prefix: () => ledger.latest(CHAT_ID),
  });
  assert.deepEqual(await reviewGoal(deps, { goal, allowWait: false, signal: open() }), {
    kind: "unusable",
    why: "tool-call",
    via: "continuation",
  });
  assert.equal(sent.length, 1);
  assert.equal(listRuns, 1);
});

test("prose without a verdict, or wait with nothing running, is no verdict", async () => {
  const { harness, ledger } = await chatTurn();
  for (const text of ["It looks done to me.", '{"verdict": "wait", "reason": "the build runs"}']) {
    const { deps } = dependencies({
      model: harness.model,
      answers: [{ text }],
      sent: [],
      prefix: () => ledger.latest(CHAT_ID),
    });
    const outcome = await reviewGoal(deps, { goal, allowWait: false, signal: open() });
    assert.equal(outcome.kind === "unusable" && outcome.why, "no-verdict", text);
  }
});

test("a stale prefix falls back to an isolated, tool-free request", async () => {
  const { harness, ledger } = await chatTurn();
  // The chat has since moved to another model, so the cached prefix is not this model's.
  const other = { ...harness.model, id: "model-b" } as Model<Api>;
  for (const [model, prefix] of [
    [other, () => ledger.latest(CHAT_ID)],
    [harness.model, async () => undefined],
  ] as const) {
    const sent: Sent[] = [];
    const { deps } = dependencies({ model, answers: [{ text: DONE }], sent, prefix });
    const outcome = await reviewGoal(deps, { goal, allowWait: false, signal: open() });
    assert.equal(outcome.kind === "verdict" && outcome.via, "isolated");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.options?.cacheRetention, "none");
    assert.deepEqual((sent[0]!.context as { tools?: unknown[] }).tools ?? [], []);
    const messages = sent[0]!.context.messages;
    const last = messages[messages.length - 1]!;
    assert.equal(last.role, "user");
    assert.match(JSON.stringify(last.content), /untrusted_objective/u);
  }
});

test("a chat request that forced a tool call is not continued: the review goes straight to the isolated, tool-free request", async () => {
  const { harness, ledger } = await chatTurn();
  for (const toolChoice of ["required", "any", { type: "tool", name: "list_files" }]) {
    const sent: Sent[] = [];
    const prefix = async () => {
      const latest = await ledger.latest(CHAT_ID);
      return (
        latest && { ...latest, options: { ...latest.options, toolChoice: toolChoice as never } }
      );
    };
    const { deps } = dependencies({
      model: harness.model,
      answers: [{ text: DONE }],
      sent,
      prefix,
    });
    const outcome = await reviewGoal(deps, { goal, allowWait: false, signal: open() });
    assert.equal(outcome.kind, "verdict", JSON.stringify(toolChoice));
    assert.equal(outcome.kind === "verdict" && outcome.via, "isolated");
    assert.equal(sent.length, 1, "one request, never the forced continuation");
    assert.equal(sent[0]!.options?.toolChoice, undefined);
    assert.deepEqual((sent[0]!.context as { tools?: unknown[] }).tools ?? [], []);
  }
});

test("a failed continuation falls back once; a timed-out one does not", async () => {
  const { harness, ledger } = await chatTurn();
  const failedSent: Sent[] = [];
  const failed = dependencies({
    model: harness.model,
    answers: ["error", { text: DONE }],
    sent: failedSent,
    prefix: () => ledger.latest(CHAT_ID),
  });
  const recovered = await reviewGoal(failed.deps, { goal, allowWait: false, signal: open() });
  assert.equal(recovered.kind === "verdict" && recovered.via, "isolated");
  assert.deepEqual(
    failedSent.map((request) => request.options?.cacheRetention),
    ["short", "none"],
  );
  assert.deepEqual(
    failed.usage.map((record) => record.source),
    ["goal-review", "goal-review"],
  );

  const timedSent: Sent[] = [];
  const timed = dependencies({
    model: harness.model,
    answers: ["timeout"],
    sent: timedSent,
    prefix: () => ledger.latest(CHAT_ID),
  });
  assert.deepEqual(await reviewGoal(timed.deps, { goal, allowWait: false, signal: open() }), {
    kind: "unusable",
    why: "failed",
    via: "continuation",
  });
  assert.equal(timedSent.length, 1);

  const thrownSent: Sent[] = [];
  const thrown = dependencies({
    model: harness.model,
    answers: ["throw"],
    sent: thrownSent,
    prefix: async () => undefined,
  });
  assert.deepEqual(await reviewGoal(thrown.deps, { goal, allowWait: false, signal: open() }), {
    kind: "unusable",
    why: "failed",
    via: "isolated",
  });
  assert.deepEqual(
    thrown.usage.map((record) => [record.source, record.status]),
    [["goal-review", "failed"]],
  );
});

test("over the spending limit nothing is sent", async () => {
  const { harness, ledger } = await chatTurn();
  const sent: Sent[] = [];
  const { deps, usage } = dependencies({
    model: harness.model,
    answers: [{ text: DONE }],
    sent,
    prefix: () => ledger.latest(CHAT_ID),
    refusal: "This chat reached its spending limit.",
  });
  assert.deepEqual(await reviewGoal(deps, { goal, allowWait: false, signal: open() }), {
    kind: "refused",
    message: "This chat reached its spending limit.",
  });
  assert.equal(sent.length, 0);
  assert.equal(usage.length, 0);
});

test("a cancelled review sends nothing more", async () => {
  const { harness, ledger } = await chatTurn();
  const controller = new AbortController();
  controller.abort();
  const sent: Sent[] = [];
  const { deps } = dependencies({
    model: harness.model,
    answers: [{ text: DONE }],
    sent,
    prefix: () => ledger.latest(CHAT_ID),
  });
  assert.deepEqual(await reviewGoal(deps, { goal, allowWait: false, signal: controller.signal }), {
    kind: "cancelled",
  });
  assert.equal(sent.length, 0);
});

test("a chat that thinks keeps its thinking, and the review's cap makes room for it", async () => {
  const { harness, ledger, parent } = await chatTurn("high");
  // The same model the chat's request went to, so its cached prefix matches.
  const thinking = { ...harness.model, reasoning: true } as Model<Api>;
  const sent: Sent[] = [];
  const { deps } = dependencies({
    model: thinking,
    answers: [{ text: DONE }],
    sent,
    prefix: () => ledger.latest(CHAT_ID),
  });
  const outcome = await reviewGoal(deps, { goal, allowWait: false, signal: open() });
  assert.equal(outcome.kind === "verdict" && outcome.via, "continuation");
  assert.equal(
    sent[0]!.options?.reasoning,
    "high",
    "the chat's thinking level is replayed unchanged",
  );
  assert.equal(sent[0]!.options?.maxTokens, Math.min(400 + 16_384, thinking.maxTokens));
  assert.ok((sent[0]!.options?.maxTokens ?? 0) > 400, "more than the bare 400");
  const review = await harness.record(sent[0]!.context, { turn: 2, step: 1 });
  assert.equal(comparePromptRequests(parent, review).wire, undefined);
});

test("the review's output cap", () => {
  const model = { maxTokens: 64_000 };
  assert.equal(goalReviewMaxTokens({}, model), 400, "no thinking: 400");
  assert.equal(goalReviewMaxTokens({ reasoning: "low" }, model), 400 + 2_048);
  assert.equal(
    goalReviewMaxTokens({ reasoning: "medium", thinkingBudgets: { medium: 4_000 } }, model),
    4_400,
    "the chat's own budget",
  );
  assert.equal(
    goalReviewMaxTokens({ reasoning: "xhigh" }, model),
    400 + 16_384,
    "bounded at the high budget",
  );
  assert.equal(
    goalReviewMaxTokens({ reasoning: "high", thinkingBudgets: { high: 100_000 } }, model),
    400 + 16_384,
    "a huge budget is bounded",
  );
  assert.equal(
    goalReviewMaxTokens({ reasoning: "high" }, { maxTokens: 8_192 }),
    8_192,
    "never above the model's cap",
  );
});
