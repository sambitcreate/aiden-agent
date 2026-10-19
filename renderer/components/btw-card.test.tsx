// Installs happy-dom for the Testing Library cases; must stay the first import.
import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach, mock } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BtwCard, reduceBtwView, type BtwCardView, type BtwLiveView } from "./btw-card.js";
import { toast } from "./ui";

const noop = () => undefined;

afterEach(cleanup);

const answered: BtwCardView = {
  requestId: "btw-1",
  question: "Why?",
  answer: "Because.",
  status: "completed",
  hasHistory: true,
  contextTrimmed: false,
};

function followUp(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: /follow-up/u }) as HTMLTextAreaElement;
}

test("BTW follow-up ignores the Enter that confirms an IME composition", () => {
  const asked: string[] = [];
  render(<BtwCard view={answered} onAsk={(question) => void asked.push(question)} onCancel={noop} onClear={noop} onClose={noop} />);
  const textarea = followUp();
  fireEvent.change(textarea, { target: { value: "にほんご" } });
  fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
  assert.deepEqual(asked, [], "a composing Enter sent the follow-up");
  assert.equal(textarea.value, "にほんご");

  fireEvent.keyDown(textarea, { key: "Enter" });
  assert.deepEqual(asked, ["にほんご"]);
  assert.equal(textarea.value, "");
});

test("BTW follow-up keeps the question and reports the error when the send is refused", async () => {
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown) => void rejections.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const toastError = mock.method(toast, "error", () => "toast-id");
  try {
    render(
      <BtwCard
        view={answered}
        onAsk={() => Promise.reject(new Error("Side questions are not available."))}
        onCancel={noop}
        onClear={noop}
        onClose={noop}
      />,
    );
    const textarea = followUp();
    fireEvent.change(textarea, { target: { value: "why?" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => assert.equal(toastError.mock.callCount(), 1));
    assert.deepEqual(toastError.mock.calls[0].arguments, ["Side questions are not available."]);
    assert.equal(followUp().value, "why?", "the follow-up text was dropped after the send failed");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(rejections, []);
  } finally {
    toastError.mock.restore();
    process.off("unhandledRejection", onUnhandled);
  }
});

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
  assert.match(pane, /Send the first message before asking a side question/u);
  assert.match(pane, /effectiveWorkspaceId === ASSISTANT_WORKSPACE_ID/u);
  assert.match(pane, /sideQuestionBlockedReason=\{sideQuestionBlockedReason\}/u);
});
