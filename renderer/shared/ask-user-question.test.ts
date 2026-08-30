import assert from "node:assert/strict";
import test from "node:test";
import {
  ASK_USER_QUESTION_VERSION,
  parseAskUserQuestionPrompt,
  parseAskUserQuestionResponse,
  parseAskUserQuestions,
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
