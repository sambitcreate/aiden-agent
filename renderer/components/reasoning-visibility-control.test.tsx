import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReasoningVisibilityControl } from "./reasoning-visibility-control.js";

test("renders an accessible local reasoning visibility switch", () => {
  const visible = renderToStaticMarkup(
    <ReasoningVisibilityControl visible onChange={() => undefined} />,
  );
  assert.match(visible, /role="switch"/u);
  assert.match(visible, /aria-checked="true"/u);
  assert.match(visible, /aria-label="Hide local model reasoning"/u);
  assert.match(visible, />Reasoning</u);

  const hidden = renderToStaticMarkup(
    <ReasoningVisibilityControl visible={false} disabled onChange={() => undefined} />,
  );
  assert.match(hidden, /aria-checked="false"/u);
  assert.match(hidden, /aria-label="Show local model reasoning"/u);
  assert.match(hidden, /disabled=""/u);
});
