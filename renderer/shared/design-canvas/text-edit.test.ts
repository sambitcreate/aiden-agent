// Where a changed piece of page text lives in its file, and when it cannot be
// told apart.

import assert from "node:assert/strict";
import test from "node:test";
import { planDesignTextEdit, reverseDesignTextChanges, stampLine } from "./text-edit";

const PAGE = `<!doctype html>
<html>
  <head>
    <title>Pricing</title>
    <style>h1::after { content: "Pricing"; }</style>
  </head>
  <body>
    <section data-aiden-src="design/hero.html:8">
      <h1>
        Ship   faster
      </h1>
      <p>Tom &amp; Jerry&#39;s plan</p>
      <h2>Pricing</h2>
      <!-- Pricing notes -->
      <p>Two <b>bold</b> words</p>
    </section>
    <footer data-aiden-src="design/hero.html:17"><a href="/pricing">Pricing</a></footer>
  </body>
</html>
`;

test("a text node's new words go where its old words are, whatever whitespace the file used", () => {
  const plan = planDesignTextEdit(PAGE, [{ before: "\n        Ship faster\n      ", after: "\n        Ship sooner\n      " }]);
  assert.ok(plan.ok);
  assert.match(plan.source, /<h1>\n {8}Ship sooner\n {6}<\/h1>/u);
  assert.equal(plan.source.replace("Ship sooner", "Ship   faster"), PAGE, "nothing else in the file changed");
});

test("entities in the file match the decoded text, and new text is escaped", () => {
  const plan = planDesignTextEdit(PAGE, [{ before: "Tom & Jerry's plan", after: "Tom & Jerry's <best> plan" }]);
  assert.ok(plan.ok);
  assert.match(plan.source, /<p>Tom &amp; Jerry's &lt;best&gt; plan<\/p>/u);
});

test("text in the title, a style or a comment never counts, but two real places are ambiguous", () => {
  assert.deepEqual(planDesignTextEdit(PAGE, [{ before: "Pricing", after: "Plans" }]), { ok: false, reason: "ambiguous" });
  // The stamp on the footer narrows it to the footer's link.
  const footer = planDesignTextEdit(PAGE, [{ before: "Pricing", after: "Plans" }], stampLine("design/hero.html:17", "design/hero.html"));
  assert.ok(footer.ok);
  assert.match(footer.source, /<a href="\/pricing">Plans<\/a>/u);
  assert.match(footer.source, /<h2>Pricing<\/h2>/u);
  assert.match(footer.source, /<title>Pricing<\/title>/u);
});

test("a part of a longer text is not a text node, and missing or blank text is not found", () => {
  assert.deepEqual(planDesignTextEdit(PAGE, [{ before: "Ship", after: "Sail" }]), { ok: false, reason: "not-found" });
  assert.deepEqual(planDesignTextEdit(PAGE, [{ before: "Nowhere", after: "x" }]), { ok: false, reason: "not-found" });
  assert.deepEqual(planDesignTextEdit(PAGE, [{ before: "  ", after: "x" }]), { ok: false, reason: "not-found" });
  assert.deepEqual(planDesignTextEdit(PAGE, [{ before: "Same", after: "Same" }]), { ok: false, reason: "unchanged" });
});

test("several text nodes change together, or none do; Undo writes them back", () => {
  const changes = [
    { before: "Two ", after: "Three " },
    { before: " words", after: " lines" },
  ];
  const plan = planDesignTextEdit(PAGE, changes);
  assert.ok(plan.ok);
  assert.match(plan.source, /<p>Three <b>bold<\/b> lines<\/p>/u);
  const undone = planDesignTextEdit(plan.source, reverseDesignTextChanges(changes));
  assert.ok(undone.ok);
  assert.equal(undone.source, PAGE);
  assert.deepEqual(planDesignTextEdit(PAGE, [...changes, { before: "Pricing", after: "Plans" }]), { ok: false, reason: "ambiguous" });
});

test("a stamp counts only for its own file", () => {
  assert.equal(stampLine("design/hero.html:17", "design/hero.html"), 17);
  assert.equal(stampLine("design/other.html:17", "design/hero.html"), undefined);
  assert.equal(stampLine("design/hero.html:x", "design/hero.html"), undefined);
  assert.equal(stampLine(undefined, "design/hero.html"), undefined);
});
