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
