import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AskUserQuestionExpiryNotice } from "./ask-user-question-expiry-notice.js";

const noop = () => undefined;

function buttonLabels(markup: string): string[] {
  return [...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/gu)].map((match) => match[1]!);
}

test("an expired questionnaire explains that Aiden moved on without offering actions", () => {
  const markup = renderToStaticMarkup(<AskUserQuestionExpiryNotice state="expired" />);
  assert.match(markup, /role="status"/u);
  assert.match(markup, /continued with its best judgement/u);
  assert.deepEqual(buttonLabels(markup), []);
});

test("a late answer offers to send or discard, and queues while a response streams", () => {
  const idle = renderToStaticMarkup(
    <AskUserQuestionExpiryNotice state="late-answer" onSend={noop} onDiscard={noop} />,
  );
  assert.deepEqual(buttonLabels(idle), ["Discard", "Send as follow-up"]);

  const streaming = renderToStaticMarkup(
    <AskUserQuestionExpiryNotice state="late-answer" queued onSend={noop} onDiscard={noop} />,
  );
  assert.deepEqual(buttonLabels(streaming), ["Discard", "Queue follow-up"]);
  assert.match(streaming, /once the current response finishes/u);

  const sending = renderToStaticMarkup(
    <AskUserQuestionExpiryNotice state="late-answer" sending onSend={noop} onDiscard={noop} />,
  );
  assert.deepEqual(buttonLabels(sending), ["Discard", "Sending…"]);
  assert.equal([...sending.matchAll(/<button[^>]*disabled=""/gu)].length, 2);
});
