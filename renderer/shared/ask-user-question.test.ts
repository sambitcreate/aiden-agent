import assert from "node:assert/strict";
import test from "node:test";
import {
  ASK_USER_MAX_LABEL_LENGTH,
  ASK_USER_QUESTION_VERSION,
  ASK_USER_RECAP_MAX_CUSTOM_LENGTH,
  askUserQuestionMsUntilExpiry,
  buildAskUserQuestionRecap,
  parseAskUserQuestionRecap,
  formatLateAskUserQuestionFollowUp,
  normalizeAskUserTimeoutSeconds,
  parseAskUserQuestionPrompt,
  parseAskUserQuestionResponse,
  parseAskUserQuestions,
  parseRecommendedOptionLabel,
  recommendedAskUserAnswers,
  retainExpiredAskUserQuestionForLateAnswer,
  summarizeAskUserQuestionResponse,
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

test("an answer summary reads as the person's reply", () => {
  const two = [
    { question: "Which colour?", header: "Colour", multiSelect: false, options: [{ label: "Blue", description: "b" }, { label: "Red", description: "r" }] },
    { question: "Which sizes?", header: "Sizes", multiSelect: true, options: [{ label: "S", description: "s" }, { label: "M", description: "m" }] },
  ];
  assert.equal(
    summarizeAskUserQuestionResponse(two.slice(0, 1), { cancelled: false, answers: [{ questionIndex: 0, kind: "option", answer: "Blue" }] }),
    "Blue",
  );
  assert.equal(
    summarizeAskUserQuestionResponse(two, { cancelled: false, answers: [{ questionIndex: 1, kind: "multi", selected: ["S", "M"] }] }),
    "Colour: Skipped\nSizes: S, M",
  );
  assert.equal(summarizeAskUserQuestionResponse(two, { cancelled: true, answers: [] }), "Skipped");
});

const recapQuestions = [
  { question: "Which colour?", header: "Colour", multiSelect: false, options: [{ label: "Blue", description: "b" }, { label: "Red", description: "r" }] },
  { question: "Which sizes?", header: "Sizes", multiSelect: true, options: [{ label: "S", description: "s" }, { label: "M", description: "m" }] },
  { question: "Anything else?", header: "Notes", multiSelect: false, options: [{ label: "No", description: "n" }, { label: "Yes", description: "y" }] },
  { question: "Ship it?", header: "Ship", multiSelect: false, options: [{ label: "Now", description: "n" }, { label: "Later", description: "l" }] },
];

test("a recap keeps each question beside what the owner chose", () => {
  const recap = buildAskUserQuestionRecap(recapQuestions, {
    cancelled: false,
    answers: [
      { questionIndex: 0, kind: "option", answer: "Blue" },
      { questionIndex: 1, kind: "multi", selected: ["M", "S"] },
      { questionIndex: 2, kind: "custom", answer: "Use the\u0007 staging bucket" },
    ],
  });
  assert.deepEqual(recap, {
    version: ASK_USER_QUESTION_VERSION,
    outcome: "answered",
    items: [
      { question: "Which colour?", header: "Colour", kind: "option", answers: ["Blue"] },
      { question: "Which sizes?", header: "Sizes", kind: "multi", answers: ["M", "S"] },
      // Terminal controls never reach the transcript.
      { question: "Anything else?", header: "Notes", kind: "custom", answers: ["Use the  staging bucket"] },
      { question: "Ship it?", header: "Ship", kind: "skipped", answers: [] },
    ],
  });
  assert.deepEqual(parseAskUserQuestionRecap(recap), recap);

  const long = buildAskUserQuestionRecap(recapQuestions.slice(2, 3), {
    cancelled: false,
    answers: [{ questionIndex: 0, kind: "custom", answer: "x".repeat(ASK_USER_RECAP_MAX_CUSTOM_LENGTH + 50) }],
  });
  const clipped = long?.items[0]?.answers[0] ?? "";
  assert.equal(Array.from(clipped).length, ASK_USER_RECAP_MAX_CUSTOM_LENGTH);
  assert.ok(clipped.endsWith("…"));
});

test("a closed or expired questionnaire records no answers, even ones the owner had picked", () => {
  const picked = [{ questionIndex: 0, kind: "option" as const, answer: "Blue" }];
  const dismissed = buildAskUserQuestionRecap(recapQuestions.slice(0, 1), { cancelled: true, answers: picked });
  assert.equal(dismissed?.outcome, "dismissed");
  assert.deepEqual(dismissed?.items.map((item) => item.kind), ["skipped"]);

  const expired = buildAskUserQuestionRecap(recapQuestions.slice(0, 1), {
    cancelled: true,
    timedOut: true,
    answers: picked,
  });
  assert.equal(expired?.outcome, "expired");
  assert.deepEqual(expired?.items.map((item) => item.kind), ["skipped"]);

  // A custom answer with nothing printable cannot produce a recap replay would reject.
  assert.equal(
    buildAskUserQuestionRecap(recapQuestions.slice(0, 1), {
      cancelled: false,
      answers: [{ questionIndex: 0, kind: "custom", answer: "\u0001\u0002" }],
    }),
    undefined,
  );
});

test("stored recaps are rejected unless every item is well formed", () => {
  const item = { question: "Which colour?", header: "Colour", kind: "option", answers: ["Blue"] };
  const valid = { version: ASK_USER_QUESTION_VERSION, outcome: "answered", items: [item] };
  assert.ok(parseAskUserQuestionRecap(valid));
  for (const invalid of [
    { ...valid, version: 2 },
    { ...valid, outcome: "pending" },
    { ...valid, items: [] },
    { ...valid, items: [item, item, item, item, item] },
    { ...valid, outcome: "dismissed" },
    { ...valid, items: [{ ...item, answers: [] }] },
    { ...valid, items: [{ ...item, answers: ["Blue", "Red"] }] },
    { ...valid, items: [{ ...item, kind: "multi", answers: ["S", "S"] }] },
    { ...valid, items: [{ ...item, kind: "skipped" }] },
    { ...valid, items: [{ ...item, kind: "custom", answers: ["\u001b[2Jclear"] }] },
    { ...valid, items: [{ ...item, answers: ["x".repeat(ASK_USER_MAX_LABEL_LENGTH + 1)] }] },
    { ...valid, items: [{ ...item, header: " " }] },
    { ...valid, items: [{ ...item, kind: "other" }] },
  ]) {
    assert.equal(parseAskUserQuestionRecap(invalid), undefined, JSON.stringify(invalid));
  }
});

test("an option the agent marks as recommended starts as the answer", () => {
  assert.deepEqual(parseRecommendedOptionLabel("Postgres (Recommended)"), { text: "Postgres", recommended: true });
  assert.deepEqual(parseRecommendedOptionLabel("Postgres(recommended)"), { text: "Postgres", recommended: true });
  // Only a trailing marker counts, and a bare marker is just a label.
  assert.deepEqual(parseRecommendedOptionLabel("(Recommended) Postgres"), { text: "(Recommended) Postgres", recommended: false });
  assert.deepEqual(parseRecommendedOptionLabel("(Recommended)"), { text: "(Recommended)", recommended: false });

  const marked = [
    { question: "Which database?", header: "Database", multiSelect: false, options: [{ label: "SQLite", description: "s" }, { label: "Postgres (Recommended)", description: "p" }, { label: "MySQL (recommended)", description: "m" }] },
    { question: "Which sizes?", header: "Sizes", multiSelect: true, options: [{ label: "S (Recommended)", description: "s" }, { label: "M", description: "m" }, { label: "L (Recommended)", description: "l" }] },
    { question: "Ship it?", header: "Ship", multiSelect: false, options: [{ label: "Now", description: "n" }, { label: "Later", description: "l" }] },
  ];
  const answers = recommendedAskUserAnswers(marked);
  // A single choice takes the first marked option, a multi-select every one, and an unmarked question none.
  assert.deepEqual([...answers.values()], [
    { questionIndex: 0, kind: "option", answer: "Postgres (Recommended)" },
    { questionIndex: 1, kind: "multi", selected: ["S (Recommended)", "L (Recommended)"] },
  ]);
  // The preselected answers are valid wire answers for the prompt they came from.
  const prompt = parseAskUserQuestionPrompt({ version: ASK_USER_QUESTION_VERSION, promptId: "q-1", streamId: "s-1", toolCallId: "tool-1", questions: marked });
  assert.ok(prompt);
  const response = parseAskUserQuestionResponse({ version: ASK_USER_QUESTION_VERSION, promptId: "q-1", cancelled: false, answers: [...answers.values()] }, prompt);
  assert.deepEqual(response?.answers, [...answers.values()]);

  // What the person sees afterwards drops the marker.
  assert.equal(summarizeAskUserQuestionResponse(marked, response!), "Database: Postgres\nSizes: S, L\nShip: Skipped");
  assert.deepEqual(
    buildAskUserQuestionRecap(marked, response!)?.items.map((item) => item.answers),
    [["Postgres"], ["S", "L"], []],
  );
});
