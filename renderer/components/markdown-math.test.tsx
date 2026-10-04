import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./markdown.js";
import { loadMarkdownMath, subscribeMarkdownMath } from "../lib/markdown-math.js";

const MATH = "Euler: $e^{i\\pi} + 1 = 0$ and\n\n$$\n\\int_0^1 x\\,dx\n$$";

test("math renders as typed until KaTeX loads, then as KaTeX markup", async () => {
  const before = renderToStaticMarkup(<Markdown content={MATH} />);
  assert.doesNotMatch(before, /class="katex/u);
  assert.match(before, /e\^\{i\\pi\} \+ 1 = 0/u, "TeX source stays readable while loading");

  let notified = 0;
  const unsubscribe = subscribeMarkdownMath(() => {
    notified += 1;
  });
  // The stylesheet is a Vite asset; the renderer runtime loads it, Node cannot.
  assert.equal(await loadMarkdownMath(async () => {}), true);
  unsubscribe();
  assert.equal(notified, 1);

  const after = renderToStaticMarkup(<Markdown content={MATH} />);
  assert.match(after, /class="katex"/u);
  assert.match(after, /class="katex-display"/u);
});

test("messages without math delimiters never use the math plugins", async () => {
  assert.equal(await loadMarkdownMath(async () => {}), true);
  const markup = renderToStaticMarkup(
    <Markdown content={"| a | b |\n| - | - |\n| 1 | 2 |\n\nCosts 5 USD."} />,
  );
  assert.match(markup, /<table>/u);
  assert.doesNotMatch(markup, /class="katex/u);
});
