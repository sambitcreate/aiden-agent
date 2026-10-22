import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatRowStatus } from "./chat-row-status.js";

function labels(markup: string): string[] {
  return [...markup.matchAll(/aria-label="([^"]+)"/gu)].map((match) => match[1]!);
}

test("idle read rows render no trailing status at all", () => {
  assert.equal(renderToStaticMarkup(<ChatRowStatus state="idle" unread={false} />), "");
});

test("each row state exposes one accessible label and hides decorative glyphs", () => {
  const expected = {
    needs_approval: "Needs approval",
    needs_input: "Needs input",
    working: "Working",
  } as const;
  for (const [state, label] of Object.entries(expected)) {
    const markup = renderToStaticMarkup(
      <ChatRowStatus state={state as keyof typeof expected} unread={false} />,
    );
    assert.deepEqual(labels(markup), [label], state);
    assert.match(markup, /<svg[^>]*aria-hidden="true"/u, state);
  }
});

test("unread is independent of state so a working chat can still carry an earlier reply", () => {
  assert.deepEqual(labels(renderToStaticMarkup(<ChatRowStatus state="idle" unread />)), ["Unread"]);
  assert.deepEqual(labels(renderToStaticMarkup(<ChatRowStatus state="working" unread />)), [
    "Working",
    "Unread",
  ]);
});

test("an unseen failed turn says Failed in place of the new-reply dot", () => {
  const failed = renderToStaticMarkup(<ChatRowStatus state="idle" unread failed />);
  assert.deepEqual(labels(failed), ["Failed"]);
  assert.match(failed, />Failed</u);
  assert.match(failed, /bg-status-red-surface/u);
  assert.doesNotMatch(failed, /\bborder\b|\boutline\b|\bring-/u);
  // A failure the user already saw is just an idle row.
  assert.equal(renderToStaticMarkup(<ChatRowStatus state="idle" unread={false} failed />), "");
  // A new run keeps its live state next to the earlier failure.
  assert.deepEqual(labels(renderToStaticMarkup(<ChatRowStatus state="working" unread failed />)), [
    "Working",
    "Failed",
  ]);
});

test("attention pills use soft status fills without decorative borders", () => {
  for (const state of ["needs_approval", "needs_input"] as const) {
    const markup = renderToStaticMarkup(<ChatRowStatus state={state} unread={false} />);
    assert.match(markup, /bg-status-(warning|accent)-surface/u, state);
    assert.doesNotMatch(markup, /\bborder\b|\boutline\b|\bring-/u, state);
  }
});
