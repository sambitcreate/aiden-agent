import assert from "node:assert/strict";
import test from "node:test";
import {
  ASK_USER_QUESTION_VERSION,
  askUserQuestionMsUntilExpiry,
  formatLateAskUserQuestionFollowUp,
  normalizeAskUserTimeoutSeconds,
  parseAskUserQuestionPrompt,
  parseAskUserQuestionResponse,
  parseAskUserQuestions,
  retainExpiredAskUserQuestionForLateAnswer,
} from "./ask-user-question.js";

const questions = [
  {
    question: "How should I help?",
    header: "Approach",
    options: [
      { label: "Do it", description: "Take action and produce the result." },
      { label: "Guide me", description: "Walk through it collaboratively." },
    ],
  },
];

test("questionnaire contract normalizes the bounded upstream shape", () => {
  assert.deepEqual(parseAskUserQuestions(questions), [{ ...questions[0], multiSelect: false }]);
  assert.equal(parseAskUserQuestions([]), undefined);
  assert.equal(
    parseAskUserQuestions([
      { ...questions[0], options: [...questions[0]!.options, questions[0]!.options[0]] },
    ]),
    undefined,
  );
  assert.equal(
    parseAskUserQuestions([
      {
        ...questions[0],
        options: [
          { label: "Other", description: "Reserved for the automatic custom row." },
          questions[0]!.options[1],
        ],
      },
    ]),
    undefined,
  );
});

test("renderer accepts only owner-routed prompt envelopes and advertised answers", () => {
  const prompt = parseAskUserQuestionPrompt({
    version: ASK_USER_QUESTION_VERSION,
    promptId: "q-one",
    streamId: "s-one",
    toolCallId: "provider_call-one",
    questions,
  });
  assert.ok(prompt);
  assert.deepEqual(
    parseAskUserQuestionResponse(
      {
        version: ASK_USER_QUESTION_VERSION,
        promptId: "q-one",
        cancelled: false,
        answers: [{ questionIndex: 0, kind: "option", answer: "Guide me" }],
      },
      prompt,
    ),
    {
      version: ASK_USER_QUESTION_VERSION,
      promptId: "q-one",
      cancelled: false,
      answers: [{ questionIndex: 0, kind: "option", answer: "Guide me" }],
    },
  );
  assert.equal(
    parseAskUserQuestionResponse(
      {
        version: ASK_USER_QUESTION_VERSION,
        promptId: "q-one",
        cancelled: false,
        answers: [{ questionIndex: 0, kind: "option", answer: "Invented" }],
      },
      prompt,
    ),
    undefined,
  );
});

test("prompt deadlines are strict instants and owners cannot forge a timeout", () => {
  const envelope = {
    version: ASK_USER_QUESTION_VERSION,
    promptId: "q-timed",
    streamId: "s-timed",
    toolCallId: "call-timed",
    questions,
  };
  const timed = parseAskUserQuestionPrompt({ ...envelope, expiresAt: "2026-09-27T10:05:00.000Z" });
  assert.equal(timed?.expiresAt, "2026-09-27T10:05:00.000Z");
  assert.equal(parseAskUserQuestionPrompt({ ...envelope, expiresAt: "in five minutes" }), undefined);
  assert.equal(
    parseAskUserQuestionPrompt({ ...envelope, expiresAt: "September 27, 2026 10:05" }),
    undefined,
  );
  assert.ok(timed);
  const now = Date.parse("2026-09-27T10:04:00.000Z");
  assert.equal(askUserQuestionMsUntilExpiry(timed, now), 60_000);
  assert.equal(askUserQuestionMsUntilExpiry(timed, now + 120_000), 0);
  assert.equal(askUserQuestionMsUntilExpiry({}, now), undefined);
  assert.equal(retainExpiredAskUserQuestionForLateAnswer(timed, now), null);
  assert.equal(retainExpiredAskUserQuestionForLateAnswer(timed, now + 120_000), timed);
  assert.equal(retainExpiredAskUserQuestionForLateAnswer({ ...timed, expiresAt: undefined }, now), null);

  const response = parseAskUserQuestionResponse(
    {
      version: ASK_USER_QUESTION_VERSION,
      promptId: "q-timed",
      cancelled: true,
      answers: [],
      timedOut: true,
    },
    timed,
  );
  assert.equal(response?.timedOut, undefined);
});

test("timeout requests clamp into the supported window", () => {
  assert.equal(normalizeAskUserTimeoutSeconds(undefined), undefined);
  assert.equal(normalizeAskUserTimeoutSeconds("300"), undefined);
  assert.equal(normalizeAskUserTimeoutSeconds(Number.NaN), undefined);
  assert.equal(normalizeAskUserTimeoutSeconds(1), 30);
  assert.equal(normalizeAskUserTimeoutSeconds(299.6), 300);
  assert.equal(normalizeAskUserTimeoutSeconds(86_400), 3_600);
});

test("a late answer becomes a readable follow-up and an empty one offers nothing", () => {
  const parsed = parseAskUserQuestions([
    ...questions,
    {
      question: "Which extras?",
      header: "Extras",
      multiSelect: true,
      options: [
        { label: "Tests", description: "Add tests." },
        { label: "Docs", description: "Update docs." },
      ],
    },
  ]);
  assert.ok(parsed);
  const followUp = formatLateAskUserQuestionFollowUp(parsed, [
    { questionIndex: 1, kind: "multi", selected: ["Tests", "Docs"] },
  ]);
  assert.ok(followUp);
  assert.match(followUp, /expired before I replied/u);
  assert.match(followUp, /1\. How should I help\?\nAnswer: Skipped/u);
  assert.match(followUp, /2\. Which extras\?\nAnswer: Tests, Docs/u);
  assert.equal(formatLateAskUserQuestionFollowUp(parsed, []), undefined);
});
