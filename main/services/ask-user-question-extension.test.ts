import assert from "node:assert/strict";
import test from "node:test";
import {
  ASK_USER_MAX_TIMEOUT_SECONDS,
  ASK_USER_MIN_TIMEOUT_SECONDS,
  ASK_USER_UNATTENDED_TIMEOUT_SECONDS,
} from "../../renderer/shared/ask-user-question.js";
import {
  createAskUserQuestionExtension,
  resolveAskUserQuestionTimeoutMs,
  shouldEnableAskUserQuestionExtension,
} from "./ask-user-question-extension.js";
import { piRuntimeReplayPolicy } from "./pi-runtime-tool.js";

test("Ask User Question is limited to attended desktop workspace chat", () => {
  const base = {
    usageSource: "chat",
    interactionSurface: "desktop",
    assistantMode: false,
    botBound: false,
    rendererOwner: true,
    excluded: false,
  };
  assert.equal(shouldEnableAskUserQuestionExtension(base), true);
  assert.equal(shouldEnableAskUserQuestionExtension({ ...base, rendererOwner: false }), false);
  assert.equal(
    shouldEnableAskUserQuestionExtension({ ...base, rendererOwner: false, remoteOwner: true }),
    true,
  );
  assert.equal(
    shouldEnableAskUserQuestionExtension({ ...base, rendererOwner: false, remoteOwner: false }),
    false,
  );
  assert.equal(
    shouldEnableAskUserQuestionExtension({ ...base, interactionSurface: "telegram" }),
    false,
  );
  assert.equal(shouldEnableAskUserQuestionExtension({ ...base, assistantMode: true }), false);
  assert.equal(shouldEnableAskUserQuestionExtension({ ...base, botBound: true }), false);
});

test("tool returns selected and skipped answers without replaying an interruption", async () => {
  const extension = createAskUserQuestionExtension({
    request: async (_toolCallId, questions) => ({
      version: 1,
      promptId: "q-one",
      cancelled: false,
      answers: [{ questionIndex: 0, kind: "option", answer: questions[0]!.options[0]!.label }],
    }),
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  assert.equal(tool.executionMode, "sequential");
  assert.equal(piRuntimeReplayPolicy(tool), "never");
  const result = await tool.execute("call-one", {
    questions: [
      {
        question: "Which approach?",
        header: "Approach",
        options: [
          { label: "Direct", description: "Implement it now." },
          { label: "Guided", description: "Explain each step." },
        ],
      },
      {
        question: "How detailed?",
        header: "Detail",
        options: [
          { label: "Concise", description: "Only the essentials." },
          { label: "Detailed", description: "Include edge cases." },
        ],
      },
    ],
  });
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /Answer: Direct/u);
  assert.match(text, /Answer: Skipped/u);
});

const oneQuestion = [
  {
    question: "Which approach?",
    header: "Approach",
    options: [
      { label: "Direct", description: "Implement it now." },
      { label: "Guided", description: "Explain each step." },
    ],
  },
];

test("a timed-out questionnaire tells the agent to proceed on its own judgement", async () => {
  const requestedTimeouts: Array<number | undefined> = [];
  const extension = createAskUserQuestionExtension({
    request: async (_toolCallId, _questions, _signal, timeoutSeconds) => {
      requestedTimeouts.push(timeoutSeconds);
      return { version: 1, promptId: "q-one", cancelled: true, answers: [], timedOut: true };
    },
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  const result = await tool.execute("call-timed", { questions: oneQuestion, timeoutSeconds: 5 });
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /No answer was received/u);
  assert.match(text, /best judgement/u);
  assert.doesNotMatch(text, /closed the questionnaire/u);
  // Out-of-range requests are clamped into the supported window.
  assert.deepEqual(requestedTimeouts, [ASK_USER_MIN_TIMEOUT_SECONDS]);

  await tool.execute("call-untimed", { questions: oneQuestion });
  assert.deepEqual(requestedTimeouts, [ASK_USER_MIN_TIMEOUT_SECONDS, undefined]);
});

test("attended owners wait unless asked; unattended owners always get a capped deadline", () => {
  const cap = ASK_USER_UNATTENDED_TIMEOUT_SECONDS * 1_000;
  assert.equal(resolveAskUserQuestionTimeoutMs(undefined, { unattended: false }), undefined);
  assert.equal(resolveAskUserQuestionTimeoutMs(120, { unattended: false }), 120_000);
  assert.equal(
    resolveAskUserQuestionTimeoutMs(ASK_USER_MAX_TIMEOUT_SECONDS * 10, { unattended: false }),
    ASK_USER_MAX_TIMEOUT_SECONDS * 1_000,
  );
  assert.equal(resolveAskUserQuestionTimeoutMs(undefined, { unattended: true }), cap);
  assert.equal(resolveAskUserQuestionTimeoutMs(60, { unattended: true }), 60_000);
  assert.equal(resolveAskUserQuestionTimeoutMs(3_600, { unattended: true }), cap);
});
