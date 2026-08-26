import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Range } from "./ui.js";

test("Range renders a labeled native slider with semantic progress", () => {
  const markup = renderToStaticMarkup(
    <Range min={-60} max={0} value={-18} aria-label="Ambient Music volume" readOnly />,
  );
  assert.match(markup, /type="range"/u);
  assert.match(markup, /aria-label="Ambient Music volume"/u);
  assert.match(markup, /--range-progress:70%/u);
});
