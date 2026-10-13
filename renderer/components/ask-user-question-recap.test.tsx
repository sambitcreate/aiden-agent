import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AskUserQuestionRecap } from "./ask-user-question-recap.js";
import type { AskUserQuestionRecapV1 } from "../shared/ask-user-question.js";

function cards(markup: string): string[] {
  return [...markup.matchAll(/<li[^>]*>(.*?)<\/li>/gu)].map((match) =>
    match[1]!.replace(/<[^>]+>/gu, "|").replace(/\|+/gu, "|").replace(/^\||\|$/gu, ""),
  );
}

test("each answered question shows the question with the owner's choice beneath it", () => {
  const recap: AskUserQuestionRecapV1 = {
    version: 1,
    outcome: "answered",
    items: [
      { question: "Which database?", header: "Database", kind: "option", answers: ["Postgres"] },
      { question: "Which extras?", header: "Extras", kind: "multi", answers: ["Tests", "Docs"] },
      { question: "Where to deploy?", header: "Deploy", kind: "custom", answers: ["The staging bucket"] },
      { question: "Ship it?", header: "Ship", kind: "skipped", answers: [] },
    ],
  };
  const markup = renderToStaticMarkup(<AskUserQuestionRecap recap={recap} />);
  assert.match(markup, /<ul[^>]*aria-label="Your answers"/u);
  assert.deepEqual(cards(markup), [
    "Which database?|Postgres",
    "Which extras?|Tests, Docs",
    "Where to deploy?|“The staging bucket”",
    "Ship it?|Skipped",
  ]);
});

test("a closed or expired questionnaire says why nothing was chosen", () => {
  const item = { question: "Which database?", header: "Database", kind: "skipped" as const, answers: [] };
  const dismissed = renderToStaticMarkup(
    <AskUserQuestionRecap recap={{ version: 1, outcome: "dismissed", items: [item] }} />,
  );
  assert.deepEqual(cards(dismissed), ["Which database?|Dismissed"]);
  const expired = renderToStaticMarkup(
    <AskUserQuestionRecap recap={{ version: 1, outcome: "expired", items: [item] }} />,
  );
  assert.deepEqual(cards(expired), ["Which database?|No answer"]);
});
