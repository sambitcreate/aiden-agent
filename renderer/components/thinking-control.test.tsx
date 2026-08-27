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
  assert.match(markup, /aria-checked="true" aria-label="Thinking: medium effort" tabindex="0"/u);
  assert.equal((markup.match(/tabindex="-1"/gu) ?? []).length, 3);
  assert.match(markup, />Off</u);
  assert.match(markup, />Low</u);
  assert.match(markup, />Med</u);
  assert.match(markup, />High</u);
  assert.match(markup, /group\/thinking relative h-8 w-18/u);
  assert.match(markup, /absolute bottom-0 right-0/u);
  assert.match(markup, /flex-col items-stretch/u);
  assert.match(markup, /pointer-events-none max-h-0/u);
  assert.match(markup, /group-hover\/thinking:max-h-7/u);
  assert.match(markup, /group-focus-within\/thinking:max-h-7/u);
  assert.match(markup, /group-hover\/thinking:bg-control\/80/u);
  assert.match(markup, /group-hover\/thinking:bg-popover/u);
  assert.doesNotMatch(markup, /disabled:opacity-45/u);
});

test("keeps the active thinking option mounted and focusable while a change saves", () => {
  const markup = renderToStaticMarkup(
    <ThinkingControl
      level="high"
      levels={["low", "medium", "high"]}
      disabled
      onChange={() => undefined}
    />,
  );
  assert.match(markup, /aria-disabled="true"/u);
  assert.doesNotMatch(markup, / disabled=""/u);
  assert.match(markup, /aria-checked="true"[^>]*tabindex="0"/u);
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
  assert.match(markup, /aria-checked="true" aria-label="Thinking: xhigh effort" tabindex="0"/u);
  assert.match(markup, />XHigh</u);
  assert.match(markup, />Max</u);
  assert.doesNotMatch(markup, />Off</u);
});
