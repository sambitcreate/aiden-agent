import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ASK_USER_QUESTION_VERSION, type AskUserQuestionPromptV1 } from "../shared/ask-user-question.js";
import { AskUserQuestionComposer } from "./ask-user-question-composer.js";

function prompt(multiSelect: boolean): AskUserQuestionPromptV1 {
  return {
    version: ASK_USER_QUESTION_VERSION,
    promptId: "prompt-1",
    streamId: "stream-1",
    toolCallId: "tool-1",
    questions: [
      {
        question: "Which database?",
        header: "Database",
        multiSelect,
        options: [
          { label: "Postgres", description: "Relational" },
          { label: "SQLite", description: "Embedded" },
        ],
      },
    ],
  };
}

function optionButtons(markup: string): string[] {
  return [...markup.matchAll(/<button[^>]*class="[^"]*ask-user-question-option[^"]*"[^>]*>/gu)].map(
    (match) => match[0],
  );
}

test("single-select options are action buttons, multi-select options are checkboxes", () => {
  const single = renderToStaticMarkup(
    createElement(AskUserQuestionComposer, { prompt: prompt(false), onRespond: () => undefined }),
  );
  const singleOptions = optionButtons(single);
  assert.equal(singleOptions.length, 2);
  // Single answers use toggle buttons; the question tabs own arrow navigation.
  assert.doesNotMatch(single, /role="radio(group)?"/u);
  for (const option of singleOptions) assert.doesNotMatch(option, /aria-checked/u);

  const multi = renderToStaticMarkup(
    createElement(AskUserQuestionComposer, { prompt: prompt(true), onRespond: () => undefined }),
  );
  const multiOptions = optionButtons(multi);
  assert.equal(multiOptions.length, 2);
  for (const option of multiOptions) {
    assert.match(option, /role="checkbox"/u);
    assert.match(option, /aria-checked="false"/u);
  }
});

test("questions expose one active panel and a tab for every question", () => {
  const value = prompt(false);
  value.questions.push({ ...value.questions[0]!, header: "Timing", question: "When should it run?" });
  const markup = renderToStaticMarkup(createElement(AskUserQuestionComposer, { prompt: value, onRespond: () => undefined }));
  assert.equal((markup.match(/role="tab"/g) ?? []).length, 2);
  assert.equal((markup.match(/role="tabpanel"/g) ?? []).length, 1);
  assert.match(markup, /1. Database/);
  assert.match(markup, /2. Timing/);
  assert.doesNotMatch(markup, /When should it run\?/);
});
