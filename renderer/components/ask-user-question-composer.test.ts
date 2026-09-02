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

test("Design questions stay in the persistent conversation rail and cannot focus while hidden", () => {
  const pane = source("../main/chat-pane.tsx");
  const component = source("./ask-user-question-composer.tsx");

  assert.match(component, /placement\?: "chat" \| "design-conversation"/u);
  assert.match(component, /placement = "chat"/u);
  assert.match(
    component,
    /placement === "design-conversation"\s*\? "w-full px-3 pb-3 pt-2"\s*: "aiden-dock-inset chat-content-column"/u,
  );
  assert.match(
    component,
    /placement === "design-conversation"\s*\? "max-h-\[min\(70vh,36rem\)\] overflow-y-auto px-3 py-3"/u,
  );
  assert.match(
    pane,
    /onQuestionnaire: \(prompt\) => \{[\s\S]{0,260}setDesignConversationOpen\(true\);[\s\S]{0,180}setQuestionnaire\(prompt\)/u,
  );
  assert.match(
    pane,
    /const designConversationMustStayOpen =[\s\S]{0,340}questionnaire[\s\S]{0,340}isGenerating/u,
  );
  assert.match(
    pane,
    /if \(designConversationMustStayOpen\) setDesignConversationOpen\(true\)/u,
  );
  assert.match(
    pane,
    /ref=\{designConversationToggleRef\}[\s\S]{0,260}disabled=\{designConversationOpen && designConversationMustStayOpen\}/u,
  );
  assert.match(
    pane,
    /requestAnimationFrame\(\(\) => designConversationToggleRef\.current\?\.focus\(\)\)/u,
  );
  assert.match(pane, /onRequestComposerFocus=\{focusComposer\}/u);
});

test("cancelled Design drafts expose only the two main-owned resolution choices", () => {
  const component = source("./ask-user-question-composer.tsx");
  const pane = source("../main/chat-pane.tsx");

  assert.match(component, /prompt\.kind === "design-cancel-draft"/u);
  assert.match(
    component,
    /aria-label="Question navigation"\s+hidden=\{isDesignDraftDecision\}[\s\S]{0,1600}aria-label="Close questionnaire"/u,
  );
  assert.match(
    component,
    /className="mt-3 flex min-h-12 items-end gap-3" hidden=\{isDesignDraftDecision\}[\s\S]{0,3200}Type your own answer[\s\S]{0,1600}"Sending…" : "Skip"/u,
  );
  assert.match(component, /role=\{question\.multiSelect \? "group" : "radiogroup"\}/u);
  assert.match(component, /ref=\{optionIndex === 0 \? firstOptionRef : undefined\}/u);
  const questionnaireHandler = pane.slice(
    pane.indexOf("onQuestionnaire: (prompt) =>"),
    pane.indexOf("onTodo: (snapshot) =>"),
  );
  assert.doesNotMatch(questionnaireHandler, /setStreamingArtifacts|streamingArtifactsRef/u);
  const answerHandler = pane.slice(
    pane.indexOf("const answerQuestionnaire = React.useCallback"),
    pane.indexOf("const openFolder = React.useCallback"),
  );
  const acknowledgement = answerHandler.indexOf("await chatsApi.answerQuestionnaire");
  const discardClear = answerHandler.indexOf("if (discardsCancelledDesignDraft");
  assert.ok(acknowledgement >= 0 && discardClear > acknowledgement);
  assert.match(
    answerHandler,
    /if \(discardsCancelledDesignDraft\(questionnaire, response\)\) \{\s+setStreamingArtifacts\(\[\]\);\s+streamingArtifactsRef\.current = \[\];\s+setDesignProjectReconciliation\(undefined\);/u,
  );
  assert.ok(
    answerHandler.indexOf("focusComposer();") > answerHandler.indexOf("setQuestionnaire(null);"),
    "the remounted composer regains focus after the decision is acknowledged",
  );
});
