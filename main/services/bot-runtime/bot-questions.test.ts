import assert from "node:assert/strict";
import test from "node:test";
import {
  ASK_USER_QUESTION_VERSION,
  type AskUserQuestionV1,
} from "../../../renderer/shared/ask-user-question.js";
import { createBotQuestions } from "./bot-questions.js";

const questions: AskUserQuestionV1[] = [
  {
    question: "Which approach?",
    header: "Approach",
    multiSelect: false,
    options: [
      { label: "Direct", description: "Implement it now." },
      { label: "Guided", description: "Explain each step." },
    ],
  },
];

const ask = (signal?: AbortSignal) => ({
  botId: "bot-one",
  waitId: "wait-one",
  toolCallId: "call-one",
  questions,
  signal,
});

const pick = (answer: string) => ({
  version: ASK_USER_QUESTION_VERSION,
  promptId: "wait-one",
  cancelled: false,
  answers: [{ questionIndex: 0, kind: "option", answer }],
});

test("an invalid answer leaves the question waiting, and only the first valid answer settles it", async () => {
  const registry = createBotQuestions();
  const waiting = registry.request(ask());
  assert.equal(registry.answer("bot-one", "wait-one", pick("Not an option")), "invalid");
  assert.equal(registry.pending("bot-one").length, 1);
  assert.equal(registry.answer("bot-one", "wait-one", pick("Guided")), "answered");
  assert.equal(registry.answer("bot-one", "wait-one", pick("Direct")), "not_waiting");
  assert.deepEqual((await waiting).answers, [{ questionIndex: 0, kind: "option", answer: "Guided" }]);
  assert.deepEqual(registry.pending(), []);
});

test("another Bot cannot answer a question it does not own", async () => {
  const registry = createBotQuestions();
  const waiting = registry.request(ask());
  assert.equal(registry.answer("bot-two", "wait-one", pick("Direct")), "not_waiting");
  assert.equal(registry.pending("bot-one").length, 1);
  assert.equal(registry.answer("bot-one", "wait-one", pick("Direct")), "answered");
  await waiting;
});

test("asking again withdraws the stale wait, whose late abort cannot end the new one", async () => {
  const registry = createBotQuestions();
  const stale = new AbortController();
  const first = registry.request(ask(stale.signal));
  const second = registry.request(ask());
  await assert.rejects(first, /asked again/u);
  stale.abort(new Error("the old turn ended"));
  assert.equal(registry.pending("bot-one").length, 1);
  assert.equal(registry.answer("bot-one", "wait-one", pick("Direct")), "answered");
  assert.deepEqual((await second).answers, [{ questionIndex: 0, kind: "option", answer: "Direct" }]);
});

test("abort rejects with its reason and records no answer, and a late answer is refused", async () => {
  const registry = createBotQuestions();
  const controller = new AbortController();
  const waiting = registry.request(ask(controller.signal));
  const reason = new Error("Stopped");
  controller.abort(reason);
  await assert.rejects(waiting, (error) => error === reason);
  assert.equal(registry.answer("bot-one", "wait-one", pick("Direct")), "not_waiting");
});

test("a throwing listener cannot change how a question settles", async () => {
  const registry = createBotQuestions();
  registry.onChange(() => {
    throw new Error("listener failed");
  });
  const waiting = registry.request(ask());
  assert.equal(registry.answer("bot-one", "wait-one", pick("Direct")), "answered");
  assert.deepEqual((await waiting).answers, [{ questionIndex: 0, kind: "option", answer: "Direct" }]);
});
