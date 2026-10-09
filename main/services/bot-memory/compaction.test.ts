import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, type Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { CompactionEntry, Harness, MemoryStorage, type Conversation, type EntryRecord } from "@earendil-works/pi-durable";
import { BOT_MEMORY_REVIEW_ENTRY_KIND } from "../../../renderer/shared/bot-memory.js";
import { createBotRegistry, type BotCompaction, type BotExtensionDeps } from "../bot-runtime/bot-extension.js";
import { createBotSessionService } from "../bot-runtime/bot-session-service.js";
import { botIngressAllowsTool } from "../bot-runtime/bot-tool-policy.js";
import { fakeMemoryAuthority, recordingDeps } from "../bot-runtime/test-support/fixtures.js";
import { BOT_NOTICE_ENTRY_KIND } from "../bot-runtime/bot-session-service.js";
import { createFauxModels, FAUX_MODEL, FAUX_MODEL_REF, FAUX_PROVIDER, type FauxModels } from "../bot-runtime/test-support/faux.js";
import { BOT_COMPACTION_FOCUS, createBotCompactionSteering } from "./compaction.js";
import { renderBotMemorySection } from "./prompt.js";
import { createBotMemoryService, type BotMemoryRuntime } from "./service.js";
import { createBotMemoryStore } from "./store.js";
import { botMemoryToolEntry, withBotMemoryIngress } from "./tool.js";

const ctx = BACKGROUND_CONTEXT;
const BOT = "bot-1";
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A blocking compaction once a request passes ~300 tokens; ~100 tokens are kept verbatim. */
const SMALL_CONTEXT = { compaction: { reserveTokens: 199_700, keepRecentTokens: 100, backgroundTokens: 0 } };

function memoryProfile() {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-compaction-"));
  roots.push(root);
  mkdirSync(path.join(root, "bots", BOT), { recursive: true });
  const memory = createBotMemoryService({ store: createBotMemoryStore({ profileDir: root }) });
  return { root, memory, userFile: path.join(root, "bots", BOT, "memory", "USER.md") };
}

function systemPromptOf(messages: Message[]): string {
  return getCurrentSystemPrompt(messages) ?? "";
}

function lastUserText(messages: Message[]): string {
  const user = [...messages].reverse().find((message) => message.role === "user");
  if (user === undefined || user.role !== "user") return "";
  return typeof user.content === "string" ? user.content : user.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function harnessFor(memory: BotMemoryRuntime, fauxModels: FauxModels, authority = fakeMemoryAuthority(), settings = SMALL_CONTEXT) {
  let conversation: Conversation | undefined;
  const steering = createBotCompactionSteering({
    memory,
    admit: async () => ({
      ok: true,
      model: { models: fauxModels.models, model: fauxModels.models.getModel(FAUX_PROVIDER, FAUX_MODEL)! },
      lease: authority.lease,
    }),
    reserveTokens: settings.compaction.reserveTokens,
    appendEntry: async (_botId, kind, data) => {
      await conversation!.submit({ type: "write", entry: { kind, data: { ...data } } }, ctx);
    },
  });
  const deps: BotExtensionDeps = {
    ...recordingDeps({ sections: ["<base>B</base>"] }),
    currentTools: async () => [botMemoryToolEntry(BOT, memory)],
    turnAllows: withBotMemoryIngress(botIngressAllowsTool),
    memorySection: async (botId, offer) => renderBotMemorySection(await memory.snapshot(botId), offer),
    beforeCompact: steering,
  };
  const registry = createBotRegistry(BOT, deps);
  await registry.refresh();
  const harness = await Harness.open(new MemoryStorage(), { models: fauxModels.models, registry, settings }, ctx);
  registry.attachHarness(harness);
  conversation = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
  return { harness, conversation };
}

async function allEntries(conversation: Conversation): Promise<EntryRecord[]> {
  const page = await conversation.entries({}, 500, undefined, ctx);
  return [...page.items].reverse();
}

const LONG_INTRO = `I'm Priya. My daughter Mia has piano on Tuesdays and my son Leo swims on Saturdays. ${"We live in Pune and like quiet weekends. ".repeat(40)}`;
const LONG_REPLY = `Got it, Priya. ${"I'll keep Mia's piano and Leo's swimming in mind when planning. ".repeat(30)}`;

test("crossing the threshold flushes memory, steers the summary and refreshes the snapshot", async () => {
  const { memory, userFile } = memoryProfile();
  const requests: Array<{ kind: string; system: string; user: string }> = [];
  const classify = (messages: Message[]) => {
    const system = systemPromptOf(messages);
    if (system.includes("keep a helper Bot's long-term memory")) return "flush";
    if (system.includes("context summarization assistant")) return "summary";
    return "turn";
  };
  const step = (reply: (kind: string) => ReturnType<typeof fauxAssistantMessage>) => (context: { messages: Message[] }) => {
    const kind = classify(context.messages);
    requests.push({ kind, system: systemPromptOf(context.messages), user: lastUserText(context.messages) });
    return reply(kind);
  };
  const fauxModels = createFauxModels([
    step(() => fauxAssistantMessage(LONG_REPLY)),
    step(() =>
      fauxAssistantMessage(
        [fauxToolCall("bot_memory", { target: "user", operations: [{ action: "add", content: "Mia has piano on Tuesdays." }] })],
        { stopReason: "toolUse" },
      ),
    ),
    step(() => fauxAssistantMessage("Done.")),
    step(() => fauxAssistantMessage("STEERED SUMMARY: Priya's kids have piano and swimming.")),
    step(() => fauxAssistantMessage("Sure.")),
  ]);
  const { harness, conversation } = await harnessFor(memory, fauxModels);
  try {
    await (await conversation.submit({ type: "input", content: LONG_INTRO }, ctx)).wait(ctx);
    await (await conversation.submit({ type: "input", content: "What's on this week?" }, ctx)).wait(ctx);

    assert.deepEqual(
      requests.map(({ kind }) => kind),
      ["turn", "flush", "flush", "summary", "turn"],
    );
    assert.match(requests[1]!.user, /Mia has piano on Tuesdays/u, "the flush reads the messages being compacted");
    assert.ok(requests[3]!.user.includes(BOT_COMPACTION_FOCUS), "the summary is steered by the focus");

    assert.equal(readFileSync(userFile, "utf8"), "Mia has piano on Tuesdays.");
    const entries = await allEntries(conversation);
    const marker = entries.find((entry) => entry.kind === BOT_MEMORY_REVIEW_ENTRY_KIND);
    assert.deepEqual(marker?.data, { source: "compaction", added: 1, targets: ["user"] });
    const summary = entries.find((entry) => CompactionEntry.is(entry));
    const summaryText = JSON.stringify(summary?.model);
    assert.match(summaryText, /STEERED SUMMARY/u);

    assert.match(requests[4]!.system, /Mia has piano on Tuesdays\./u, "the first request after compaction carries current memory");
  } finally {
    await harness.close(ctx);
  }
});

test("a failing summarizer falls back to Pi Durable's own summary", async () => {
  const { memory } = memoryProfile();
  const kinds: string[] = [];
  const fauxModels = createFauxModels([
    fauxAssistantMessage(LONG_REPLY),
    // The flush finds nothing worth saving.
    (context) => {
      kinds.push(systemPromptOf(context.messages).includes("long-term memory") ? "flush" : "other");
      return fauxAssistantMessage("NOTHING");
    },
    // The steered summary fails.
    (context) => {
      kinds.push(systemPromptOf(context.messages).includes("context summarization") ? "steered" : "other");
      throw new Error("provider down");
    },
    // Pi Durable summarizes on its own.
    (context) => {
      kinds.push(lastUserText(context.messages).includes(BOT_COMPACTION_FOCUS) ? "steered-again" : "pi");
      return fauxAssistantMessage("PI SUMMARY");
    },
    fauxAssistantMessage("Sure."),
  ]);
  const { harness, conversation } = await harnessFor(memory, fauxModels);
  try {
    await (await conversation.submit({ type: "input", content: LONG_INTRO }, ctx)).wait(ctx);
    await (await conversation.submit({ type: "input", content: "What's on this week?" }, ctx)).wait(ctx);
    assert.deepEqual(kinds, ["flush", "steered", "pi"]);
    const entries = await allEntries(conversation);
    assert.match(JSON.stringify(entries.find((entry) => CompactionEntry.is(entry))?.model), /PI SUMMARY/u);
    assert.equal(entries.some((entry) => entry.kind === BOT_MEMORY_REVIEW_ENTRY_KIND), false, "no add, no marker");
  } finally {
    await harness.close(ctx);
  }
});

const ROUTINE_ANSWER = `ROUTINE BRIEF: ${"Rain is expected in Pune today, carry an umbrella. ".repeat(120)}`;
/** Compacts only once the routine's long answer is in context (~1,500 tokens), so the first compaction is attended. */
const ROUTINE_CONTEXT = { compaction: { reserveTokens: 198_500, keepRecentTokens: 100, backgroundTokens: 0 } };

test("an attended compaction never flushes routine history into memory", async () => {
  const { memory, userFile } = memoryProfile();
  const flushes: string[] = [];
  const turnAnswers = ["Noted.", ROUTINE_ANSWER, "Sure."];
  const fauxModels = createFauxModels(
    Array.from({ length: 12 }, () => (context: { messages: Message[] }) => {
      const system = systemPromptOf(context.messages);
      if (system.includes("keep a helper Bot's long-term memory")) {
        const user = lastUserText(context.messages);
        flushes.push(user);
        // A model that reads routine content would save a fact derived from it.
        return /ROUTINE BRIEF|Morning brief prompt/u.test(user) && flushes.length === 1
          ? fauxAssistantMessage(
              [fauxToolCall("bot_memory", { target: "user", operations: [{ action: "add", content: "Lives where it rains a lot." }] })],
              { stopReason: "toolUse" },
            )
          : fauxAssistantMessage("NOTHING");
      }
      if (system.includes("context summarization assistant")) return fauxAssistantMessage("STEERED SUMMARY.");
      return fauxAssistantMessage(turnAnswers.shift() ?? "ok");
    }),
  );
  const { harness, conversation } = await harnessFor(memory, fauxModels, fakeMemoryAuthority(), ROUTINE_CONTEXT);
  try {
    await (await conversation.submit({ type: "input", content: "Mia has piano on Tuesdays." }, ctx)).wait(ctx);
    // A routine run, labelled the way the session service labels it.
    const requestId = "routine:task-1:2026-10-09T07:00:00.000Z";
    await conversation.submit(
      { type: "write", entry: { kind: BOT_NOTICE_ENTRY_KIND, data: { notice: "routine", label: "Morning brief", requestId } } },
      ctx,
    );
    await (await conversation.submit({ type: "input", content: "Morning brief prompt.", requestId }, ctx)).wait(ctx);
    // The person's next message crosses the threshold in an attended run.
    await (await conversation.submit({ type: "input", content: "What's on this week?" }, ctx)).wait(ctx);

    const entries = await allEntries(conversation);
    assert.ok(entries.some((entry) => CompactionEntry.is(entry)), "the routine history was compacted");
    assert.equal(flushes.length, 1, "the person's history is still flushed");
    assert.match(flushes[0]!, /Mia has piano on Tuesdays/u);
    assert.doesNotMatch(flushes[0]!, /Morning brief prompt|ROUTINE BRIEF/u, "routine input and output never reach the flush");
    assert.equal(existsSync(userFile), false, "nothing derived from the routine is saved");
    assert.equal(entries.some((entry) => entry.kind === BOT_MEMORY_REVIEW_ENTRY_KIND), false);
  } finally {
    await harness.close(ctx);
  }
});

test("access revoked during the flush stops its save and the steered summary", async () => {
  const { memory, userFile } = memoryProfile();
  const authority = fakeMemoryAuthority();
  const kinds: string[] = [];
  const fauxModels = createFauxModels([
    fauxAssistantMessage(LONG_REPLY),
    (context) => {
      kinds.push(systemPromptOf(context.messages).includes("long-term memory") ? "flush" : "other");
      // Access changes while the flush's answer is on its way.
      authority.revoke();
      return fauxAssistantMessage(
        [fauxToolCall("bot_memory", { target: "user", operations: [{ action: "add", content: "Mia has piano on Tuesdays." }] })],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      kinds.push(lastUserText(context.messages).includes(BOT_COMPACTION_FOCUS) ? "steered" : "pi");
      return fauxAssistantMessage("PI SUMMARY");
    },
    fauxAssistantMessage("Sure."),
  ]);
  const { harness, conversation } = await harnessFor(memory, fauxModels, authority);
  try {
    await (await conversation.submit({ type: "input", content: LONG_INTRO }, ctx)).wait(ctx);
    await (await conversation.submit({ type: "input", content: "What's on this week?" }, ctx)).wait(ctx);
    assert.deepEqual(kinds, ["flush", "pi"], "no second flush request and no steered summary after the revocation");
    assert.equal(existsSync(userFile), false, "the flush's answer is not saved");
    assert.equal(authority.counts.releases, 1, "the admission is released");
  } finally {
    await harness.close(ctx);
  }
});

test("a manual compaction from the session asks for the Bot's focus", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-compaction-"));
  roots.push(root);
  const seen: BotCompaction[] = [];
  const fauxModels = createFauxModels([fauxAssistantMessage(LONG_REPLY), fauxAssistantMessage("Sure.")]);
  const service = await createBotSessionService({
    profileDir: root,
    models: fauxModels.models,
    // Only the manual compaction runs: the threshold stays at its default.
    settings: { compaction: { keepRecentTokens: 100, backgroundTokens: 0 } },
    compactionInstructions: BOT_COMPACTION_FOCUS,
    extension: {
      ...recordingDeps(),
      beforeCompact: async (_botId, compaction) => {
        seen.push(compaction);
        return { summary: "Kept." };
      },
    },
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set(["bot:a"]),
  });
  try {
    for (const [index, text] of [LONG_INTRO, "ok"].entries()) {
      const sent = await service.send("bot:a", { text, requestId: `desk-${index}` });
      await service.awaitReply("bot:a", sent.submissionId, new AbortController().signal);
    }
    assert.equal(seen.length, 0);
    await service.compact("bot:a");
    for (let attempt = 0; attempt < 100 && seen.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.reason, "manual");
    assert.equal(seen[0]!.instructions, BOT_COMPACTION_FOCUS);
  } finally {
    await service.shutdown();
  }
});
