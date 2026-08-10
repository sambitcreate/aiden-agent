import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBubble } from "./message-bubble.js";

test("user messages render only safe skill provenance", () => {
  const markup = renderToStaticMarkup(
    <MessageBubble
      role="user"
      content="Inspect this."
      skill={{ version: 1, name: "Review", source: "workspace" }}
    />,
  );
  assert.match(markup, /Review/u);
  assert.match(markup, /workspace skill/u);
  assert.doesNotMatch(markup, /invocationId|instructions|SKILL\.md/u);
});

test("legacy messages render unchanged without provenance", () => {
  const markup = renderToStaticMarkup(<MessageBubble role="user" content="Legacy message" />);
  assert.match(markup, /Legacy message/u);
  assert.doesNotMatch(markup, /skill/u);
});
