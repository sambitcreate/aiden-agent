import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ThinkingControl } from "./thinking-control.js";

test("renders an accessible four-step Gemini thinking control", () => {
  const markup = renderToStaticMarkup(
    <ThinkingControl
      level="medium"
      levels={["off", "low", "medium", "high"]}
      onChange={() => undefined}
    />,
  );
  assert.match(markup, /role="radiogroup"/u);
  assert.match(markup, /aria-label="Gemini thinking level"/u);
  assert.equal((markup.match(/role="radio"/gu) ?? []).length, 4);
  assert.match(
    markup,
    /aria-checked="true" aria-label="Thinking: medium effort" tabindex="0"/u,
  );
  assert.equal((markup.match(/tabindex="-1"/gu) ?? []).length, 3);
  assert.match(markup, />Off</u);
  assert.match(markup, />Low</u);
  assert.match(markup, />Med</u);
  assert.match(markup, />High</u);
});

test("renders only distinct choices and identifies hidden minimum thinking", () => {
  const markup = renderToStaticMarkup(
    <ThinkingControl
      level="off"
      levels={["off", "low", "high"]}
      canDisable={false}
      onChange={() => undefined}
    />,
  );
  assert.equal((markup.match(/role="radio"/gu) ?? []).length, 3);
  assert.match(markup, /aria-label="Thinking: hide model thoughts"/u);
  assert.match(markup, />Hide</u);
  assert.doesNotMatch(markup, />Med</u);
});

test("renders model-specific Codex effort levels without an off alias", () => {
  const markup = renderToStaticMarkup(
    <ThinkingControl
      providerLabel="Codex"
      level="xhigh"
      levels={["low", "medium", "high", "xhigh", "max"]}
      onChange={() => undefined}
    />,
  );
  assert.match(markup, /aria-label="Codex thinking level"/u);
  assert.equal((markup.match(/role="radio"/gu) ?? []).length, 5);
  assert.match(
    markup,
    /aria-checked="true" aria-label="Thinking: xhigh effort" tabindex="0"/u,
  );
  assert.match(markup, />XHigh</u);
  assert.match(markup, />Max</u);
  assert.doesNotMatch(markup, />Off</u);
});
