// Compaction on the chat's cached prefix (docs/plans/prompt-cache-hit-rate.md,
// phase 5). Real chat turns run through the prompt prefix harness with the
// side-call ledger on their stream, and the real coordinator writes the
// summary through a scripted summarizer: the summary request must extend the
// parent's last request byte for byte, no memory fact may reach the stored
// summary even when the summarizer echoes one, and a summary written in the
// background is applied only when the chat has not moved.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Models, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { assembleChatPrompt, buildWorkspaceChatBasePrompt } from "./chat-prompt-assembly.js";
import { forgetChatPromptCacheState } from "./chat-prompt-cache-state.js";
import {
  chatCompactionPrecomputes,
  createCompactionPrecomputes,
  type CompactionPrecomputeClock,
  type CompactionPrecomputes,
  type CompactionPrecomputeSnapshot,
} from "./compaction-precompute.js";
import { approvedMemoryFactLines, createMemoryExtension } from "./memory-context.js";
import type { MemoryFact, MemoryScope, MemoryStore } from "./memory-store.js";
import type { PiCompactionCoordinatorOptions } from "./pi-compaction-core.js";
import type { CompactResult } from "./pi-legacy-harness.js";
import type { PiSessionEntry } from "./pi-session-port.js";
import {
  comparePromptRequests,
  createPromptPrefixHarness,
  type PromptPrefixChatState,
  type PromptProviderContext,
  type RecordedPromptRequest,
} from "./prompt-prefix-harness.js";
import { createSideCallPrefixLedger, withSideCallPrefixLedger, type ApprovedMemoryFacts } from "./side-call-prefix.js";

const CHAT_ID = "chat-compaction";
const LIVE_TTL = () => 300_000;
/** Compaction settings whose trigger every turn crosses on the faux model's window. */
const TRIGGER_NOW = { enabled: true, reserveTokens: 127_990, keepRecentTokens: 5 };
const SUMMARY = "## Goal\nList the workspace files.\n\n## Progress\n### Done\n- [x] Listed a.ts and b.ts.";

const listFiles: AgentTool = {
  name: "list_files",
  label: "List files",
  description: "List the files in the workspace.",
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "a.ts\nb.ts" }], details: undefined }),
};

interface SummaryCall {
  context: PromptProviderContext;
  options?: SimpleStreamOptions;
}

/** A summarizer whose `index`th reply is `replies(index)`; every request is kept. */
function summarizer(replies: (index: number, call: SummaryCall) => string | Promise<string>) {
  const calls: SummaryCall[] = [];
  const models = {
    completeSimple: async (target: { api: string; provider: string; id: string }, context: PromptProviderContext, options?: SimpleStreamOptions) => {
      const call = { context, ...(options ? { options } : {}) };
      calls.push(call);
      const text = await replies(calls.length - 1, call);
      return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: target.api,
        provider: target.provider,
        model: target.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      } satisfies AssistantMessage;
    },
  } as unknown as Models;
  return { models, calls };
}

type CompactionOptions = Partial<Omit<PiCompactionCoordinatorOptions, "session" | "model">>;

/** A chat whose stream feeds the side-call ledger and whose compaction options a test changes between turns. */
function compactingChat(approved: { lines: readonly string[] } = { lines: [] }) {
  const ledger = createSideCallPrefixLedger({ ttlMs: LIVE_TTL });
  const approvedMemoryFacts: ApprovedMemoryFacts = async () => approved.lines;
  const compaction: { current: CompactionOptions } = { current: { settings: { enabled: false } } };
  const harness = createPromptPrefixHarness({
    wrapStream: (streamFn) => withSideCallPrefixLedger(streamFn, { ledger, chatKey: CHAT_ID, approvedMemoryFacts }),
    compaction: () => compaction.current,
  });
  const cachedPrefix = () => ledger.latest(CHAT_ID);
  return { harness, ledger, compaction, cachedPrefix, approvedMemoryFacts };
}

const textOf = (value: unknown) => JSON.stringify(value);

async function compactions(harness: ReturnType<typeof createPromptPrefixHarness>) {
  return (await (await harness.journal()).getEntries()).filter(
    (entry): entry is Extract<PiSessionEntry, { type: "compaction" }> => entry.type === "compaction",
  );
}

/** Two turns that list files, with compaction off; returns the last request of the second. */
async function twoTurns(chat: ReturnType<typeof compactingChat>, systemPrompt = "You are Aiden.") {
  await chat.harness.turn({
    prompt: "Which files are there?",
    systemPrompt,
    tools: [listFiles],
    responses: [fauxAssistantMessage(fauxToolCall("list_files", {})), fauxAssistantMessage("Two: a.ts and b.ts.")],
  });
  const second = await chat.harness.turn({
    prompt: "And which is bigger?",
    systemPrompt,
    tools: [listFiles],
    responses: [fauxAssistantMessage("b.ts is bigger.")],
  });
  return second[second.length - 1]!;
}

function assertExtends(parent: RecordedPromptRequest, summary: RecordedPromptRequest): void {
  assert.equal(summary.wire[0]?.kind, "tools", "the summary request keeps the parent's tools declared");
  assert.deepEqual(comparePromptRequests(parent, summary).wire, undefined, "the summary request extends the parent's request");
  assert.ok(summary.wire.length > parent.wire.length, "the summary request appends after the parent's request");
}

describe("a summary written on the cached prefix", () => {
  test("is one request that extends the parent's last request byte for byte, at short retention", async () => {
    const chat = compactingChat();
    const parent = await twoTurns(chat);
    const summary = summarizer(() => SUMMARY);
    chat.compaction.current = { models: summary.models, settings: TRIGGER_NOW, cachedPrefix: chat.cachedPrefix, approvedMemoryFacts: chat.approvedMemoryFacts };

    const [after] = await chat.harness.turn({ prompt: "Thanks.", systemPrompt: "You are Aiden.", tools: [listFiles], responses: [fauxAssistantMessage("You're welcome.")] });

    assert.equal(summary.calls.length, 1, "the summary is a single request");
    const call = summary.calls[0]!;
    assert.equal(call.options?.cacheRetention, "short");
    const rendered = await chat.harness.record(call.context, { turn: 3, step: 0 });
    assertExtends(parent, rendered);
    assert.ok(rendered.carries("write a checkpoint summary"), "the instruction is the request's last message");
    const [entry] = await compactions(chat.harness);
    assert.ok(entry, "the summary is stored");
    assert.match(entry.summary, /List the workspace files\./u);
    assert.ok(after!.carries("List the workspace files."), "the next request reads the summary");
    assert.equal(chat.harness.networkCalls, 0);
  });

  test("falls back to the isolated request when the chat no longer ends at the cached reply", async () => {
    const chat = compactingChat();
    await twoTurns(chat);
    // A message the ledger never saw: the prefix no longer covers the journal.
    await (await chat.harness.journal()).appendMessage({ role: "user", content: "An edit from elsewhere.", timestamp: Date.now() });
    const summary = summarizer(() => SUMMARY);
    chat.compaction.current = { models: summary.models, settings: TRIGGER_NOW, cachedPrefix: chat.cachedPrefix, approvedMemoryFacts: chat.approvedMemoryFacts };
    await chat.harness.turn({ prompt: "Thanks.", systemPrompt: "You are Aiden.", tools: [listFiles], responses: [fauxAssistantMessage("Sure.")] });
    assert.ok(summary.calls.length >= 1);
    for (const call of summary.calls) {
      assert.notEqual(call.options?.cacheRetention, "short", "the isolated request writes no cache");
      assert.equal(textOf(call.context).includes("write a checkpoint summary"), false);
    }
    assert.equal((await compactions(chat.harness)).length, 1);
  });
});

describe("no memory fact reaches a stored summary", () => {
  const FACT = "- [memory:fact-1] Prefers tabs over spaces.";
  const FACT_TEXT = "tabs over spaces";
  const withFact = `You are Aiden.\n\n${FACT}`;

  test("a summarizer that echoes the fact it was told has it removed before the summary is stored", async () => {
    const chat = compactingChat({ lines: [FACT] });
    await twoTurns(chat, withFact);
    const summary = summarizer(() => `${SUMMARY}\n\n## Constraints & Preferences\n${FACT}\n- The user prefers tabs over spaces.`);
    chat.compaction.current = { models: summary.models, settings: TRIGGER_NOW, cachedPrefix: chat.cachedPrefix, approvedMemoryFacts: chat.approvedMemoryFacts };
    await chat.harness.turn({ prompt: "Thanks.", systemPrompt: withFact, tools: [listFiles], responses: [fauxAssistantMessage("Sure.")] });

    assert.equal(summary.calls[0]!.options?.cacheRetention, "short", "the cached request was the one answered");
    const [entry] = await compactions(chat.harness);
    assert.ok(entry);
    assert.match(entry.summary, /List the workspace files\./u, "the rest of the summary is kept");
    assert.equal(entry.summary.toLowerCase().includes(FACT_TEXT), false);
    assert.equal(entry.summary.includes("[memory:"), false);
  });

  test("a fact the cached reply restates across lines sends the isolated request instead, without the fact", async () => {
    const chat = compactingChat({ lines: [FACT] });
    await twoTurns(chat, withFact);
    const summary = summarizer((index) => index === 0 ? `${SUMMARY}\n- Prefers tabs\nover spaces.` : SUMMARY);
    chat.compaction.current = { models: summary.models, settings: TRIGGER_NOW, cachedPrefix: chat.cachedPrefix, approvedMemoryFacts: chat.approvedMemoryFacts };
    await chat.harness.turn({ prompt: "Thanks.", systemPrompt: withFact, tools: [listFiles], responses: [fauxAssistantMessage("Sure.")] });

    assert.equal(summary.calls.length, 2);
    assert.notEqual(summary.calls[1]!.options?.cacheRetention, "short");
    assert.equal(textOf(summary.calls[1]!.context).toLowerCase().includes(FACT_TEXT), false, "the isolated request is not told the fact");
    const [entry] = await compactions(chat.harness);
    assert.ok(entry);
    assert.equal(entry.summary.toLowerCase().includes(FACT_TEXT), false);
  });

  test("a summary that still restates a fact on every path is not stored", async () => {
    const chat = compactingChat({ lines: [FACT] });
    await twoTurns(chat, withFact);
    const summary = summarizer(() => `${SUMMARY}\n- Prefers tabs\nover spaces.`);
    chat.compaction.current = { models: summary.models, settings: TRIGGER_NOW, cachedPrefix: chat.cachedPrefix, approvedMemoryFacts: chat.approvedMemoryFacts };
    await assert.rejects(
      chat.harness.turn({ prompt: "Thanks.", systemPrompt: withFact, tools: [listFiles], responses: [fauxAssistantMessage("Sure.")] }),
      /provider_failed/u,
    );
    assert.equal(summary.calls.length, 2);
    assert.deepEqual(await compactions(chat.harness), []);
  });

  describe("a forgotten fact", () => {
    const scope: MemoryScope = { kind: "workspace", id: "workspace-1" };
    const fact = (id: string, text: string): MemoryFact => ({
      id, scope, text, provenance: { kind: "user_edit", sourceId: id }, createdAt: 1, updatedAt: 1,
      confidence: 1, reviewState: "approved", state: "active", alwaysOn: true,
    });
    const store = (facts: MemoryFact[]) => ({
      alwaysOn: async () => facts.slice(0, 6),
      list: async () => facts,
      recall: async () => [],
    }) as unknown as MemoryStore;
    async function memoryChat(facts: MemoryFact[]): Promise<{ chatState: PromptPrefixChatState; approved: string[] }> {
      const extensions = [await createMemoryExtension({ store: store(facts), scope })];
      const chatState: PromptPrefixChatState = {
        branch: "main",
        permission: "ask",
        extensions,
        assembly: async (head) => {
          const base = await buildWorkspaceChatBasePrompt({
            folderPath: "/workspace/project",
            branch: head.branch ?? "main",
            permission: head.permission,
            tools: [listFiles, ...head.extensions.flatMap((extension) => extension.tools ?? [])],
          });
          return assembleChatPrompt({
            basePrompt: base.systemPrompt,
            ...(base.skills ? { baseSkills: base.skills } : {}),
            tools: [listFiles],
            resources: {},
            extensions: head.extensions,
            allowOnDemandTools: true,
          });
        },
      };
      return { chatState, approved: await approvedMemoryFactLines(extensions) };
    }

    test("is in no summary request, no stored summary and no later request", async () => {
      const m1 = fact("m1", "Prefers short answers.");
      const m2 = fact("m2", "Uses pnpm.");
      const forgotten = "Uses pnpm.";
      const approved = { lines: [] as readonly string[] };
      const chat = compactingChat(approved);
      const turn = async (prompt: string, facts: MemoryFact[]) => {
        const { chatState, approved: lines } = await memoryChat(facts);
        approved.lines = lines;
        return chat.harness.turn({ prompt, chatState, responses: [fauxAssistantMessage("Done.")] });
      };
      await turn("Start.", [m1]);
      const [learned] = await turn("Remember this.", [m1, m2]);
      assert.ok(learned!.carries(forgotten), "the fact reaches the request before the forget");

      // The summarizer repeats every memory line it is sent, and the facts the chat may still be told.
      const summary = summarizer(async (_index, call) => {
        const echoed = textOf(call.context).match(/- \[memory:[^\]]+\][^\\]*/gu) ?? [];
        return [SUMMARY, ...echoed, ...approved.lines].join("\n");
      });
      chat.compaction.current = { models: summary.models, settings: TRIGGER_NOW, cachedPrefix: chat.cachedPrefix, approvedMemoryFacts: async () => approved.lines };
      const [forgot] = await turn("Forget it.", [m1]);
      chat.compaction.current = { ...chat.compaction.current, settings: { enabled: false } };
      const [later] = await turn("And now?", [m1]);

      assert.ok(summary.calls.length >= 1, "the forget turn compacted");
      for (const call of summary.calls) assert.equal(textOf(call.context).includes(forgotten), false, "a summary request carries the forgotten fact");
      const stored = await compactions(chat.harness);
      assert.ok(stored.length >= 1);
      for (const entry of stored) {
        assert.equal(entry.summary.includes(forgotten), false, "the stored summary states the forgotten fact");
        assert.equal(entry.summary.includes("[memory:"), false, "the stored summary states a memory fact");
      }
      for (const request of [forgot!, later!]) assert.equal(request.carries(forgotten), false, "a later request carries the forgotten fact");
    });
  });
});

/** A clock whose timers run only when the test says. */
function manualClock(): CompactionPrecomputeClock & { fire(): void; pending(): number } {
  const timers = new Map<number, () => void>();
  let next = 0;
  return {
    setTimeout: (callback) => {
      next += 1;
      timers.set(next, callback);
      return next;
    },
    clearTimeout: (timer) => {
      timers.delete(timer as number);
    },
    fire: () => {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    pending: () => timers.size,
  };
}

async function settled(registry: CompactionPrecomputes, chatKey = CHAT_ID): Promise<void> {
  for (let attempt = 0; attempt < 200 && registry.running(chatKey); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("a summary written in the background", () => {
  async function precomputingChat(options: { attended?: () => boolean; approved?: { lines: readonly string[] } } = {}) {
    const approved = options.approved ?? { lines: [] };
    const chat = compactingChat(approved);
    const registry = createCompactionPrecomputes({ clock: manualClock() });
    const summary = summarizer(() => SUMMARY);
    const attended = { now: true };
    chat.compaction.current = {
      models: summary.models,
      cachedPrefix: chat.cachedPrefix,
      approvedMemoryFacts: async () => approved.lines,
      // No turn here reaches the default trigger, every turn passes this share
      // of it, and nearly all of the chat is old enough to summarize.
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 5 },
      precompute: { registry, chatKey: CHAT_ID, allowed: options.attended ?? (() => attended.now), fraction: 0.0001 },
    };
    await chat.harness.turn({
      prompt: "Which files are there?",
      systemPrompt: "You are Aiden.",
      tools: [listFiles],
      responses: [fauxAssistantMessage(fauxToolCall("list_files", {})), fauxAssistantMessage("Two: a.ts and b.ts.")],
    });
    await settled(registry);
    return { chat, registry, summary, attended };
  }

  const nextTurn = (chat: ReturnType<typeof compactingChat>) =>
    chat.harness.turn({ prompt: "And which is bigger?", systemPrompt: "You are Aiden.", tools: [listFiles], responses: [fauxAssistantMessage("b.ts is bigger.")] });

  test("is applied at the next turn when the chat has not moved", async () => {
    const { chat, registry, summary, attended } = await precomputingChat();
    assert.equal(summary.calls.length, 1, "the summary started when the turn ended");
    assert.equal(summary.calls[0]!.options?.cacheRetention, "short");
    assert.ok(registry.has(CHAT_ID) && !registry.running(CHAT_ID), "the summary is ready before the next turn");
    // No later turn starts another one.
    attended.now = false;

    const [next] = await nextTurn(chat);
    assert.equal(summary.calls.length, 1, "the next turn applied it without another request");
    const [entry] = await compactions(chat.harness);
    assert.ok(entry, "the background summary is stored at the turn boundary");
    assert.match(entry.summary, /List the workspace files\./u);
    assert.ok(next!.carries("List the workspace files."));
    assert.equal(registry.has(CHAT_ID), false);
  });

  test("is discarded when a message arrived after it started", async () => {
    const { chat, registry, summary, attended } = await precomputingChat();
    attended.now = false;
    await (await chat.harness.journal()).appendMessage({ role: "user", content: "Sent from another device.", timestamp: Date.now() });
    const [next] = await nextTurn(chat);
    assert.equal(summary.calls.length, 1);
    assert.deepEqual(await compactions(chat.harness), [], "a summary for an older chat is not stored");
    assert.equal(next!.carries("List the workspace files."), false);
    assert.equal(registry.has(CHAT_ID), false);
  });

  test("is discarded when the approved memory facts changed", async () => {
    const approved = { lines: ["- [memory:m1] Prefers short answers."] as readonly string[] };
    const { chat, registry, summary, attended } = await precomputingChat({ approved });
    assert.equal(summary.calls.length, 1);
    attended.now = false;
    approved.lines = [];
    await nextTurn(chat);
    assert.deepEqual(await compactions(chat.harness), []);
    assert.equal(registry.has(CHAT_ID), false);
  });

  test("is never started for a chat nobody is attending", async () => {
    const { chat, registry, summary } = await precomputingChat({ attended: () => false });
    assert.equal(summary.calls.length, 0, "no summary request for an idle chat");
    assert.equal(registry.has(CHAT_ID), false);
    await nextTurn(chat);
    assert.equal(summary.calls.length, 0);
    assert.deepEqual(await compactions(chat.harness), []);
  });
});

describe("the background summary registry", () => {
  const snapshot = (contextKey = "context-1"): CompactionPrecomputeSnapshot => ({ contextKey, modelKey: "model-1", memoryKey: "memory-1" });
  const result = (summary: string): CompactResult => ({ summary, tokensBefore: 10, retainedTail: [] } as unknown as CompactResult);

  function pending() {
    let signal: AbortSignal | undefined;
    let finish: (value: CompactResult | undefined) => void = () => {};
    const run = (given: AbortSignal) => {
      signal = given;
      return new Promise<CompactResult | undefined>((resolve) => { finish = resolve; });
    };
    return { run, signal: () => signal, finish: (value: CompactResult | undefined) => finish(value) };
  }

  test("hands out a finished summary once, only for the snapshot it was written for", async () => {
    const registry = createCompactionPrecomputes({ clock: manualClock() });
    registry.start(CHAT_ID, snapshot(), async () => result("one"));
    await settled(registry);
    assert.equal(registry.take(CHAT_ID, snapshot("context-2")), undefined, "a moved chat gets nothing");
    assert.equal(registry.has(CHAT_ID), false, "and the stale summary is gone");

    registry.start(CHAT_ID, snapshot(), async () => result("two"));
    await settled(registry);
    assert.equal(registry.take(CHAT_ID, snapshot())?.summary, "two");
    assert.equal(registry.take(CHAT_ID, snapshot()), undefined, "a summary is applied once");
  });

  test("a summary still being written is aborted, not awaited", async () => {
    const registry = createCompactionPrecomputes({ clock: manualClock() });
    const run = pending();
    registry.start(CHAT_ID, snapshot(), run.run);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(registry.take(CHAT_ID, snapshot()), undefined);
    assert.equal(run.signal()?.aborted, true);
    run.finish(result("late"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(registry.has(CHAT_ID), false, "a run that finishes after being dropped leaves nothing");
  });

  test("keeps one summary per chat: the same snapshot is not started twice, another replaces it", async () => {
    const registry = createCompactionPrecomputes({ clock: manualClock() });
    const first = pending();
    assert.equal(registry.start(CHAT_ID, snapshot(), first.run), true);
    let second = 0;
    assert.equal(registry.start(CHAT_ID, snapshot(), async () => { second += 1; return result("again"); }), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(second, 0, "no second request for the same chat state");
    const replacement = pending();
    assert.equal(registry.start(CHAT_ID, snapshot("context-2"), replacement.run), true);
    assert.equal(first.signal()?.aborted, true, "the summary for the older state is aborted");
  });

  test("drops a summary that outlives its time limit, and the oldest chat past the chat limit", async () => {
    const clock = manualClock();
    const registry = createCompactionPrecomputes({ clock, maxChats: 2 });
    const slow = pending();
    registry.start("chat-1", snapshot(), slow.run);
    await new Promise((resolve) => setImmediate(resolve));
    clock.fire();
    assert.equal(slow.signal()?.aborted, true);
    assert.equal(registry.has("chat-1"), false);

    const runs = ["chat-1", "chat-2", "chat-3"].map((chatKey) => {
      const run = pending();
      registry.start(chatKey, snapshot(), run.run);
      return run;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(registry.has("chat-1"), false, "the oldest chat is dropped");
    assert.equal(runs[0]!.signal()?.aborted, true);
    assert.ok(registry.has("chat-2") && registry.has("chat-3"));
  });

  test("deleting the chat aborts its summary", async () => {
    const run = pending();
    chatCompactionPrecomputes.start(CHAT_ID, snapshot(), run.run);
    await new Promise((resolve) => setImmediate(resolve));
    forgetChatPromptCacheState(CHAT_ID);
    assert.equal(run.signal()?.aborted, true);
    assert.equal(chatCompactionPrecomputes.has(CHAT_ID), false);
  });
});
