import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ASK_USER_QUESTION_VERSION, type AskUserQuestionPromptV1 } from "../shared/ask-user-question.js";
import { AskUserQuestionComposer } from "./ask-user-question-composer.js";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("structured questions fully replace the composer with the reference card", () => {
  const pane = source("../main/chat-pane.tsx");
  const component = source("./ask-user-question-composer.tsx");
  const styles = source("../styles.css");
  assert.match(
    pane,
    /questionnaire \? \([\s\S]*<AskUserQuestionComposer[\s\S]*\) : \([\s\S]*<Composer/u,
  );
  assert.match(component, /rounded-sheet bg-popover/u);
  assert.match(styles, /--radius-sheet: 24px;/u);
  assert.match(component, /\{activeIndex \+ 1\} of \{prompt\.questions\.length\}/u);
  assert.match(component, /Type your own answer/u);
  assert.match(component, /"Sending…" : "Skip"/u);
  assert.match(styles, /\.ask-user-question-option:focus-visible/u);
  assert.match(styles, /@keyframes ask-user-question-in/u);
});

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
  // Activating an option answers and advances, so it must not claim radio
  // semantics whose arrow-key selection it cannot honour.
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
