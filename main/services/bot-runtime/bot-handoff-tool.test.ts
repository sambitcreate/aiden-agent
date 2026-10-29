import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentTools, type ToolCall } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage, ToolResultEntry, type Conversation } from "@earendil-works/pi-durable";
import type { BotTranscriptEntry } from "../../../renderer/shared/bot-live.js";
import { createBotRegistry, type BotRegistry } from "./bot-extension.js";
import { createBotHarnessHost, type BotHarnessHost } from "./harness-host.js";
import { createBotHandoffs, type BotHandoffs } from "./bot-handoffs.js";
import { botHandoffCandidate, type BotHandoffDeps } from "./bot-handoff-tool.js";
import { botQuestionCandidate } from "./bot-question-tool.js";
import { createBotQuestions } from "./bot-questions.js";
import { createBotToolAssembly, type BotAdmission } from "./bot-tool-assembly.js";
import type { BotToolFacts } from "./bot-tool-policy.js";
import { projectBotTranscript } from "./live-projection.js";
import { spawnHarnessChild } from "./test-support/child.js";
import { recordingDeps } from "./test-support/fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, waitFor, type FauxModels } from "./test-support/faux.js";
import { HANDOFF_ARGS, HANDOFF_TOOL_NAME, handoffEntries } from "./test-support/handoff-fixtures.js";

const ctx = BACKGROUND_CONTEXT;
const scenarioFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "test-support", "handoff-scenario.ts");
const roots: string[] = [];
function tempProfile(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-handoff-"));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const ACTION = "Enter the 2FA code for your bank";
const DONE_TEXT = `The person says they did this: ${ACTION}. Check the result before continuing.`;
const SKIP_TEXT = `The person chose not to do this: ${ACTION}. Do not try another way to do it; say what you will do instead.`;

type ToolResultModel = { isError: boolean; toolName: string; toolCallId: string; content: Array<{ text?: string }> };

async function handoffResults(conversation: Conversation): Promise<ToolResultModel[]> {
  const view = await conversation.context(ctx);
  return view.entries
    .filter((entry) => entry.kind === ToolResultEntry.kind)
    .map((entry) => (entry as unknown as { model: ToolResultModel[] }).model[0]!)
    .filter((result) => result.toolName === HANDOFF_TOOL_NAME);
}

/** What the chat shows on the person's side for their answers. */
async function answerRows(conversation: Conversation): Promise<Array<Extract<BotTranscriptEntry, { type: "handoff_result" }>>> {
  const view = await conversation.context(ctx);
  return projectBotTranscript(view.entries).flatMap((entry) => (entry.type === "handoff_result" ? [entry] : []));
}

async function memoryHarness(botId: string, handoffs: BotHandoffs, fauxModels: FauxModels, handoffDeps: BotHandoffDeps = {}) {
  const deps = recordingDeps({ tools: handoffEntries(handoffs, botId, handoffDeps) });
  const registry: BotRegistry = createBotRegistry(botId, deps);
  await registry.refresh();
  const harness = await Harness.open(new MemoryStorage(), { models: fauxModels.models, registry }, ctx);
  registry.attachHarness(harness);
  const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
  return { harness, root };
}

async function profileHost(profile: string, botId: string, handoffs: BotHandoffs, fauxModels: FauxModels) {
  const deps = recordingDeps({ tools: handoffEntries(handoffs, botId) });
  let registry: BotRegistry | undefined;
  const host = (await createBotHarnessHost({
    profileDir: profile,
    models: fauxModels.models,
    buildRegistry: (id) => (registry = createBotRegistry(id, deps)),
  })) as BotHarnessHost;
  const opened = await host.open(botId);
  await registry!.refresh();
  return { host, ...opened };
}

const handOffOnce = (args: unknown = HANDOFF_ARGS) =>
  fauxAssistantMessage([fauxToolCall(HANDOFF_TOOL_NAME, args as ToolCall["arguments"])], { stopReason: "toolUse" });

test("a Bot hands off a step, waits, and Done with a note becomes one tool result and one line on the person's side", async () => {
  const offered: string[][] = [];
  const fauxModels = createFauxModels([
    (context) => {
      offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
      return handOffOnce();
    },
    fauxAssistantMessage("Thanks, I'll check the account now."),
  ]);
  const handoffs = createBotHandoffs();
  const { harness, root } = await memoryHarness("bot-h", handoffs, fauxModels);
  try {
    const settled = (await root.submit({ type: "input", content: "log in to my bank" }, ctx)).wait(ctx);
    await waitFor(() => handoffs.pending("bot-h").length === 1, { what: "the hand-off card" });
    const [card] = handoffs.pending("bot-h");
    assert.ok(offered[0]!.includes(HANDOFF_TOOL_NAME), "the hand-off tool is offered on an attended turn");
    assert.deepEqual(
      { kind: card!.kind, source: card!.source, action: card!.action, why: card!.why, open: card!.open },
      {
        kind: "action",
        source: "tool",
        action: ACTION,
        why: "Only you get the code on your phone.",
        open: { url: "https://bank.example/verify" },
      },
      "the card shows the step as one line without its full stop",
    );

    assert.equal(handoffs.answer("bot-h", card!.waitId, { outcome: "maybe" }), "invalid");
    assert.equal(handoffs.pending("bot-h").length, 1, "an invalid answer keeps the card waiting");
    assert.equal(handoffs.answer("bot-h", card!.waitId, { outcome: "done", note: "Entered 481 516." }), "answered");
    assert.equal(handoffs.answer("bot-h", card!.waitId, { outcome: "skipped" }), "not_waiting", "the first answer wins");
    assert.equal((await settled).status, "done");

    const results = await handoffResults(root);
    assert.equal(results.length, 1, "the answer is recorded once");
    assert.equal(results[0]!.isError, false);
    assert.equal(results[0]!.content[0]!.text, `${DONE_TEXT}\nTheir note: Entered 481 516.`);
    const rows = await answerRows(root);
    assert.deepEqual(
      rows.map(({ id, kind, outcome, action, note }) => ({ id, kind, outcome, action, note })),
      [{ id: `handoff:${card!.toolCallId}`, kind: "action", outcome: "done", action: ACTION, note: "Entered 481 516." }],
    );
    assert.equal(fauxModels.calls(), 2, "the model continues once, after the answer");
  } finally {
    await harness.close(ctx);
  }
});

test("Skip tells the model not to find another way, and reads as skipped on the person's side", async () => {
  const fauxModels = createFauxModels([handOffOnce({ action: ACTION }), fauxAssistantMessage("Okay, I'll leave it.")]);
  const handoffs = createBotHandoffs();
  const { harness, root } = await memoryHarness("bot-skip", handoffs, fauxModels);
  try {
    const settled = (await root.submit({ type: "input", content: "log in" }, ctx)).wait(ctx);
    await waitFor(() => handoffs.pending("bot-skip").length === 1, { what: "the hand-off card" });
    const [card] = handoffs.pending("bot-skip");
    assert.equal(card!.open, undefined, "no link, no Open");
    assert.equal(handoffs.answer("bot-skip", card!.waitId, { outcome: "skipped" }), "answered");
    assert.equal((await settled).status, "done");
    const [result] = await handoffResults(root);
    assert.equal(result!.content[0]!.text, SKIP_TEXT);
    assert.deepEqual(
      (await answerRows(root)).map((row) => [row.outcome, row.note]),
      [["skipped", undefined]],
    );
  } finally {
    await harness.close(ctx);
  }
});

test("Stop while a card waits withdraws it without recording an answer; a late answer is refused", async () => {
  const fauxModels = createFauxModels([handOffOnce(), fauxAssistantMessage("never requested")]);
  const handoffs = createBotHandoffs();
  const { harness, root } = await memoryHarness("bot-stop", handoffs, fauxModels);
  try {
    const settled = (await root.submit({ type: "input", content: "log in" }, ctx)).wait(ctx);
    await waitFor(() => handoffs.pending("bot-stop").length === 1, { what: "the hand-off card" });
    const [card] = handoffs.pending("bot-stop");

    await root.abort(ctx);
    assert.equal((await settled).status, "unanswered");
    assert.deepEqual(handoffs.pending("bot-stop"), [], "the card is withdrawn");
    assert.equal(handoffs.answer("bot-stop", card!.waitId, { outcome: "done" }), "not_waiting");
    assert.ok((await handoffResults(root)).every((result) => result.isError), "no answer was recorded");
    assert.deepEqual(await answerRows(root), [], "nothing reads as the person's answer");
    assert.equal(fauxModels.calls(), 1, "the model is not asked to continue");
  } finally {
    await harness.close(ctx);
  }
});

test("two hand-offs in one round are shown one at a time", async () => {
  const fauxModels = createFauxModels([
    fauxAssistantMessage(
      [fauxToolCall(HANDOFF_TOOL_NAME, { action: ACTION }), fauxToolCall(HANDOFF_TOOL_NAME, { action: "Approve the payment" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("All set."),
  ]);
  const handoffs = createBotHandoffs();
  let most = 0;
  handoffs.onChange(() => (most = Math.max(most, handoffs.pending().length)));
  const { harness, root } = await memoryHarness("bot-two", handoffs, fauxModels);
  try {
    const settled = (await root.submit({ type: "input", content: "pay the bill" }, ctx)).wait(ctx);
    await waitFor(() => handoffs.pending("bot-two").length === 1, { what: "the first card" });
    const [first] = handoffs.pending("bot-two");
    assert.equal(first!.action, ACTION);
    assert.equal(handoffs.answer("bot-two", first!.waitId, { outcome: "done" }), "answered");

    await waitFor(() => handoffs.pending("bot-two")[0]?.action === "Approve the payment", { what: "the second card" });
    const [next] = handoffs.pending("bot-two");
    assert.notEqual(next!.waitId, first!.waitId);
    assert.equal(handoffs.answer("bot-two", next!.waitId, { outcome: "skipped" }), "answered");
    assert.equal((await settled).status, "done");
    assert.equal(most, 1, "never two cards at once");
    assert.deepEqual(
      (await answerRows(root)).map((row) => [row.action, row.outcome]),
      [
        [ACTION, "done"],
        ["Approve the payment", "skipped"],
      ],
    );
  } finally {
    await harness.close(ctx);
  }
});

test("a link that is not https, or a blank step, is an error result and never shows a card", async () => {
  const fauxModels = createFauxModels([
    fauxAssistantMessage(
      [
        fauxToolCall(HANDOFF_TOOL_NAME, { action: ACTION, open: { url: "http://bank.example/verify" } }),
        fauxToolCall(HANDOFF_TOOL_NAME, { action: ACTION, open: { url: "https://ada:pw@bank.example/" } }),
        fauxToolCall(HANDOFF_TOOL_NAME, { action: "   " }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("I'll describe the step instead."),
  ]);
  const handoffs = createBotHandoffs();
  let shown = 0;
  handoffs.onChange(() => (shown += handoffs.pending().length));
  const { harness, root } = await memoryHarness("bot-bad", handoffs, fauxModels);
  try {
    assert.equal((await (await root.submit({ type: "input", content: "log in" }, ctx)).wait(ctx)).status, "done");
    const results = await handoffResults(root);
    assert.equal(results.length, 3);
    assert.ok(results.every((result) => result.isError), "each bad call failed");
    assert.match(results[0]!.content.map((part) => part.text ?? "").join(""), /https:\/\//u);
    assert.match(results[2]!.content.map((part) => part.text ?? "").join(""), /needs an action/u);
    assert.equal(shown, 0, "no card was ever shown");
    assert.deepEqual(await answerRows(root), []);
  } finally {
    await harness.close(ctx);
  }
});

test("a step in the Bot's own browser is marked for its screen; a place the Bot does not have is an error result", async () => {
  const offeredWhere: unknown[] = [];
  const fauxModels = createFauxModels([
    (context) => {
      const tool = getCurrentTools(context.messages).find((entry) => entry.name === HANDOFF_TOOL_NAME);
      offeredWhere.push((tool?.parameters as { properties?: Record<string, unknown> }).properties?.where);
      return fauxAssistantMessage(
        [
          fauxToolCall(HANDOFF_TOOL_NAME, { action: ACTION, where: "computer" }),
          fauxToolCall(HANDOFF_TOOL_NAME, { action: ACTION, where: "phone" }),
          fauxToolCall(HANDOFF_TOOL_NAME, { action: "Choose the delivery slot.", where: "browser", open: { url: "https://shop.example/checkout" } }),
        ],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("Thanks, the slot is booked."),
  ]);
  const handoffs = createBotHandoffs();
  const { harness, root } = await memoryHarness("bot-where", handoffs, fauxModels, { targets: { browser: true, computer: false } });
  try {
    const settled = (await root.submit({ type: "input", content: "book my groceries" }, ctx)).wait(ctx);
    await waitFor(() => handoffs.pending("bot-where").length === 1, { what: "the hand-off card" });
    const [card] = handoffs.pending("bot-where");
    assert.deepEqual(
      { action: card!.action, target: card!.target, open: card!.open },
      { action: "Choose the delivery slot", target: "browser", open: { url: "https://shop.example/checkout" } },
    );
    assert.ok(offeredWhere[0], "`where` is offered when the Bot has a browser");
    assert.equal(handoffs.answer("bot-where", card!.waitId, { outcome: "done" }), "answered");
    assert.equal((await settled).status, "done");

    const results = await handoffResults(root);
    assert.deepEqual(results.map((result) => result.isError), [true, true, false]);
    // The offered schema already refuses a place this Bot does not have.
    for (const result of results.slice(0, 2)) assert.match(result.content.map((part) => part.text ?? "").join(""), /where/u);
  } finally {
    await harness.close(ctx);
  }
});

test("a Bot without its own browser or computer is not offered `where`", async () => {
  const offeredWhere: unknown[] = [];
  const fauxModels = createFauxModels([
    (context) => {
      const tool = getCurrentTools(context.messages).find((entry) => entry.name === HANDOFF_TOOL_NAME);
      offeredWhere.push((tool?.parameters as { properties?: Record<string, unknown> }).properties?.where);
      return fauxAssistantMessage("Nothing to hand over.");
    },
  ]);
  const { harness, root } = await memoryHarness("bot-nowhere", createBotHandoffs(), fauxModels);
  try {
    await (await root.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
    assert.deepEqual(offeredWhere, [undefined]);
  } finally {
    await harness.close(ctx);
  }
});

test("quitting while a card waits withdraws it; Resume shows it again under the same waitId and applies one answer", async () => {
  const profile = tempProfile();
  const firstRun = createBotHandoffs();
  const before = await profileHost(profile, "bot-quit", firstRun, createFauxModels([handOffOnce()]));
  await before.conversation.configure({ model: FAUX_MODEL_REF }, ctx);
  await before.conversation.submit({ type: "input", content: "log in", requestId: "quit-1" }, ctx);
  await waitFor(() => firstRun.pending("bot-quit").length === 1, { what: "the hand-off card" });
  const [asked] = firstRun.pending("bot-quit");

  await before.host.shutdown();
  assert.deepEqual(firstRun.pending("bot-quit"), [], "quitting withdraws the card");
  assert.equal(firstRun.answer("bot-quit", asked!.waitId, { outcome: "done" }), "not_waiting");

  const handoffs = createBotHandoffs();
  const fauxModels = createFauxModels([fauxAssistantMessage("Signed in, checking now.")]);
  const reopened = await profileHost(profile, "bot-quit", handoffs, fauxModels);
  try {
    assert.deepEqual(handoffs.pending("bot-quit"), [], "nothing is shown before Resume");
    const [placed] = (await reopened.harness.inspect(ctx)).submissions;
    reopened.harness.resume();
    await waitFor(() => handoffs.pending("bot-quit").length === 1, { what: "the re-shown card" });
    assert.equal(handoffs.pending("bot-quit")[0]!.waitId, asked!.waitId);
    assert.equal(handoffs.answer("bot-quit", asked!.waitId, { outcome: "done" }), "answered");
    assert.equal((await (await reopened.harness.submission(placed!.id, ctx))!.wait(ctx)).status, "done");
    const results = await handoffResults(reopened.conversation);
    assert.equal(results.filter((result) => !result.isError).length, 1);
    assert.equal(results.find((result) => !result.isError)!.content[0]!.text, DONE_TEXT);
    assert.equal(fauxModels.calls(), 1, "the hand-off is not re-generated, only the follow-up");
  } finally {
    await reopened.host.shutdown();
  }
});

test("after SIGKILL while a card waits, Resume shows it under the same waitId and applies one answer", async () => {
  const profile = tempProfile();
  const child = spawnHarnessChild("scenario", [scenarioFile, JSON.stringify({ profileDir: profile, botId: "bot-h-kill" })]);
  const childWaitId = await child.waitFor("HANDOFF");
  await child.kill();

  const handoffs = createBotHandoffs();
  const fauxModels = createFauxModels([fauxAssistantMessage("Thanks, I'll carry on.")]);
  const { host, harness, conversation } = await profileHost(profile, "bot-h-kill", handoffs, fauxModels);
  try {
    const [placed] = (await harness.inspect(ctx)).submissions;
    harness.resume();
    await waitFor(() => handoffs.pending("bot-h-kill").length === 1, { what: "the re-shown card" });
    assert.equal(handoffs.pending("bot-h-kill")[0]!.waitId, childWaitId, "the card keeps its waitId");

    assert.equal(handoffs.answer("bot-h-kill", childWaitId, { outcome: "skipped", note: "Not this week." }), "answered");
    assert.equal(handoffs.answer("bot-h-kill", childWaitId, { outcome: "done" }), "not_waiting");
    assert.equal((await (await harness.submission(placed!.id, ctx))!.wait(ctx)).status, "done");

    const results = await handoffResults(conversation);
    assert.equal(results.length, 1, "the answer is applied exactly once");
    assert.equal(results[0]!.content[0]!.text, `${SKIP_TEXT}\nTheir note: Not this week.`);
    assert.equal(fauxModels.calls(), 1, "only the follow-up answer is requested");
  } finally {
    await host.shutdown();
  }
});

test("deleting a Bot while its card waits withdraws the card", async () => {
  const profile = tempProfile();
  const handoffs = createBotHandoffs();
  const { host, conversation } = await profileHost(profile, "bot-del", handoffs, createFauxModels([handOffOnce()]));
  try {
    await conversation.configure({ model: FAUX_MODEL_REF }, ctx);
    await conversation.submit({ type: "input", content: "log in" }, ctx);
    await waitFor(() => handoffs.pending("bot-del").length === 1, { what: "the hand-off card" });
    const [card] = handoffs.pending("bot-del");
    await host.destroy("bot-del");
    assert.deepEqual(handoffs.pending("bot-del"), []);
    assert.equal(handoffs.answer("bot-del", card!.waitId, { outcome: "done" }), "not_waiting");
  } finally {
    await host.shutdown();
  }
});

test("hand-offs and questions are offered on attended turns only, never on routine or Telegram turns", async () => {
  const admission: BotAdmission = {
    authority: {} as BotAdmission["authority"],
    signal: new AbortController().signal,
    revalidateBeforeEffect: async () => undefined,
    release: () => undefined,
  };
  const assembly = createBotToolAssembly({
    admit: async () => admission,
    sources: {
      facts: async () => ({ mcpTools: async () => new Map(), skillToolNames: async () => new Set() }) as unknown as BotToolFacts,
      candidates: async () => ({
        tools: [botQuestionCandidate("bot-gate", createBotQuestions()), botHandoffCandidate("bot-gate", createBotHandoffs())],
      }),
    },
  });
  const names = async (requestId?: string) =>
    (await assembly.currentTools("bot-gate", requestId === undefined ? {} : { requestId })).map((entry) => entry.tool.name);

  assert.deepEqual(await names(), ["ask_user_question", HANDOFF_TOOL_NAME]);
  assert.deepEqual(await names("desk-1"), ["ask_user_question", HANDOFF_TOOL_NAME]);
  assert.deepEqual(await names("remote:device:key"), ["ask_user_question", HANDOFF_TOOL_NAME]);
  assert.deepEqual(await names("routine:task-1:2026-10-07T09:00:00.000Z"), []);
  assert.deepEqual(await names("tg:1:2:0:3"), []);

  const call = { callId: "c1", args: { action: ACTION }, signal: new AbortController().signal };
  assert.deepEqual(await assembly.checkPolicy("bot-gate", HANDOFF_TOOL_NAME, { ...call, requestIds: ["desk-1"] }), {
    allowed: true,
  });
  for (const requestIds of [["routine:task-1:2026-10-07T09:00:00.000Z"], ["tg:1:2:0:3"], ["desk-1", "tg:1:2:0:3"]]) {
    const decision = await assembly.checkPolicy("bot-gate", HANDOFF_TOOL_NAME, { ...call, requestIds });
    assert.equal(decision.allowed, false, `refused at call time for ${requestIds.join(", ")}`);
  }
});
