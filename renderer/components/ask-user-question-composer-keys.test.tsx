import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  ASK_USER_QUESTION_VERSION,
  type AskUserQuestionPromptV1,
  type AskUserQuestionResponseV1,
  type AskUserQuestionV1,
} from "../shared/ask-user-question";
import { AskUserQuestionComposer } from "./ask-user-question-composer";

afterEach(cleanup);

function question(header: string, multiSelect = false): AskUserQuestionV1 {
  return {
    question: `Which ${header.toLowerCase()}?`,
    header,
    multiSelect,
    options: [
      { label: `${header} A`, description: "First" },
      { label: `${header} B`, description: "Second" },
    ],
  };
}

function mount(questions: AskUserQuestionV1[]) {
  const responses: AskUserQuestionResponseV1[] = [];
  const prompt: AskUserQuestionPromptV1 = {
    version: ASK_USER_QUESTION_VERSION,
    promptId: "prompt-1",
    streamId: "stream-1",
    toolCallId: "tool-1",
    questions,
  };
  render(<AskUserQuestionComposer prompt={prompt} onRespond={(response) => void responses.push(response)} />);
  const card = screen.getByRole("region");
  return { card, responses };
}

function hintText(): string | null {
  return document.querySelector("kbd")?.closest("p")?.textContent ?? null;
}

test("a number picks an answer, Enter moves on, and Esc skips the last question", () => {
  const { card, responses } = mount([question("Database"), question("Region")]);
  assert.equal(hintText(), "1–2choose↵nextescskip");

  fireEvent.keyDown(card, { key: "2" });
  const chosen = screen.getByRole("button", { name: /Database B/u });
  assert.equal(chosen.getAttribute("aria-pressed"), "true");
  assert.equal(document.activeElement, chosen);

  fireEvent.keyDown(chosen, { key: "Enter" });
  assert.equal(screen.getByRole("tab", { name: /2\. Region/u }).getAttribute("aria-selected"), "true");
  assert.equal(hintText(), "1–2choose↵submitescskip");

  fireEvent.keyDown(screen.getByRole("region"), { key: "Escape" });
  assert.deepEqual(responses.map((response) => [response.cancelled, response.answers]), [
    [false, [{ questionIndex: 0, kind: "option", answer: "Database B" }]],
  ]);
});

test("Enter on a row that is not the current answer chooses it instead of moving on", () => {
  const { card, responses } = mount([question("Database"), question("Region")]);
  fireEvent.keyDown(card, { key: "1" });
  const other = screen.getByRole("button", { name: /Database B/u });
  // Enter on a button is a native click; the row handler must leave it alone.
  assert.equal(fireEvent.keyDown(other, { key: "Enter" }), true);
  assert.equal(screen.getByRole("tab", { name: /1\. Database/u }).getAttribute("aria-selected"), "true");
  assert.deepEqual(responses, []);
});

test("multi-select toggles by number and submits with Command-Enter", () => {
  const { card, responses } = mount([question("Extras", true)]);
  assert.equal(hintText(), "1–2toggle⌘↵submitescskip");
  fireEvent.keyDown(card, { key: "1" });
  fireEvent.keyDown(card, { key: "2" });
  fireEvent.keyDown(card, { key: "Enter", metaKey: true });
  assert.deepEqual(responses.map((response) => response.answers), [
    [{ questionIndex: 0, kind: "multi", selected: ["Extras A", "Extras B"] }],
  ]);
});

test("the shortcut footnote steps aside while a custom answer is being written", () => {
  const { card, responses } = mount([question("Database")]);
  fireEvent.click(screen.getByRole("button", { name: /Type your own answer/u }));
  assert.equal(hintText(), null);
  // Typing numbers and Esc belong to the text field, not the card.
  fireEvent.keyDown(card, { key: "1" });
  assert.equal(screen.getByRole("button", { name: /Database A/u }).getAttribute("aria-pressed"), "false");
  assert.deepEqual(responses, []);
});

// The composer moves focus on the next animation frame. Compare by identity: a
// failing assert.equal would try to print the whole happy-dom node graph.
function expectFocusOn(role: "button" | "textbox", name: RegExp) {
  return waitFor(() =>
    assert.ok(
      document.activeElement === screen.getByRole(role, { name }),
      `focus is on <${document.activeElement?.tagName}> ${document.activeElement?.textContent ?? ""}`,
    ),
  );
}

test("moving to the next question keeps focus in the card so shortcuts keep working", async () => {
  const { responses } = mount([question("Database"), question("Region")]);
  await expectFocusOn("button", /Database A/u);

  fireEvent.keyDown(document.activeElement!, { key: "1" });
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  // Keys reach the card only through the focused element, so focus must not fall to the body.
  await expectFocusOn("button", /Region A/u);

  fireEvent.keyDown(document.activeElement!, { key: "2" });
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  assert.deepEqual(responses.map((response) => response.answers), [
    [
      { questionIndex: 0, kind: "option", answer: "Database A" },
      { questionIndex: 1, kind: "option", answer: "Region B" },
    ],
  ]);
});

test("closing a custom answer with Esc hands focus back to the options", async () => {
  mount([question("Database")]);
  fireEvent.click(screen.getByRole("button", { name: /Type your own answer/u }));
  await expectFocusOn("textbox", /Custom answer/u);

  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await expectFocusOn("button", /Database A/u);
  fireEvent.keyDown(document.activeElement!, { key: "2" });
  assert.equal(screen.getByRole("button", { name: /Database B/u }).getAttribute("aria-pressed"), "true");
});

test("Enter that confirms an IME composition leaves the custom answer unsent", () => {
  const { responses } = mount([question("Database")]);
  fireEvent.click(screen.getByRole("button", { name: /Type your own answer/u }));
  const textarea = screen.getByRole("textbox", { name: /Custom answer/u });
  fireEvent.change(textarea, { target: { value: "にほんご" } });
  // The IME's candidate confirmation arrives as Enter while still composing.
  fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
  assert.equal(responses.length, 0, "a composing Enter submitted the questionnaire");
  assert.ok(screen.queryByRole("textbox", { name: /Custom answer/u }) !== null, "the custom answer stays open");

  fireEvent.keyDown(textarea, { key: "Enter" });
  assert.deepEqual(responses.map((response) => response.answers), [
    [{ questionIndex: 0, kind: "custom", answer: "にほんご" }],
  ]);
});
