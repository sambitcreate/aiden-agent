import assert from "node:assert/strict";
import test from "node:test";

import { htmlToPageText, plainPageText } from "./web-page-text.js";

test("HTML becomes one line per block, keeping each value next to its label", async () => {
  const page = await htmlToPageText(`<!doctype html>
    <html><head><title> Acme   Pricing </title><style>.x{}</style><script>var key = "x";</script></head>
    <body>
      <nav><a href="/">Home</a> <a href="/docs">Docs</a></nav>
      <main>
        <h1>Pricing</h1>
        <p>Choose a <a href="https://acme.example/plans?ref=1">plan</a> that fits.</p>
        <section><h3>Pro</h3><div>$20</div><div>/month, billed monthly</div>
          <ul><li><p>Unlimited projects</p></li><li>14-day <b>free</b> trial</li></ul>
        </section>
        <table><tr><th>Plan</th><th>Price</th></tr><tr><td>Team</td><td><p>$1,299</p><p>/ year</p></td></tr></table>
        <pre>line one
  line two</pre>
        <p hidden>hidden text</p><div style="display: none">also hidden</div><span aria-hidden="true">icon</span>
        <p>first<br>second</p>
      </main>
      <footer>© Acme</footer>
    </body></html>`);
  assert.equal(page.title, "Acme Pricing");
  assert.equal(
    page.text,
    [
      "# Pricing",
      "Choose a plan that fits.",
      "",
      "### Pro",
      "$20",
      "/month, billed monthly",
      "- Unlimited projects",
      "- 14-day free trial",
      "Plan | Price",
      "Team | $1,299 / year",
      "line one",
      "  line two",
      "first",
      "second",
    ].join("\n"),
  );
});

test("a deeply nested page does not overflow the stack", async () => {
  const depth = 20_000;
  const page = await htmlToPageText(`${"<div>".repeat(depth)}deep value${"</div>".repeat(depth)}`);
  assert.equal(page.text, "deep value");
});

test("plain text bodies keep their lines", () => {
  assert.deepEqual(plainPageText("a\r\nb\rc\n\n"), { title: "", text: "a\nb\nc" });
});
