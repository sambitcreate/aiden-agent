// Compaction on the chat's cached prefix (docs/plans/prompt-cache-hit-rate.md,
// phase 5). Real chat turns run through the prompt prefix harness with the
// side-call ledger on their stream, and the real coordinator writes the
// summary through a scripted summarizer: the summary request must extend the
// parent's last request byte for byte, a chat with memory facts sends the
// isolated request instead, no memory fact may reach the stored summary even
// when the summarizer echoes one, and a summary written in the background is
// stored only when compaction comes due on a chat that was only appended to.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Models, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { assembleChatPrompt, buildWorkspaceChatBasePrompt } from "./chat-prompt-assembly.js";
import { chatPromptGenerationStopped, forgetChatPromptCacheState } from "./chat-prompt-cache-state.js";
import {
  chatCompactionPrecomputes,
  createCompactionPrecomputes,
  precomputeWithinSpendingLimit,
  type CompactionPrecomputeClock,
  type CompactionPrecomputes,
  type CompactionPrecomputeSnapshot,
} from "./compaction-precompute.js";
import { approvedMemoryFactLines, createMemoryExtension } from "./memory-context.js";
import type { MemoryFact, MemoryScope, MemoryStore } from "./memory-store.js";
import type { PiCompactionCoordinatorOptions, PiCompactionEvent } from "./pi-compaction-core.js";
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
import { SpendingService } from "./spending-service.js";
import { preCompactCompactionOptions, type WorkspaceChatHooks } from "./workspace-chat-hooks.js";

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

type CompactionOptions = Partial<Omit<PiCompactionCoordinatorOptions, "session">>;

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

  test("writes the short cache even when the parent paid for a longer one", async () => {
    const chat = compactingChat();
    await twoTurns(chat);
    const summary = summarizer(() => SUMMARY);
    const longRetention = async () => {
      const prefix = await chat.cachedPrefix();
      return prefix && { ...prefix, options: { ...prefix.options, cacheRetention: "long" as const } };
    };
    chat.compaction.current = { models: summary.models, settings: TRIGGER_NOW, cachedPrefix: longRetention, approvedMemoryFacts: chat.approvedMemoryFacts };
    await chat.harness.turn({ prompt: "Thanks.", systemPrompt: "You are Aiden.", tools: [listFiles], responses: [fauxAssistantMessage("Sure.")] });

    assert.equal(summary.calls.length, 1);
    assert.ok(textOf(summary.calls[0]!.context).includes("write a checkpoint summary"), "the cached request was sent");
    assert.equal(summary.calls[0]!.options?.cacheRetention, "short");
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

  /** Every summary request was Pi's isolated one: no cached continuation, no cache written. */
  function assertIsolated(calls: readonly SummaryCall[]): void {
    assert.ok(calls.length >= 1, "the chat compacted");
    for (const call of calls) {
      assert.notEqual(call.options?.cacheRetention, "short", "the isolated request writes no cache");
      assert.equal(textOf(call.context).includes("write a checkpoint summary"), false, "no cached continuation was sent");
      assert.equal(textOf(call.context).toLowerCase().includes(FACT_TEXT), false, "the isolated request is not told the fact");
    }
  }

  test("a chat whose prefix states a fact sends the isolated request even though the ledger matches", async () => {
    const chat = compactingChat({ lines: [FACT] });
    await twoTurns(chat, withFact);
    assert.ok(await chat.cachedPrefix(), "the ledger holds a prefix the summary could continue");
    const summary = summarizer(() => `${SUMMARY}\n\n## Constraints & Preferences\n${FACT}\n- The user prefers tabs over spaces.`);
    chat.compaction.current = { models: summary.models, settings: TRIGGER_NOW, cachedPrefix: chat.cachedPrefix, approvedMemoryFacts: chat.approvedMemoryFacts };
    await chat.harness.turn({ prompt: "Thanks.", systemPrompt: withFact, tools: [listFiles], responses: [fauxAssistantMessage("Sure.")] });

    assertIsolated(summary.calls);
    const [entry] = await compactions(chat.harness);
    assert.ok(entry);
    assert.match(entry.summary, /List the workspace files\./u, "the rest of the summary is kept");
    assert.equal(entry.summary.toLowerCase().includes(FACT_TEXT), false);
    assert.equal(entry.summary.includes("[memory:"), false);
  });

  test("a chat that may be told a fact sends the isolated request even when its prefix states none", async () => {
    const chat = compactingChat({ lines: [FACT] });
    await twoTurns(chat);
    assert.ok(await chat.cachedPrefix(), "the ledger holds a prefix the summary could continue");
    const summary = summarizer(() => SUMMARY);
    chat.compaction.current = { models: summary.models, settings: TRIGGER_NOW, cachedPrefix: chat.cachedPrefix, approvedMemoryFacts: chat.approvedMemoryFacts };
    await chat.harness.turn({ prompt: "Thanks.", systemPrompt: "You are Aiden.", tools: [listFiles], responses: [fauxAssistantMessage("Sure.")] });

    assertIsolated(summary.calls);
    assert.equal((await compactions(chat.harness)).length, 1);
  });

  test("a summary that still restates a fact is not stored", async () => {
    const chat = compactingChat({ lines: [FACT] });
    await twoTurns(chat, withFact);
    const summary = summarizer(() => `${SUMMARY}\n- Prefers tabs\nover spaces.`);
    chat.compaction.current = { models: summary.models, settings: TRIGGER_NOW, cachedPrefix: chat.cachedPrefix, approvedMemoryFacts: chat.approvedMemoryFacts };
    await assert.rejects(
      chat.harness.turn({ prompt: "Thanks.", systemPrompt: withFact, tools: [listFiles], responses: [fauxAssistantMessage("Sure.")] }),
      /provider_failed/u,
    );
    assertIsolated(summary.calls);
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

/** The text of each message in a stored kept tail, in order. */
function tailTexts(messages: readonly unknown[]): string[] {
  return messages.map((message) => {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    return (Array.isArray(content) ? content : [])
      .flatMap((part: { type?: string; text?: string }) => (part.type === "text" && part.text ? [part.text] : []))
      .join("");
  });
}

describe("a summary written in the background", () => {
  // The faux chat's context after each turn here is about 63, 77 and 87
  // tokens. These triggers put the first turn past the share that starts a
  // summary and say which later turn makes compaction due.
  interface PrecomputeOptions {
    attended?: () => boolean | Promise<boolean>;
    approved?: { lines: readonly string[] };
    /** Context tokens at which compaction is due. */
    trigger?: number;
    fraction?: number;
    replies?: (index: number, call: SummaryCall) => string | Promise<string>;
    extra?: CompactionOptions;
    /** Whether to wait for the summary the first turn starts. */
    wait?: boolean;
  }

  async function precomputingChat(options: PrecomputeOptions = {}) {
    const approved = options.approved ?? { lines: [] };
    const chat = compactingChat(approved);
    const registry = createCompactionPrecomputes({ clock: manualClock() });
    const summary = summarizer(options.replies ?? (() => SUMMARY));
    const attended = { now: true };
    const events: PiCompactionEvent[] = [];
    chat.compaction.current = {
      models: summary.models,
      cachedPrefix: chat.cachedPrefix,
      approvedMemoryFacts: async () => approved.lines,
      settings: { enabled: true, reserveTokens: 128_000 - (options.trigger ?? 80), keepRecentTokens: 5 },
      precompute: { registry, chatKey: CHAT_ID, allowed: options.attended ?? (() => attended.now), fraction: options.fraction ?? 0.5 },
      onEvent: (event) => events.push(event),
      ...options.extra,
    };
    await chat.harness.turn({
      prompt: "Which files are there?",
      systemPrompt: "You are Aiden.",
      tools: [listFiles],
      responses: [fauxAssistantMessage(fauxToolCall("list_files", {})), fauxAssistantMessage("Two: a.ts and b.ts.")],
    });
    if (options.wait !== false) await settled(registry);
    return { chat, registry, summary, attended, events };
  }

  const nextTurn = (chat: ReturnType<typeof compactingChat>, prompt = "And which is bigger?") =>
    chat.harness.turn({ prompt, systemPrompt: "You are Aiden.", tools: [listFiles], responses: [fauxAssistantMessage("b.ts is bigger.")] });
  const thirdTurn = (chat: ReturnType<typeof compactingChat>) =>
    chat.harness.turn({ prompt: "Thanks.", systemPrompt: "You are Aiden.", tools: [listFiles], responses: [fauxAssistantMessage("You're welcome.")] });

  test("is kept below the trigger and stored, with everything after it, once compaction comes due", async () => {
    const { chat, registry, summary, events } = await precomputingChat();
    assert.equal(summary.calls.length, 1, "the summary started when the turn ended");
    assert.equal(summary.calls[0]!.options?.cacheRetention, "short");
    assert.ok(registry.has(CHAT_ID) && !registry.running(CHAT_ID), "the summary is ready before the next turn");

    await nextTurn(chat);
    assert.deepEqual(await compactions(chat.harness), [], "below the trigger nothing is stored");
    assert.equal(summary.calls.length, 1, "a usable summary is not written again");
    assert.ok(registry.has(CHAT_ID));

    await thirdTurn(chat);
    assert.equal(summary.calls.length, 1, "the due compaction stored it without another request");
    const [entry] = await compactions(chat.harness);
    assert.ok(entry, "the background summary is stored");
    assert.match(entry.summary, /List the workspace files\./u);
    assert.deepEqual(
      tailTexts(entry.retainedTail),
      ["Two: a.ts and b.ts.", "And which is bigger?", "b.ts is bigger.", "Thanks.", "You're welcome."],
      "the kept tail is the summary's own tail and every message after it",
    );
    assert.deepEqual(events.map((event) => event.type), ["start", "end"]);
    assert.equal(registry.has(CHAT_ID), false);

    const [after] = await chat.harness.turn({ prompt: "Go on.", systemPrompt: "You are Aiden.", tools: [listFiles], responses: [fauxAssistantMessage("Done.")] });
    assert.ok(after!.carries("List the workspace files."), "the next request reads the summary");
    assert.ok(after!.carries("You're welcome."), "and the kept tail");
  });

  test("a follow-up while it is being written does not abort it", async () => {
    let finish: (text: string) => void = () => {};
    const { chat, registry, summary } = await precomputingChat({
      wait: false,
      replies: () => new Promise<string>((resolve) => { finish = resolve; }),
    });
    assert.equal(summary.calls.length, 1);
    await nextTurn(chat);
    assert.equal(summary.calls[0]!.options?.signal?.aborted, false, "the follow-up left the summary running");
    assert.ok(registry.running(CHAT_ID));
    assert.equal(summary.calls.length, 1, "no second summary was started");

    finish(SUMMARY);
    await settled(registry);
    await thirdTurn(chat);
    assert.equal(summary.calls.length, 1);
    const [entry] = await compactions(chat.harness);
    assert.ok(entry);
    assert.match(entry.summary, /List the workspace files\./u);
  });

  test("is discarded when the chat changed other than by an append", async () => {
    const { chat, registry, attended } = await precomputingChat();
    assert.ok(registry.has(CHAT_ID));
    attended.now = false;
    // Regenerating the reply moves the journal back before it.
    const journal = await chat.harness.journal();
    const branch = await journal.getBranch();
    await journal.moveTo(branch[branch.length - 2]!.id);
    await nextTurn(chat);
    assert.equal(registry.has(CHAT_ID), false);
    assert.deepEqual(await compactions(chat.harness), []);
  });

  test("is discarded when the chat's model changed", async () => {
    const { chat, registry, attended } = await precomputingChat();
    assert.ok(registry.has(CHAT_ID));
    attended.now = false;
    chat.compaction.current = { ...chat.compaction.current, model: { ...chat.harness.model, id: "another-model" } };
    await nextTurn(chat);
    assert.equal(registry.has(CHAT_ID), false);
  });

  test("is discarded when the approved memory facts changed", async () => {
    const approved = { lines: [] as readonly string[] };
    const { chat, registry, summary, attended } = await precomputingChat({ approved });
    assert.equal(summary.calls.length, 1);
    attended.now = false;
    approved.lines = ["- [memory:m1] Prefers short answers."];
    await nextTurn(chat);
    assert.deepEqual(await compactions(chat.harness), []);
    assert.equal(registry.has(CHAT_ID), false);
  });

  test("that no longer fits the kept tail is dropped without a word, and the chat compacts as usual", async () => {
    // A summary starts at 80% of the trigger, so its tail may grow by 20%.
    const { chat, registry, summary, events } = await precomputingChat({ trigger: 70, fraction: 0.8 });
    assert.equal(summary.calls.length, 1);
    await nextTurn(chat, "And which is bigger? Compare a.ts and b.ts by size in bytes, line count and the number of exported functions.");

    assert.equal(summary.calls.length, 2, "the due compaction wrote a fresh summary");
    assert.equal((await compactions(chat.harness)).length, 1);
    assert.deepEqual(events.map((event) => event.type), ["start", "end"], "one compaction, no failure in between");
    const end = events[1] as Extract<PiCompactionEvent, { type: "end" }>;
    assert.equal(end.errorMessage, undefined);
    assert.ok(end.result);
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

  test("is never started for a chat over its spending limit", async () => {
    const spending = new SpendingService({
      persistence: { load: async () => undefined, save: async () => {} },
      settings: async () => ({ chatUsd: 1 }),
      broadcast: () => {},
    });
    const over = { kind: "chat", id: "over" } as const;
    const under = { kind: "chat", id: "under" } as const;
    await spending.record(over, 1.5);

    const capped = await precomputingChat({ attended: () => precomputeWithinSpendingLimit(spending, over) });
    assert.equal(capped.summary.calls.length, 0, "no summary request past the limit");
    assert.equal(capped.registry.has(CHAT_ID), false);

    const allowed = await precomputingChat({ attended: () => precomputeWithinSpendingLimit(spending, under) });
    assert.equal(allowed.summary.calls.length, 1, "a chat under its limit still writes one");
  });

  describe("with chat hooks", () => {
    const hooks = (events: readonly string[]) =>
      ({ has: (event: string) => events.includes(event), dispatch: async () => ({}) }) as unknown as Pick<WorkspaceChatHooks, "has" | "dispatch">;

    test("is started when no PreCompact hook is configured", async () => {
      const { summary } = await precomputingChat({ extra: preCompactCompactionOptions(hooks(["Stop"]), "auto") });
      assert.equal(summary.calls.length, 1);
    });

    test("is never started while a PreCompact hook is configured", async () => {
      const { chat, summary, registry } = await precomputingChat({ extra: preCompactCompactionOptions(hooks(["PreCompact"]), "auto") });
      assert.equal(summary.calls.length, 0, "the hook speaks at compaction time, so nothing is written early");
      assert.equal(registry.has(CHAT_ID), false);
      await nextTurn(chat);
      assert.equal(summary.calls.length, 0);
    });
  });
});

describe("the background summary registry", () => {
  const snapshot = (contextKey = "context-1"): CompactionPrecomputeSnapshot => ({
    branchIds: ["entry-1"], contextKey, contextLength: 1, modelKey: "model-1", memoryKey: "memory-1",
  });
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

  test("hands out a finished summary once, with the snapshot it was written for", async () => {
    const registry = createCompactionPrecomputes({ clock: manualClock() });
    registry.start(CHAT_ID, snapshot(), async () => result("one"));
    assert.equal(registry.current(CHAT_ID)?.contextKey, "context-1", "a running summary has its snapshot");
    await settled(registry);
    const taken = registry.take(CHAT_ID);
    assert.equal(taken?.result.summary, "one");
    assert.equal(taken?.snapshot.contextKey, "context-1");
    assert.equal(registry.take(CHAT_ID), undefined, "a summary is applied once");
    assert.equal(registry.current(CHAT_ID), undefined);
  });

  test("a summary still being written is aborted, not awaited", async () => {
    const registry = createCompactionPrecomputes({ clock: manualClock() });
    const run = pending();
    registry.start(CHAT_ID, snapshot(), run.run);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(registry.take(CHAT_ID), undefined);
    assert.equal(run.signal()?.aborted, true);
    run.finish(result("late"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(registry.has(CHAT_ID), false, "a run that finishes after being dropped leaves nothing");
  });

  test("keeps one summary per chat: a new one replaces and aborts the old", async () => {
    const registry = createCompactionPrecomputes({ clock: manualClock() });
    const first = pending();
    registry.start(CHAT_ID, snapshot(), first.run);
    await new Promise((resolve) => setImmediate(resolve));
    const replacement = pending();
    registry.start(CHAT_ID, snapshot("context-2"), replacement.run);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(first.signal()?.aborted, true, "the summary for the older state is aborted");
    assert.equal(registry.current(CHAT_ID)?.contextKey, "context-2");
    first.finish(result("late"));
    replacement.finish(result("current"));
    await settled(registry);
    assert.equal(registry.take(CHAT_ID)?.result.summary, "current", "the aborted run's late result is dropped");
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

  test("stopping the chat's turn aborts its summary", async () => {
    const run = pending();
    chatCompactionPrecomputes.start(CHAT_ID, snapshot(), run.run);
    await new Promise((resolve) => setImmediate(resolve));
    chatPromptGenerationStopped(CHAT_ID);
    assert.equal(run.signal()?.aborted, true);
    assert.equal(chatCompactionPrecomputes.has(CHAT_ID), false);
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
