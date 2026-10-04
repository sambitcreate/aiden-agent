import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AskUserQuestionCountdown,
  AskUserQuestionExpiryNotice,
} from "./ask-user-question-expiry-notice.js";

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

test("an open question shows a quiet countdown and announces only near the deadline", () => {
  const now = Date.parse("2026-10-03T12:00:00.000Z");
  const early = renderToStaticMarkup(
    <AskUserQuestionCountdown expiresAt="2026-10-03T12:01:24.000Z" initialNow={now} />,
  );
  assert.match(early, /continues on its own in 1:24/u);
  assert.match(early, /role="status"[^>]*><\/span>/u, "nothing is announced early");

  const late = renderToStaticMarkup(
    <AskUserQuestionCountdown expiresAt="2026-10-03T12:00:20.000Z" initialNow={now} />,
  );
  assert.match(late, /continues on its own in 0:20/u);
  assert.match(late, /role="status"[^>]*>Less than 30 seconds left to answer/u);

  const expired = renderToStaticMarkup(
    <AskUserQuestionCountdown expiresAt="2026-10-03T11:59:00.000Z" initialNow={now} />,
  );
  assert.equal(expired, "");
});
