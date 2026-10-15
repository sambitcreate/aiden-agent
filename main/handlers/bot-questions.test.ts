import assert from "node:assert/strict";
import test from "node:test";
import { createBotQuestions } from "../services/bot-runtime/bot-questions.js";
import { BOT_ANSWER_QUESTION_CHANNEL, registerBotQuestionHandlers } from "./bot-questions.js";

const WAIT_ID = "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c";
const QUESTION = {
  question: "Which colour should the banner use?",
  header: "Colour",
  multiSelect: false,
  options: [
    { label: "Blue", description: "Calm." },
    { label: "Red", description: "Loud." },
  ],
};

function setup() {
  const questions = createBotQuestions();
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  registerBotQuestionHandlers({ handle: (channel, handler) => handlers.set(channel, handler), questions });
  const invoke = (input: unknown) => Promise.resolve(handlers.get(BOT_ANSWER_QUESTION_CHANNEL)!({}, input));
  const controller = new AbortController();
  const asked = questions.request({
    botId: "bot:chief",
    waitId: WAIT_ID,
    toolCallId: "call-1",
    questions: [QUESTION],
    signal: controller.signal,
  });
  asked.catch(() => undefined);
  return { questions, invoke, asked, controller };
}

const answer = (label: string, overrides: Record<string, unknown> = {}) => ({
  botId: "bot:chief",
  waitId: WAIT_ID,
  answer: {
    version: 1,
    promptId: WAIT_ID,
    cancelled: false,
    answers: [{ questionIndex: 0, kind: "option", answer: label }],
  },
  ...overrides,
});

test("bots:answerQuestion settles the waiting question once; a repeat or stale wait id is refused", async () => {
  const { invoke, asked, questions } = setup();
  assert.deepEqual(await invoke(answer("Red")), { answered: true });
  assert.deepEqual((await asked).answers, [{ questionIndex: 0, kind: "option", answer: "Red" }]);
  assert.deepEqual(await invoke(answer("Blue")), { answered: false }, "the second answer is refused");
  const stale = answer("Blue", { waitId: "0000-stale" });
  assert.deepEqual(await invoke({ ...stale, answer: { ...stale.answer, promptId: "0000-stale" } }), { answered: false });
  assert.deepEqual(questions.pending(), []);
});

test("bots:answerQuestion refuses another Bot's wait id and an answer after the question was withdrawn", async () => {
  const { invoke, controller, questions } = setup();
  assert.deepEqual(await invoke(answer("Red", { botId: "bot:other" })), { answered: false });
  assert.equal(questions.pending().length, 1, "another Bot cannot settle it");
  controller.abort();
  assert.deepEqual(await invoke(answer("Red")), { answered: false }, "an answer after Stop/Dismiss records nothing");
});

test("bots:answerQuestion rejects malformed requests and answers the question does not accept", async () => {
  const { invoke, questions } = setup();
  const base = answer("Red");
  const malformed: unknown[] = [
    null,
    { ...base, extra: true },
    { ...base, waitId: "../etc" },
    { ...base, botId: "" },
    { ...base, answer: { ...base.answer, promptId: "q-other" } },
    { ...base, answer: { ...base.answer, version: 2 } },
    { ...base, answer: { ...base.answer, timedOut: true } },
    { ...base, answer: { ...base.answer, answers: [{ questionIndex: -1, kind: "option", answer: "Red" }] } },
    { ...base, answer: { ...base.answer, answers: [{ questionIndex: 0, kind: "option", answer: "Red", extra: 1 }] } },
    { ...base, answer: { ...base.answer, answers: [{ questionIndex: 0, kind: "vote", answer: "Red" }] } },
  ];
  for (const input of malformed) {
    await assert.rejects(invoke(input), /Invalid bot/u, JSON.stringify(input));
  }
  // Well-formed, but not an answer to this question.
  await assert.rejects(invoke(answer("Purple")), /doesn’t match/u);
  await assert.rejects(
    invoke({ ...base, answer: { ...base.answer, answers: [{ questionIndex: 2, kind: "option", answer: "Red" }] } }),
    /doesn’t match/u,
    "a question index out of range",
  );
  assert.equal(questions.pending().length, 1, "refused answers leave the question waiting");
});
