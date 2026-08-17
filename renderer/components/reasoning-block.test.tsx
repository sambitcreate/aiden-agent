import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReasoningBlock } from "./reasoning-block.js";

test("streaming reasoning begins as an accessible expanded preview", () => {
  const markup = renderToStaticMarkup(
    <ReasoningBlock content="Readable model thought" streaming active />,
  );
  assert.match(markup, /aria-expanded="true"/u);
  assert.match(markup, /aria-controls=/u);
  assert.match(markup, /role="region" aria-label="Model reasoning"/u);
  assert.match(markup, /Readable model thought/u);
  assert.match(markup, /Thinking…/u);
});

test("persisted reasoning stays inspectable but starts collapsed", () => {
  const markup = renderToStaticMarkup(<ReasoningBlock content="Stored model thought" />);
  assert.match(markup, /aria-expanded="false"/u);
  assert.doesNotMatch(markup, /Stored model thought/u);
  assert.match(markup, />Thinking</u);
});
