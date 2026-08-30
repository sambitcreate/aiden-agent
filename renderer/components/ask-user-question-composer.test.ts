import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
  assert.match(component, /rounded-\[24px\] bg-popover/u);
  assert.match(component, /\{activeIndex \+ 1\} of \{prompt\.questions\.length\}/u);
  assert.match(component, /Type your own answer/u);
  assert.match(component, /"Sending…" : "Skip"/u);
  assert.match(component, /role=\{question\.multiSelect \? "checkbox" : "radio"\}/u);
  assert.match(component, /aria-checked=\{selected\}/u);
  assert.match(styles, /\.ask-user-question-option:focus-visible/u);
  assert.match(styles, /@keyframes ask-user-question-in/u);
});
