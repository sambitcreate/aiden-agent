import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { act, cleanup, render } from "@testing-library/react";
import katex from "katex";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, MarkdownContent } from "./markdown.js";
import {
  loadMarkdownMath,
  subscribeMarkdownMath,
  TYPESET_FORMULA_CACHE_LIMIT,
} from "../lib/markdown-math.js";

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
  // Starting the load here makes the mounted messages share it.
  const loading = loadMarkdownMath(async () => {});

  // Mounted messages: only the one that can hold math re-renders on load.
  const commits = { math: 0, plain: 0 };
  const { container } = render(
    <>
      <React.Profiler id="math" onRender={() => void (commits.math += 1)}>
        <div data-message="math">
          <Markdown content={MATH} />
        </div>
      </React.Profiler>
      <React.Profiler id="plain" onRender={() => void (commits.plain += 1)}>
        <div data-message="plain">
          <Markdown content={"A long reply with **no** formulas."} />
        </div>
      </React.Profiler>
    </>,
  );
  const mountCommits = { ...commits };

  assert.ok(!container.querySelector(".katex"), "nothing typesets before KaTeX lands");
  await act(async () => {
    assert.equal(await loading, true);
  });
  unsubscribe();
  assert.equal(notified, 1);

  assert.ok(
    container.querySelector('[data-message="math"] .katex'),
    "the mounted math message typesets once KaTeX lands",
  );
  assert.ok(commits.math > mountCommits.math);
  assert.equal(commits.plain, mountCommits.plain, "a message without math does not re-render");
  cleanup();

  const after = renderToStaticMarkup(<Markdown content={MATH} />);
  assert.match(after, /class="katex"/u);
  assert.match(after, /class="katex-display"/u);
});

test("a re-parsed reply typesets only the formulas it has not typeset before", async (t) => {
  assert.equal(await loadMarkdownMath(async () => {}), true);
  const typeset = t.mock.method(katex, "renderToString");
  const first = "Area: $\\pi r^{2}_{cache}$\n\n$$\n\\sum_{k=1}^{n} k_{cache}\n$$";
  const firstMarkup = renderToStaticMarkup(<Markdown content={first} />);
  assert.equal(typeset.mock.callCount(), 2, "two new formulas, two KaTeX renders");

  const grown = `${first}\n\nAnd $\\sqrt{2}_{cache}$`;
  const grownMarkup = renderToStaticMarkup(<Markdown content={grown} />);
  assert.equal(typeset.mock.callCount(), 3, "the next release typesets only the new formula");
  assert.equal((grownMarkup.match(/class="katex"/gu) ?? []).length, 3, "every formula still shows");

  assert.equal(
    renderToStaticMarkup(<Markdown content={first} />),
    firstMarkup,
    "reused formulas render exactly like freshly typeset ones",
  );
  assert.equal(typeset.mock.callCount(), 3);
});

test("a streaming formula that is still being written does not evict settled formulas", async (t) => {
  assert.equal(await loadMarkdownMath(async () => {}), true);
  const settled = "Settled: $\\alpha_{kept}$";
  renderToStaticMarkup(<Markdown content={settled} />);
  const typeset = t.mock.method(katex, "renderToString");

  // Each release of an open `$$` block is a new partial formula; every one still shows.
  for (let release = 0; release <= TYPESET_FORMULA_CACHE_LIMIT; release += 1) {
    const partial = `Working\n\n$$\nx^{${release}}`;
    const markup = renderToStaticMarkup(<MarkdownContent content={partial} streaming />);
    if (release === 0) assert.match(markup, /class="katex-display"/u);
  }
  const partialRenders = typeset.mock.callCount();
  assert.equal(partialRenders, TYPESET_FORMULA_CACHE_LIMIT + 1);

  renderToStaticMarkup(<Markdown content={settled} />);
  assert.equal(typeset.mock.callCount(), partialRenders, "the settled formula is still a cache hit");
});

test("messages without math delimiters never use the math plugins", async () => {
  assert.equal(await loadMarkdownMath(async () => {}), true);
  const markup = renderToStaticMarkup(
    <Markdown content={"| a | b |\n| - | - |\n| 1 | 2 |\n\nCosts 5 USD."} />,
  );
  assert.match(markup, /<table>/u);
  assert.doesNotMatch(markup, /class="katex/u);
});

test("ordinary chat Markdown still shows remote images and links directly", () => {
  const markup = renderToStaticMarkup(<Markdown content={"![chart](https://example.test/chart.png) [docs](https://example.test/docs)"} />);
  assert.match(markup, /<img[^>]+src="https:\/\/example\.test\/chart\.png"/u);
  assert.match(markup, /<a href="https:\/\/example\.test\/docs"/u);
});
