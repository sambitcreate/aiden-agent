import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BtwCard, reduceBtwView, type BtwLiveView } from "./btw-card.js";

const noop = () => undefined;

test("BTW reducer orders deltas, resets overflow attempts, and settles authoritatively", () => {
  let view = reduceBtwView(null, {
    version: 1,
    chatId: "chat-1",
    requestId: "btw-1",
    sequence: 0,
    type: "started",
    question: "Why?",
    hasHistory: false,
    contextTrimmed: false,
  });
  view = reduceBtwView(view, {
    version: 1, chatId: "chat-1", requestId: "btw-1", sequence: 1, type: "delta", delta: "draft",
  });
  view = reduceBtwView(view, {
    version: 1, chatId: "chat-1", requestId: "btw-1", sequence: 2, type: "reset",
  });
  view = reduceBtwView(view, {
    version: 1,
    chatId: "chat-1",
    requestId: "btw-1",
    sequence: 3,
    type: "terminal",
    status: "completed",
    answer: "final",
    contextTrimmed: true,
  });
  assert.equal(view?.answer, "final");
  assert.equal(view?.status, "completed");
  assert.equal(view?.hasHistory, true);
  assert.equal(view?.contextTrimmed, true);
});

test("BTW starting card disables cancel and close until the cancellable receipt exists", () => {
  const view: BtwLiveView = {
    requestId: "pending",
    question: "What changed?",
    answer: "",
    status: "starting",
    hasHistory: false,
    contextTrimmed: false,
    sequence: -1,
  };
  const markup = renderToStaticMarkup(
    <BtwCard view={view} onAsk={noop} onCancel={noop} onClear={noop} onClose={noop} />,
  );
  assert.match(markup, /aria-label="Cancel side question" disabled=""/u);
  assert.match(markup, /aria-label="Close side question" disabled=""/u);
  assert.match(markup, /Questions and answers are not added to the transcript/u);
});

test("BTW composer dispatch returns before durable chat append", () => {
  const pane = readFileSync(new URL("../main/chat-pane.tsx", import.meta.url), "utf8");
  const branch = pane.indexOf("if (options?.btw)");
  const start = pane.indexOf("await chatsApi.btwStart", branch);
  const branchReturn = pane.indexOf("return;", start);
  const append = pane.indexOf("await chatsApi.appendMessage", branch);
  assert.ok(branch >= 0 && branch < start && start < branchReturn && branchReturn < append);
});

test("BTW slash eligibility is scoped to ordinary chat surfaces", () => {
  const pane = readFileSync(new URL("../main/chat-pane.tsx", import.meta.url), "utf8");
  assert.match(pane, /presentation === "design"/u);
  assert.match(pane, /chat\.data\?\.botId \|\| bot\.data/u);
  assert.match(pane, /effectiveWorkspaceId === ASSISTANT_WORKSPACE_ID/u);
  assert.match(pane, /sideQuestionBlockedReason=\{sideQuestionBlockedReason\}/u);
});
