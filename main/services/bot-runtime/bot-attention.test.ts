import assert from "node:assert/strict";
import test from "node:test";
import { createBotApprovals } from "./bot-approvals.js";
import { wireBotAttention } from "./bot-attention.js";
import { createBotHandoffs } from "./bot-handoffs.js";
import { createBotQuestions } from "./bot-questions.js";
import {
  optionAnswer,
  QUESTION_ARGS,
} from "./test-support/question-fixtures.js";

function setup() {
  const questions = createBotQuestions();
  const approvals = createBotApprovals({ publish() {}, withdraw() {} });
  const handoffs = createBotHandoffs();
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const stop = wireBotAttention({
    questions,
    approvals,
    handoffs,
    broadcast: (channel, payload) => void sent.push({ channel, payload }),
  });
  return { questions, approvals, handoffs, sent, stop };
}

function handOff(handoffs: ReturnType<typeof createBotHandoffs>, botId: string, waitId: string, signal?: AbortSignal) {
  return handoffs.request({
    botId,
    waitId,
    toolCallId: `call-${waitId}`,
    kind: "action",
    action: "Enter the 2FA code for your bank",
    why: "Only you get the code on your phone.",
    source: "tool",
    signal,
  });
}

function ask(
  questions: ReturnType<typeof createBotQuestions>,
  botId: string,
  waitId: string,
  signal?: AbortSignal,
) {
  return questions.request({
    botId,
    waitId,
    toolCallId: `call-${waitId}`,
    questions: QUESTION_ARGS.questions.map((question) => ({
      ...question,
      multiSelect: false,
    })),
    signal,
  });
}

function approve(
  approvals: ReturnType<typeof createBotApprovals>,
  botId: string,
  waitId: string,
  signal?: AbortSignal,
) {
  return approvals.request({
    botId,
    waitId,
    toolCallId: `call-${waitId}`,
    toolName: "write_file",
    summary: "Write secret-notes.txt",
    signal,
  });
}

test("a question appearing and being answered each tell the sidebar, with only the Bot id", async () => {
  const { questions, sent } = setup();
  const answered = ask(questions, "bot-a", "w1");
  assert.deepEqual(sent, [
    { channel: "bots:attention", payload: { botId: "bot-a" } },
  ]);
  assert.equal(
    questions.answer("bot-a", "w1", optionAnswer("w1", "Blue")),
    "answered",
  );
  await answered;
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], {
    channel: "bots:attention",
    payload: { botId: "bot-a" },
  });
  assert.equal(
    JSON.stringify(sent).includes("banner"),
    false,
    "no question text is broadcast",
  );
});

test("a question that is aborted tells the sidebar again", async () => {
  const { questions, sent } = setup();
  const controller = new AbortController();
  const withdrawn = ask(questions, "bot-a", "w1", controller.signal);
  controller.abort();
  await assert.rejects(withdrawn);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1]!.payload, { botId: "bot-a" });
});

test("an approval being asked and decided each tell the sidebar, with only the Bot id", async () => {
  const { approvals, sent } = setup();
  const decided = approve(approvals, "bot-a", "a1");
  assert.deepEqual(sent, [
    { channel: "bots:attention", payload: { botId: "bot-a" } },
  ]);
  assert.equal(approvals.decide("a1", "allow"), true);
  assert.equal(await decided, "allow");
  assert.equal(sent.length, 2);
  assert.equal(
    JSON.stringify(sent).includes("secret-notes"),
    false,
    "no approval text is broadcast",
  );
});

test("a second Bot's question carries its own id, and stopping the wiring silences it", async () => {
  const { questions, sent, stop } = setup();
  const first = ask(questions, "bot-a", "w1");
  const second = ask(questions, "bot-b", "w2");
  assert.deepEqual(
    sent.map((message) => message.payload),
    [{ botId: "bot-a" }, { botId: "bot-b" }],
  );
  stop();
  questions.answer("bot-a", "w1", optionAnswer("w1", "Blue"));
  questions.answer("bot-b", "w2", optionAnswer("w2", "Red"));
  await Promise.all([first, second]);
  assert.equal(sent.length, 2, "nothing is broadcast after the unsubscribe");
});

test("a hand-off card opening, being answered and being withdrawn each tell the sidebar, with only the Bot id", async () => {
  const { handoffs, sent, stop } = setup();
  const answered = handOff(handoffs, "bot-a", "h1");
  assert.deepEqual(sent, [{ channel: "bots:attention", payload: { botId: "bot-a" } }]);
  assert.equal(handoffs.answer("bot-a", "h1", { outcome: "done" }), "answered");
  assert.deepEqual(await answered, { outcome: "done" });
  assert.equal(sent.length, 2);

  const controller = new AbortController();
  const withdrawn = handOff(handoffs, "bot-b", "h2", controller.signal);
  controller.abort();
  await assert.rejects(withdrawn);
  assert.deepEqual(
    sent.slice(2).map((message) => message.payload),
    [{ botId: "bot-b" }, { botId: "bot-b" }],
  );
  assert.equal(JSON.stringify(sent).includes("2FA"), false, "no hand-off text is broadcast");

  stop();
  const late = handOff(handoffs, "bot-a", "h3");
  handoffs.answer("bot-a", "h3", { outcome: "skipped" });
  await late;
  assert.equal(sent.length, 4, "nothing is broadcast after the unsubscribe");
});
