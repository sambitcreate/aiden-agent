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
  assert.match(markup, />Thinking</u);
  assert.doesNotMatch(markup, /Thinking…/u);
});

test("persisted reasoning stays inspectable but starts collapsed", () => {
  const markup = renderToStaticMarkup(<ReasoningBlock content="Stored model thought" />);
  assert.match(markup, /aria-expanded="false"/u);
  assert.doesNotMatch(markup, /Stored model thought/u);
  assert.match(markup, />Thinking</u);
});

test("a custom label carries the Visualizing shimmer state", () => {
  const markup = renderToStaticMarkup(<ReasoningBlock content="" active label="Visualizing" />);
  assert.match(markup, />Visualizing</u);
  assert.doesNotMatch(markup, /Visualizing…/u);
  assert.match(markup, /agent-thinking-shimmer/u);
  assert.doesNotMatch(markup, /Thinking/u);
  const settled = renderToStaticMarkup(
    <ReasoningBlock content="" label="Visualizing" />,
  );
  assert.match(settled, />Visualizing</u);
});

test("the automatic preview is a bounded, keyboard-scrollable viewport", () => {
  const markup = renderToStaticMarkup(
    <ReasoningBlock content="Long streaming thought" streaming active />,
  );
  assert.match(markup, /data-disclosure-layout="preview"/u);
  // The preview region scrolls on its own, so it must be reachable by keyboard.
  assert.match(markup, /role="region" aria-label="Model reasoning" tabindex="0"/u);
  const collapsed = renderToStaticMarkup(<ReasoningBlock content="Stored thought" />);
  assert.match(collapsed, /data-disclosure-layout="collapsed"/u);
  assert.doesNotMatch(collapsed, /role="region"/u);
});
