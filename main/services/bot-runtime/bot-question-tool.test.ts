import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage, ToolResultEntry, type Conversation } from "@earendil-works/pi-durable";
import { createBotRegistry, type BotRegistry } from "./bot-extension.js";
import { createBotHarnessHost, type BotHarnessHost } from "./harness-host.js";
import { createBotQuestions, type BotQuestions } from "./bot-questions.js";
import { createBotToolAssembly, type BotAdmission } from "./bot-tool-assembly.js";
import type { BotToolFacts } from "./bot-tool-policy.js";
import { projectBotTranscript } from "./live-projection.js";
import { spawnHarnessChild } from "./test-support/child.js";
import { recordingDeps } from "./test-support/fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, waitFor, type FauxModels } from "./test-support/faux.js";
import { optionAnswer, QUESTION_ARGS, QUESTION_TOOL_NAME, questionEntries } from "./test-support/question-fixtures.js";
import { botQuestionCandidate } from "./bot-question-tool.js";

const ctx = BACKGROUND_CONTEXT;
const scenarioFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "test-support", "question-scenario.ts");
const roots: string[] = [];
function tempProfile(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-question-"));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type ToolResultModel = { isError: boolean; toolName: string; content: Array<{ text?: string }> };

async function questionResults(conversation: Conversation): Promise<ToolResultModel[]> {
  const view = await conversation.context(ctx);
  return view.entries
    .filter((entry) => entry.kind === ToolResultEntry.kind)
    .map((entry) => (entry as unknown as { model: ToolResultModel[] }).model[0]!)
    .filter((result) => result.toolName === QUESTION_TOOL_NAME);
}

/** What the person sees in the chat for their answers. */
async function answerBubbles(conversation: Conversation): Promise<string[]> {
  const view = await conversation.context(ctx);
  return projectBotTranscript(view.entries).flatMap((entry) => (entry.type === "question_answer" ? [entry.text] : []));
}

async function memoryHarness(botId: string, questions: BotQuestions, fauxModels: FauxModels) {
  const deps = recordingDeps({ tools: questionEntries(questions, botId) });
  const registry: BotRegistry = createBotRegistry(botId, deps);
  await registry.refresh();
  const harness = await Harness.open(new MemoryStorage(), { models: fauxModels.models, registry }, ctx);
  registry.attachHarness(harness);
  const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
  return { harness, root };
}

async function profileHost(profile: string, botId: string, questions: BotQuestions, fauxModels: FauxModels) {
  const deps = recordingDeps({ tools: questionEntries(questions, botId) });
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

const askOnce = () => fauxAssistantMessage([fauxToolCall(QUESTION_TOOL_NAME, QUESTION_ARGS)], { stopReason: "toolUse" });

test("a Bot asks, waits, and the first valid answer becomes one tool result and one reply bubble", async () => {
  const offered: string[][] = [];
  const fauxModels = createFauxModels([
    (context) => {
      offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
      return askOnce();
    },
    fauxAssistantMessage("Blue it is."),
  ]);
  const questions = createBotQuestions();
  const { harness, root } = await memoryHarness("bot-q", questions, fauxModels);
  try {
    const settled = (await root.submit({ type: "input", content: "pick a colour" }, ctx)).wait(ctx);
    await waitFor(() => questions.pending("bot-q").length === 1, { what: "the question card" });
    const [prompt] = questions.pending("bot-q");
    const waitId = prompt!.waitId;
    assert.ok(offered[0]!.includes(QUESTION_TOOL_NAME), "the question tool is offered on an attended turn");
    assert.deepEqual(prompt!.questions[0]!.options.map((option) => option.label), ["Blue", "Red", "Green"]);

    assert.equal(questions.answer("bot-q", waitId, optionAnswer("q-other", "Blue")), "invalid", "another prompt id");
    assert.equal(questions.answer("bot-q", waitId, optionAnswer(waitId, "Purple")), "invalid", "an option it does not have");
    assert.equal(
      questions.answer("bot-q", waitId, { version: 1, promptId: waitId, cancelled: false, answers: [{ questionIndex: 3, kind: "option", answer: "Blue" }] }),
      "invalid",
      "a question index out of range",
    );
    assert.equal(questions.answer("bot-other", waitId, optionAnswer(waitId, "Blue")), "not_waiting", "another Bot's question");
    assert.equal(questions.answer("bot-q", "no-such-wait", optionAnswer("no-such-wait", "Blue")), "not_waiting");
    assert.equal(questions.pending("bot-q").length, 1, "refused answers leave the question waiting");

    // Two clients answer at once: exactly one wins.
    const outcomes = [
      questions.answer("bot-q", waitId, optionAnswer(waitId, "Blue")),
      questions.answer("bot-q", waitId, optionAnswer(waitId, "Red")),
    ];
    assert.deepEqual(outcomes, ["answered", "not_waiting"]);
    assert.equal((await settled).status, "done");

    const results = await questionResults(root);
    assert.equal(results.length, 1, "the answer is recorded once");
    assert.equal(results[0]!.isError, false);
    assert.match(results[0]!.content[0]!.text ?? "", /Answer: Blue/u);
    assert.deepEqual(await answerBubbles(root), ["Blue"], "the person's choice reads as their reply");
    assert.equal(fauxModels.calls(), 2);
  } finally {
    await harness.close(ctx);
  }
});

test("Stop while a question waits withdraws it without recording an answer; a late answer is refused", async () => {
  const fauxModels = createFauxModels([askOnce(), fauxAssistantMessage("never requested")]);
  const questions = createBotQuestions();
  const { harness, root } = await memoryHarness("bot-stop", questions, fauxModels);
  try {
    const settled = (await root.submit({ type: "input", content: "pick" }, ctx)).wait(ctx);
    await waitFor(() => questions.pending("bot-stop").length === 1, { what: "the question card" });
    const [prompt] = questions.pending("bot-stop");

    await root.abort(ctx);
    const outcome = await settled;
    assert.equal(outcome.status, "unanswered");
    assert.deepEqual(questions.pending("bot-stop"), [], "the card is withdrawn");
    assert.equal(questions.answer("bot-stop", prompt!.waitId, optionAnswer(prompt!.waitId, "Blue")), "not_waiting");

    const results = await questionResults(root);
    assert.ok(results.every((result) => result.isError), "no successful answer was recorded");
    assert.deepEqual(await answerBubbles(root), [], "no reply bubble for a question nobody answered");
    assert.equal(fauxModels.calls(), 1, "the model is not asked to continue");
  } finally {
    await harness.close(ctx);
  }
});

test("two questions in one round are shown one at a time", async () => {
  const second = { questions: [{ ...QUESTION_ARGS.questions[0]!, question: "Which size?", header: "Size" }] };
  const fauxModels = createFauxModels([
    fauxAssistantMessage(
      [fauxToolCall(QUESTION_TOOL_NAME, QUESTION_ARGS), fauxToolCall(QUESTION_TOOL_NAME, second)],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done."),
  ]);
  const questions = createBotQuestions();
  let most = 0;
  questions.onChange(() => (most = Math.max(most, questions.pending().length)));
  const { harness, root } = await memoryHarness("bot-two", questions, fauxModels);
  try {
    const settled = (await root.submit({ type: "input", content: "pick" }, ctx)).wait(ctx);
    await waitFor(() => questions.pending("bot-two").length === 1, { what: "the first card" });
    const [first] = questions.pending("bot-two");
    assert.equal(first!.questions[0]!.header, "Colour");
    assert.equal(questions.answer("bot-two", first!.waitId, optionAnswer(first!.waitId, "Red")), "answered");

    await waitFor(() => questions.pending("bot-two")[0]?.questions[0]?.header === "Size", { what: "the second card" });
    const [next] = questions.pending("bot-two");
    assert.notEqual(next!.waitId, first!.waitId);
    assert.equal(questions.answer("bot-two", next!.waitId, optionAnswer(next!.waitId, "Green")), "answered");
    assert.equal((await settled).status, "done");

    assert.equal(most, 1, "never two cards at once");
    assert.deepEqual(await answerBubbles(root), ["Red", "Green"]);
  } finally {
    await harness.close(ctx);
  }
});

test("quitting while a question waits withdraws it; Resume re-asks under the same waitId and applies one answer", async () => {
  const profile = tempProfile();
  const firstRun = createBotQuestions();
  const before = await profileHost(profile, "bot-quit", firstRun, createFauxModels([askOnce()]));
  await before.conversation.configure({ model: FAUX_MODEL_REF }, ctx);
  await before.conversation.submit({ type: "input", content: "pick", requestId: "quit-1" }, ctx);
  await waitFor(() => firstRun.pending("bot-quit").length === 1, { what: "the question card" });
  const [asked] = firstRun.pending("bot-quit");

  await before.host.shutdown();
  assert.deepEqual(firstRun.pending("bot-quit"), [], "quitting withdraws the card");
  assert.equal(firstRun.answer("bot-quit", asked!.waitId, optionAnswer(asked!.waitId, "Blue")), "not_waiting");

  const questions = createBotQuestions();
  const fauxModels = createFauxModels([fauxAssistantMessage("Green, noted.")]);
  const reopened = await profileHost(profile, "bot-quit", questions, fauxModels);
  try {
    assert.deepEqual(questions.pending("bot-quit"), [], "nothing is asked before Resume");
    const [placed] = (await reopened.harness.inspect(ctx)).submissions;
    reopened.harness.resume();
    await waitFor(() => questions.pending("bot-quit").length === 1, { what: "the re-asked question" });
    assert.equal(questions.pending("bot-quit")[0]!.waitId, asked!.waitId);
    assert.equal(questions.answer("bot-quit", asked!.waitId, optionAnswer(asked!.waitId, "Green")), "answered");
    assert.equal((await (await reopened.harness.submission(placed!.id, ctx))!.wait(ctx)).status, "done");
    assert.equal((await questionResults(reopened.conversation)).length, 1);
    assert.deepEqual(await answerBubbles(reopened.conversation), ["Green"]);
    assert.equal(fauxModels.calls(), 1, "the question is not re-generated, only the follow-up");
  } finally {
    await reopened.host.shutdown();
  }
});

test("after SIGKILL while a question waits, Resume re-asks it under the same waitId and applies one answer", async () => {
  const profile = tempProfile();
  const child = spawnHarnessChild("scenario", [scenarioFile, JSON.stringify({ profileDir: profile, botId: "bot-q-kill" })]);
  const childWaitId = await child.waitFor("QUESTION");
  await child.kill();

  const questions = createBotQuestions();
  const fauxModels = createFauxModels([fauxAssistantMessage("Thanks, going with Red.")]);
  const { host, harness, conversation } = await profileHost(profile, "bot-q-kill", questions, fauxModels);
  try {
    const [placed] = (await harness.inspect(ctx)).submissions;
    harness.resume();
    await waitFor(() => questions.pending("bot-q-kill").length === 1, { what: "the re-asked question" });
    assert.equal(questions.pending("bot-q-kill")[0]!.waitId, childWaitId, "the question keeps its waitId");

    assert.equal(questions.answer("bot-q-kill", childWaitId, optionAnswer(childWaitId, "Red")), "answered");
    assert.equal(questions.answer("bot-q-kill", childWaitId, optionAnswer(childWaitId, "Blue")), "not_waiting");
    assert.equal((await (await harness.submission(placed!.id, ctx))!.wait(ctx)).status, "done");

    const results = await questionResults(conversation);
    assert.equal(results.length, 1, "the answer is applied exactly once");
    assert.match(results[0]!.content[0]!.text ?? "", /Answer: Red/u);
    assert.equal(fauxModels.calls(), 1, "only the follow-up answer is requested");
  } finally {
    await host.shutdown();
  }
});

test("Dismiss after SIGKILL ends the paused question without asking it or recording an answer", async () => {
  const profile = tempProfile();
  const child = spawnHarnessChild("scenario", [scenarioFile, JSON.stringify({ profileDir: profile, botId: "bot-q-dismiss" })]);
  await child.waitFor("QUESTION");
  await child.kill();

  const questions = createBotQuestions();
  let asked = 0;
  questions.onChange(() => (asked += questions.pending().length));
  const fauxModels = createFauxModels([fauxAssistantMessage("never requested")]);
  const { host, conversation } = await profileHost(profile, "bot-q-dismiss", questions, fauxModels);
  try {
    await conversation.abort(ctx);
    assert.equal(asked, 0, "the dismissed question is never shown again");
    assert.ok((await questionResults(conversation)).every((result) => result.isError));
    assert.deepEqual(await answerBubbles(conversation), []);
    assert.equal(fauxModels.calls(), 0);
  } finally {
    await host.shutdown();
  }
});

test("deleting a Bot while its question waits withdraws the card", async () => {
  const profile = tempProfile();
  const questions = createBotQuestions();
  const { host, conversation } = await profileHost(profile, "bot-del", questions, createFauxModels([askOnce()]));
  try {
    await conversation.configure({ model: FAUX_MODEL_REF }, ctx);
    await conversation.submit({ type: "input", content: "pick" }, ctx);
    await waitFor(() => questions.pending("bot-del").length === 1, { what: "the question card" });
    const [prompt] = questions.pending("bot-del");
    await host.destroy("bot-del");
    assert.deepEqual(questions.pending("bot-del"), []);
    assert.equal(questions.answer("bot-del", prompt!.waitId, optionAnswer(prompt!.waitId, "Blue")), "not_waiting");
  } finally {
    await host.shutdown();
  }
});

test("the question tool is not offered on routine or Telegram turns", async () => {
  const candidate = botQuestionCandidate("bot-gate", createBotQuestions());
  const admission: BotAdmission = {
    authority: {} as BotAdmission["authority"],
    signal: new AbortController().signal,
    revalidateBeforeEffect: async () => undefined,
    release: () => undefined,
  };
  const assembly = createBotToolAssembly({
    admit: async () => admission,
    sources: {
      facts: async () => ({}) as BotToolFacts,
      candidates: async () => ({ tools: [candidate] }),
    },
  });
  const names = async (requestId?: string) =>
    (await assembly.currentTools("bot-gate", requestId === undefined ? {} : { requestId })).map((entry) => entry.tool.name);

  assert.deepEqual(await names(), [QUESTION_TOOL_NAME]);
  assert.deepEqual(await names("desk-1"), [QUESTION_TOOL_NAME]);
  assert.deepEqual(await names("remote:device:key"), [QUESTION_TOOL_NAME]);
  assert.deepEqual(await names("routine:task-1:2026-10-07T09:00:00.000Z"), []);
  assert.deepEqual(await names("tg:1:2:0:3"), []);
});
