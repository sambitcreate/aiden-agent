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
import { spawnHarnessChild } from "./test-support/child.js";
import { recordingDeps } from "./test-support/fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, waitFor, type FauxModels } from "./test-support/faux.js";
import {
  optionAnswer,
  QUESTION_ARGS,
  QUESTION_TOOL_NAME,
  questionEntries,
} from "./test-support/question-fixtures.js";
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

async function toolResults(root: Conversation): Promise<ToolResultModel[]> {
  const view = await root.context(ctx);
  return view.entries
    .filter((entry) => entry.kind === ToolResultEntry.kind)
    .map((entry) => (entry as unknown as { model: ToolResultModel[] }).model[0]!);
}

async function memoryHarness(botId: string, questions: BotQuestions, fauxModels: FauxModels) {
  const deps = recordingDeps({ tools: questionEntries(questions, botId) });
  const registry: BotRegistry = createBotRegistry(botId, deps);
  await registry.refresh();
  const harness = await Harness.open(new MemoryStorage(), { models: fauxModels.models, registry }, ctx);
  registry.attachHarness(harness);
  const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
  return { harness, root, registry };
}

test("a Bot offers the question tool, waits for the answer, and the answer is the tool result", async () => {
  const offered: string[][] = [];
  const fauxModels = createFauxModels([
    (context) => {
      offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
      return fauxAssistantMessage([fauxToolCall(QUESTION_TOOL_NAME, QUESTION_ARGS)], { stopReason: "toolUse" });
    },
    fauxAssistantMessage("Blue it is."),
  ]);
  const questions = createBotQuestions();
  const { harness, root } = await memoryHarness("bot-q", questions, fauxModels);
  try {
    const submitted = await root.submit({ type: "input", content: "pick a colour" }, ctx);
    const settled = submitted.wait(ctx);
    await waitFor(() => questions.pending("bot-q").length === 1, { what: "the question card" });
    const [prompt] = questions.pending("bot-q");
    assert.deepEqual(prompt!.questions[0]!.options.map((option) => option.label), ["Blue", "Red", "Green"]);
    assert.ok(offered[0]!.includes(QUESTION_TOOL_NAME), "the question tool is offered on an attended turn");

    assert.equal(questions.answer(prompt!.waitId, optionAnswer("someone-else", "Blue")), "rejected", "a response for another wait is refused");
    assert.equal(questions.answer(prompt!.waitId, optionAnswer(prompt!.waitId, "Purple")), "rejected", "an option the question does not have is refused");
    assert.equal(questions.pending("bot-q").length, 1, "a refused answer leaves the question waiting");

    assert.equal(questions.answer(prompt!.waitId, optionAnswer(prompt!.waitId, "Blue")), "answered");
    assert.equal(questions.answer(prompt!.waitId, optionAnswer(prompt!.waitId, "Red")), "rejected", "the first answer wins");
    assert.equal((await settled).status, "done");

    const results = (await toolResults(root)).filter((result) => result.toolName === QUESTION_TOOL_NAME);
    assert.equal(results.length, 1, "the answer is recorded once");
    assert.match(results[0]!.content[0]!.text ?? "", /Answer: Blue/u);
    assert.equal(results[0]!.isError, false);
    assert.equal(fauxModels.calls(), 2);
  } finally {
    await harness.close(ctx);
  }
});

test("after SIGKILL while the question waits, Resume re-asks it under the same waitId and applies one answer", async () => {
  const profile = tempProfile();
  const child = spawnHarnessChild("scenario", [
    scenarioFile,
    JSON.stringify({ profileDir: profile, botId: "bot-q-kill" }),
  ]);
  const childWaitId = await child.waitFor("QUESTION");
  await child.kill();

  const questions = createBotQuestions();
  const deps = recordingDeps({ tools: questionEntries(questions, "bot-q-kill") });
  const fauxModels = createFauxModels([fauxAssistantMessage("Thanks, going with Red.")]);
  let registry: BotRegistry | undefined;
  const host = (await createBotHarnessHost({
    profileDir: profile,
    models: fauxModels.models,
    buildRegistry: (id) => (registry = createBotRegistry(id, deps)),
  })) as BotHarnessHost;
  const { harness, conversation } = await host.open("bot-q-kill");
  await registry!.refresh();
  try {
    const [placed] = (await harness.inspect(ctx)).submissions;
    harness.resume();
    await waitFor(() => questions.pending("bot-q-kill").length === 1, { what: "the re-asked question" });
    const [reasked] = questions.pending("bot-q-kill");
    assert.equal(reasked!.waitId, childWaitId, "the question is re-asked under the original waitId");

    assert.equal(questions.answer(childWaitId, optionAnswer(childWaitId, "Red")), "answered");
    assert.equal(questions.answer(childWaitId, optionAnswer(childWaitId, "Blue")), "rejected", "the answer is applied once");
    assert.equal((await (await harness.submission(placed!.id, ctx))!.wait(ctx)).status, "done");

    const view = await conversation.context(ctx);
    const results = view.entries
      .filter((entry) => entry.kind === ToolResultEntry.kind)
      .map((entry) => (entry as unknown as { model: ToolResultModel[] }).model[0]!)
      .filter((result) => result.toolName === QUESTION_TOOL_NAME);
    assert.equal(results.length, 1);
    assert.match(results[0]!.content[0]!.text ?? "", /Answer: Red/u);
    assert.equal(fauxModels.calls(), 1, "only the follow-up answer is requested");
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
  assert.deepEqual(await names("routine:task-1:2026-10-07T09:00:00.000Z"), []);
  assert.deepEqual(await names("tg:1:2:0:3"), []);
});
