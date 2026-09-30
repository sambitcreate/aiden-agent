import assert from "node:assert/strict";
import test from "node:test";
import {
  ASK_USER_QUESTION_VERSION,
  type AskUserQuestionPromptV1,
} from "../../renderer/shared/ask-user-question.js";
import { AskUserQuestionCoordinator } from "./ask-user-question-coordinator.js";

const questions = [
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

test("questionnaire responses are one-shot and renderer-document bound", async () => {
  let published!: AskUserQuestionPromptV1;
  const coordinator = new AskUserQuestionCoordinator((prompt) => {
    published = prompt;
  });
  const pending = coordinator.request(
    { streamId: "s-one", toolCallId: "provider-call", questions },
    "document-one",
  );
  assert.equal(coordinator.pendingCount, 1);
  const answer = {
    version: ASK_USER_QUESTION_VERSION,
    promptId: published.promptId,
    cancelled: false,
    answers: [{ questionIndex: 0, kind: "option", answer: "Direct" }],
  } as const;
  assert.equal(coordinator.respond(published.promptId, answer, "document-two"), false);
  assert.equal(coordinator.respond(published.promptId, answer, "document-one"), true);
  assert.deepEqual(await pending, answer);
  assert.equal(coordinator.respond(published.promptId, answer, "document-one"), false);
  assert.equal(coordinator.pendingCount, 0);
});

test("abort and renderer detach settle pending prompts as cancelled", async () => {
  const prompts: string[] = [];
  const coordinator = new AskUserQuestionCoordinator((prompt) => prompts.push(prompt.promptId));
  const controller = new AbortController();
  const aborted = coordinator.request(
    { streamId: "s-abort", toolCallId: "call-abort", questions },
    "document-one",
    controller.signal,
  );
  controller.abort();
  assert.equal((await aborted).cancelled, true);

  const detached = coordinator.request(
    { streamId: "s-detach", toolCallId: "call-detach", questions },
    "document-one",
  );
  coordinator.detachStream("s-detach");
  assert.equal((await detached).cancelled, true);
  assert.equal(prompts.length, 2);
  assert.equal(coordinator.pendingCount, 0);
});

test("published prompts are withdrawn exactly once however they settle", async () => {
  const published: string[] = [];
  const withdrawn: string[] = [];
  const coordinator = new AskUserQuestionCoordinator(
    (prompt) => published.push(prompt.promptId),
    (promptId) => withdrawn.push(promptId),
  );
  const answered = coordinator.request(
    { streamId: "s-answer", toolCallId: "call-answer", questions },
    "document-one",
  );
  coordinator.respond(
    published[0]!,
    {
      version: ASK_USER_QUESTION_VERSION,
      promptId: published[0]!,
      cancelled: false,
      answers: [{ questionIndex: 0, kind: "option", answer: "Direct" }],
    },
    "document-one",
  );
  await answered;
  const detached = coordinator.request(
    { streamId: "s-gone", toolCallId: "call-gone", questions },
    "document-one",
  );
  coordinator.detachStream("s-gone");
  coordinator.detachStream("s-gone");
  await detached;
  assert.deepEqual(withdrawn, published);
});

test("a prompt whose publication failed is never withdrawn", async () => {
  const withdrawn: string[] = [];
  const coordinator = new AskUserQuestionCoordinator(
    () => {
      throw new Error("renderer gone");
    },
    (promptId) => withdrawn.push(promptId),
  );
  const response = await coordinator.request(
    { streamId: "s-fail", toolCallId: "call-fail", questions },
    "document-one",
  );
  assert.equal(response.cancelled, true);
  assert.deepEqual(withdrawn, []);
});

test("an unanswered timed prompt tells the agent no answer arrived and reports late replies as expired", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-09-27T10:00:00.000Z") });
  let published!: AskUserQuestionPromptV1;
  const coordinator = new AskUserQuestionCoordinator((prompt) => {
    published = prompt;
  });
  const pending = coordinator.request(
    { streamId: "s-timed", toolCallId: "call-timed", questions, timeoutMs: 90_000 },
    "document-one",
  );
  assert.equal(published.expiresAt, "2026-09-27T10:01:30.000Z");

  t.mock.timers.tick(89_999);
  assert.equal(coordinator.pendingCount, 1);
  t.mock.timers.tick(1);
  const response = await pending;
  assert.equal(response.timedOut, true);
  assert.deepEqual(response.answers, []);
  assert.equal(coordinator.pendingCount, 0);

  const late = {
    version: ASK_USER_QUESTION_VERSION,
    promptId: published.promptId,
    cancelled: false,
    answers: [{ questionIndex: 0, kind: "option", answer: "Guided" }],
  };
  assert.equal(coordinator.respondWithOutcome(published.promptId, late, "document-one"), "expired");
  // Another document cannot learn about or claim someone else's prompt.
  assert.equal(coordinator.respondWithOutcome(published.promptId, late, "document-two"), "rejected");
});

test("an answer that races past the deadline is settled as a timeout, never delivered", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  let published!: AskUserQuestionPromptV1;
  const coordinator = new AskUserQuestionCoordinator((prompt) => {
    published = prompt;
  });
  const pending = coordinator.request(
    { streamId: "s-race", toolCallId: "call-race", questions, timeoutMs: 30_000 },
    "document-one",
  );
  // Wall clock passes the deadline before the timer callback gets to run.
  t.mock.timers.setTime(1_030_000);
  assert.equal(
    coordinator.respondWithOutcome(
      published.promptId,
      {
        version: ASK_USER_QUESTION_VERSION,
        promptId: published.promptId,
        cancelled: false,
        answers: [{ questionIndex: 0, kind: "option", answer: "Direct" }],
      },
      "document-one",
    ),
    "expired",
  );
  const response = await pending;
  assert.equal(response.timedOut, true);
  assert.deepEqual(response.answers, []);
});

test("prompts without a timeout wait for their owner and carry no deadline", async () => {
  let published!: AskUserQuestionPromptV1;
  const coordinator = new AskUserQuestionCoordinator((prompt) => {
    published = prompt;
  });
  const pending = coordinator.request(
    { streamId: "s-open", toolCallId: "call-open", questions },
    "document-one",
  );
  assert.equal(published.expiresAt, undefined);
  const answer = {
    version: ASK_USER_QUESTION_VERSION,
    promptId: published.promptId,
    cancelled: false,
    answers: [{ questionIndex: 0, kind: "option", answer: "Direct" }],
  } as const;
  assert.equal(
    coordinator.respondWithOutcome(published.promptId, answer, "document-one"),
    "answered",
  );
  assert.equal((await pending).timedOut, undefined);
});
