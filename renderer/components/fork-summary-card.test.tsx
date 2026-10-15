import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ForkSummaryCard } from "./fork-summary-card.js";
import type { ChatForkSummaryV1 } from "../shared/chat-copy-contract.js";

const noop = () => {};

function render(summary: ChatForkSummaryV1, options: { busy?: boolean; defaultOpen?: boolean } = {}) {
  return renderToStaticMarkup(
    <ForkSummaryCard summary={summary} onCancel={noop} onRetry={noop} onSkip={noop} {...options} />,
  );
}

function buttons(markup: string): { label: string; disabled: boolean }[] {
  return [...markup.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/gu)].map(([, attributes, body]) => ({
    label: body!.replace(/<[^>]+>/gu, "").trim(),
    disabled: /\sdisabled=""/u.test(attributes!),
  }));
}

test("a pending summary announces progress and offers only Cancel", () => {
  const markup = render({ state: "pending", afterMessageId: "a1", instructions: "the parser bug" });
  assert.match(markup, /aria-busy="true"/u);
  assert.match(markup, /role="status"[^>]*>Summarizing the original chat…/u);
  assert.match(markup, /Focus: the parser bug/u);
  assert.deepEqual(buttons(markup), [{ label: "Cancel", disabled: false }]);
});

test("a failed summary explains the error and offers Retry or Continue without summary", () => {
  const markup = render({ state: "failed", afterMessageId: "a1", error: "Summary cancelled." });
  assert.match(markup, /role="alert"[^>]*>Summary cancelled\./u);
  assert.deepEqual(buttons(markup), [
    { label: "Retry", disabled: false },
    { label: "Continue without summary", disabled: false },
  ]);
});

test("summary actions wait while one is in flight", () => {
  for (const summary of [
    { state: "pending", afterMessageId: "a1" },
    { state: "failed", afterMessageId: "a1" },
  ] satisfies ChatForkSummaryV1[]) {
    assert.ok(buttons(render(summary, { busy: true })).every((button) => button.disabled));
  }
});

test("a ready summary stays collapsed until opened, then shows its text and files", () => {
  const summary: ChatForkSummaryV1 = {
    state: "ready",
    afterMessageId: "a1",
    text: "Fixed **the parser**.",
    files: { read: ["src/a.ts"], modified: ["src/b.ts"] },
  };
  const collapsed = render(summary);
  assert.match(collapsed, /aria-expanded="false"/u);
  assert.doesNotMatch(collapsed, /the parser/u);
  assert.doesNotMatch(collapsed, /src\/a\.ts/u);

  const open = render(summary, { defaultOpen: true });
  assert.match(open, /aria-expanded="true"/u);
  assert.match(open, /<strong>the parser<\/strong>/u);
  assert.match(open, /aria-label="Read files"[\s\S]*src\/a\.ts/u);
  assert.match(open, /aria-label="Modified files"[\s\S]*src\/b\.ts/u);
});

test("a ready summary without files lists none", () => {
  const open = render({ state: "ready", afterMessageId: "a1", text: "Nothing changed." }, { defaultOpen: true });
  assert.doesNotMatch(open, /files"/u);
});
