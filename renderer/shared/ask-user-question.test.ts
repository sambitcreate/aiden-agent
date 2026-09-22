import assert from "node:assert/strict";
import test from "node:test";
import {
  ASK_USER_QUESTION_VERSION,
  discardsCancelledDesignDraft,
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

test("renderer preserves the main-owned cancelled Design draft decision kind", () => {
  const prompt = parseAskUserQuestionPrompt({
    version: ASK_USER_QUESTION_VERSION,
    promptId: "q-design-draft",
    streamId: "s-design-draft",
    toolCallId: "design-cancel-draft",
    kind: "design-cancel-draft",
    questions: [
      {
        question: "Keep this partial design?",
        header: "Stopped design",
        options: [
          { label: "Keep draft", description: "Save it as a Design revision." },
          { label: "Discard", description: "Delete the partial design." },
        ],
      },
    ],
  });
  assert.equal(prompt?.kind, "design-cancel-draft");
  assert.ok(prompt);
  assert.equal(
    discardsCancelledDesignDraft(prompt, {
      version: ASK_USER_QUESTION_VERSION,
      promptId: prompt.promptId,
      cancelled: false,
      answers: [{ questionIndex: 0, kind: "option", answer: "Discard" }],
    }),
    true,
  );
  assert.equal(
    discardsCancelledDesignDraft(prompt, {
      version: ASK_USER_QUESTION_VERSION,
      promptId: prompt.promptId,
      cancelled: false,
      answers: [{ questionIndex: 0, kind: "option", answer: "Keep draft" }],
    }),
    false,
  );
  assert.equal(
    parseAskUserQuestionResponse(
      {
        version: ASK_USER_QUESTION_VERSION,
        promptId: prompt.promptId,
        cancelled: false,
        answers: [{ questionIndex: 0, kind: "custom", answer: "Maybe" }],
      },
      prompt,
    ),
    undefined,
  );
  assert.equal(
    parseAskUserQuestionPrompt({
      ...prompt,
      questions: [
        {
          ...prompt.questions[0],
          options: [...prompt.questions[0]!.options].reverse(),
        },
      ],
    }),
    undefined,
  );
});
