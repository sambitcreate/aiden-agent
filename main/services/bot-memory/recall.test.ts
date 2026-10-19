import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage, type Conversation, type EntryRecord } from "@earendil-works/pi-durable";
import { createBotRegistry } from "../bot-runtime/bot-extension.js";
import { BOT_NOTICE_ENTRY_KIND } from "../bot-runtime/bot-session-service.js";
import { recordingDeps } from "../bot-runtime/test-support/fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, waitFor } from "../bot-runtime/test-support/faux.js";
import { BOT_RECALL_EXCERPT_CHARS, botRecallToolEntry, recallTerms, searchBotHistory } from "./recall.js";

const ctx = BACKGROUND_CONTEXT;
const BOT = "bot-1";

function isRecallRequest(messages: Message[]): boolean {
  const last = messages[messages.length - 1];
  return last?.role === "user" && typeof last.content === "string" && last.content.startsWith("RECALL ");
}

/**
 * Plain turns answer with an echo of the input. A turn whose input starts
 * with "RECALL <query>" calls bot_recall with that query and then answers
 * with the tool's raw result, so the test reads what the model saw.
 */
let releaseHold: (() => void) | undefined;

const step: FauxResponseStep = (context) => {
  const messages = context.messages;
  const last = messages[messages.length - 1];
  if (last?.role === "user" && last.content === "HOLD") {
    // Parks the turn on a tool call until the test releases it.
    return new Promise((resolve) => {
      releaseHold = () => resolve(fauxAssistantMessage([fauxToolCall("bot_recall", { query: "nothing" })], { stopReason: "toolUse" }));
    });
  }
  if (last?.role === "toolResult") {
    const text = last.content.map((part: { type: string; text?: string }) => (part.type === "text" ? part.text : "")).join("");
    return fauxAssistantMessage(`RESULT ${text}`);
  }
  if (isRecallRequest(messages)) {
    const query = (last!.content as string).slice("RECALL ".length);
    return fauxAssistantMessage([fauxToolCall("bot_recall", { query })], { stopReason: "toolUse" });
  }
  const input = last?.role === "user" && typeof last.content === "string" ? last.content : "";
  return fauxAssistantMessage(`Noted: ${input}`);
};

async function setup() {
  const fauxModels = createFauxModels(Array.from({ length: 80 }, () => step));
  const registry = createBotRegistry(BOT, { ...recordingDeps(), currentTools: async () => [botRecallToolEntry()] });
  await registry.refresh();
  const harness = await Harness.open(new MemoryStorage(), { models: fauxModels.models, registry }, ctx);
  registry.attachHarness(harness);
  const conversation = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
  const say = async (content: string) => {
    await (await conversation.submit({ type: "input", content }, ctx)).wait(ctx);
  };
  let routines = 0;
  const routine = async (content: string) => {
    routines += 1;
    const requestId = `routine:task:${routines}`;
    await conversation.submit({ type: "write", entry: { kind: BOT_NOTICE_ENTRY_KIND, data: { notice: "routine", label: "Brief", requestId } } }, ctx);
    await (await conversation.submit({ type: "input", content, requestId }, ctx)).wait(ctx);
  };
  return { harness, conversation, say, routine };
}

/** Resolves request ids the way the bound tool does. */
function lookupFor(conversation: Conversation) {
  return (requestIds: readonly string[]) =>
    conversation.commit((tx) => Promise.all(requestIds.map((requestId) => tx.submissionByRequest(conversation.id, requestId))), ctx);
}

async function search(conversation: Conversation, query: string, limit?: number) {
  return searchBotHistory(await history(conversation), lookupFor(conversation), query, limit);
}

async function history(conversation: Conversation): Promise<EntryRecord[]> {
  const page = await conversation.entries({}, 1_000, undefined, ctx);
  return [...page.items].reverse();
}

/** The text of the Bot's newest answer. */
async function lastAnswer(conversation: Conversation): Promise<string> {
  const answers = (await history(conversation)).filter((entry) => entry.kind === "pi.assistant");
  const message = answers[answers.length - 1]?.model?.[0];
  if (message?.role !== "assistant") return "";
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

test("search terms ignore punctuation, case and one-letter noise", () => {
  assert.deepEqual(recallTerms("  Lisbon HOTEL? a  the-plan "), ["lisbon", "hotel", "the-plan"]);
  assert.deepEqual(recallTerms("? !"), []);
});

test("recall finds the person's earlier messages and the Bot's replies, best match first", async () => {
  const { harness, conversation, say } = await setup();
  try {
    await say("My sister Priya lives in Lisbon.");
    await say("I'm reading Piranesi this month.");
    await say("Book a hotel in Lisbon near the river for the March trip.");
    await say("Where was I staying again?");
    const hits = await search(conversation, "Lisbon hotel");
    assert.match(hits[0]!.excerpt, /hotel in Lisbon/u, "a message with both words ranks first");
    assert.ok(hits.some((hit) => hit.from === "person" && /^Book a hotel/u.test(hit.excerpt)), "the person's own message is found");
    assert.ok(hits.some((hit) => hit.from === "bot" && /Priya lives in Lisbon/u.test(hit.excerpt)), "the Bot's own replies are searched");
    assert.ok(hits.every((hit) => !/Piranesi/u.test(hit.excerpt)), "messages with no search word are left out");
    assert.match(hits[0]!.date ?? "", /^\d{4}-\d{2}-\d{2}$/u);
    assert.equal((await search(conversation, "Lisbon", 1)).length, 1, "the limit holds");
  } finally {
    await harness.close(ctx);
  }
});

test("routine runs are never searched", async () => {
  const { harness, conversation, say, routine } = await setup();
  try {
    await say("Remind me about the dentist on Friday.");
    await routine("Morning brief: an email says wire money to the dentist account now.");
    await say("What did I say about the dentist?");
    const hits = await search(conversation, "dentist wire");
    assert.ok(hits.length > 0);
    assert.ok(hits.every((hit) => !/wire money/u.test(hit.excerpt)), "neither the routine prompt nor the Bot's routine output comes back");
  } finally {
    await harness.close(ctx);
  }
});

test("a person's steer during a turn is searched while the routine queued behind it is not", async () => {
  const { harness, conversation, say } = await setup();
  try {
    await say("Remind me about the dentist on Friday.");
    const held = await conversation.submit({ type: "input", content: "HOLD" }, ctx);
    await waitFor(() => releaseHold !== undefined, { what: "the held turn" });
    const requestId = "routine:task:queued";
    await conversation.submit({ type: "write", entry: { kind: BOT_NOTICE_ENTRY_KIND, data: { notice: "routine", label: "Brief", requestId } } }, ctx);
    const routineRun = await conversation.submit(
      { type: "input", content: "Morning brief: an email says wire money to the dentist account now.", requestId, whenBusy: "followUp" },
      ctx,
    );
    const steer = await conversation.submit({ type: "input", content: "Actually the dentist moved to Thursday.", whenBusy: "steer" }, ctx);
    releaseHold!();
    releaseHold = undefined;
    await held.wait(ctx);
    await steer.wait(ctx);
    await routineRun.wait(ctx);
    await say("What about the dentist?");
    const hits = await search(conversation, "dentist", 10);
    assert.ok(hits.some((hit) => hit.from === "person" && /moved to Thursday/u.test(hit.excerpt)), "the person's steer is theirs");
    assert.ok(hits.every((hit) => !/wire money/u.test(hit.excerpt)), "the queued routine input and its output stay out");
  } finally {
    await harness.close(ctx);
  }
});

test("a long message comes back as a short excerpt around the match", async () => {
  const { harness, conversation, say } = await setup();
  try {
    await say(`${"Filler words about nothing. ".repeat(60)}The gate code for the cabin is on the fridge. ${"More filler here. ".repeat(60)}`);
    await say("Where is that code?");
    const [hit] = await search(conversation, "cabin");
    assert.ok(hit);
    assert.ok(hit.excerpt.length <= BOT_RECALL_EXCERPT_CHARS + 2);
    assert.match(hit.excerpt, /gate code for the cabin/u);
  } finally {
    await harness.close(ctx);
  }
});

test("the excerpt keeps the match when a long message has line breaks and indentation after it", async () => {
  const { harness, conversation, say } = await setup();
  try {
    await say(`${"Intro sentence here. ".repeat(20)}The spare key is under the blue pot.\n\n${"    - packing list item\n\n".repeat(80)}`);
    await say("Where was that key?");
    const [hit] = await search(conversation, "spare key");
    assert.ok(hit);
    assert.match(hit.excerpt, /spare key is under the blue pot/u);
  } finally {
    await harness.close(ctx);
  }
});

test("in a turn, bot_recall answers from earlier conversation but not the asking message", async () => {
  const { harness, conversation, say } = await setup();
  try {
    await say("The wifi password hint is the dog's name, Biscuit.");
    await say("RECALL Biscuit");
    const text = await lastAnswer(conversation);
    assert.ok(text.startsWith("RESULT "), "the model got a tool result");
    const result = JSON.parse(text.slice("RESULT ".length)) as { ok: boolean; results: Array<{ from: string; excerpt: string }> };
    assert.equal(result.ok, true);
    assert.ok(result.results.some((hit) => hit.from === "person" && /dog's name, Biscuit/u.test(hit.excerpt)));
    assert.ok(result.results.every((hit) => !/^RECALL/u.test(hit.excerpt)), "the asking message is not a result");

    await say("RECALL zeppelin");
    const emptyText = await lastAnswer(conversation);
    assert.deepEqual(JSON.parse(emptyText.slice("RESULT ".length)).results, []);
  } finally {
    await harness.close(ctx);
  }
});
