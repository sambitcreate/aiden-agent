// Where a changed piece of page text lives in its file, and when it cannot be
// told apart.

import assert from "node:assert/strict";
import test from "node:test";
import { planDesignTextEdit, reverseDesignTextChanges, stampLine } from "./text-edit";

const at = (stamp: string) => ({ stamp, path: "design/hero.html" });

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
  const footer = planDesignTextEdit(PAGE, [{ before: "Pricing", after: "Plans" }], at("design/hero.html:17"));
  assert.ok(footer.ok);
  assert.match(footer.source, /<a href="\/pricing">Plans<\/a>/u);
  assert.match(footer.source, /<h2>Pricing<\/h2>/u);
  assert.match(footer.source, /<title>Pricing<\/title>/u);
});

test("a stamp whose line went stale finds the words only inside the elements stamped that way", () => {
  // Forty lines added above the body: both stamps now name lines far from their elements.
  const moved = PAGE.replace("  </head>", `${"    <meta name=\"x\">\n".repeat(40)}  </head>`);
  const footer = planDesignTextEdit(moved, [{ before: "Pricing", after: "Plans" }], at("design/hero.html:17"));
  assert.ok(footer.ok, "the footer's own link, though the section also says Pricing");
  assert.match(footer.source, /<a href="\/pricing">Plans<\/a>/u);
  assert.match(footer.source, /<h2>Pricing<\/h2>/u);
  const section = planDesignTextEdit(moved, [{ before: "Tom & Jerry's plan", after: "Our plan" }], at("design/hero.html:8"));
  assert.ok(section.ok);
  assert.match(section.source, /<p>Our plan<\/p>/u);
  // Words that are in the file once, but in another element, are not changed.
  assert.deepEqual(
    planDesignTextEdit(moved, [{ before: "Tom & Jerry's plan", after: "Our plan" }], at("design/hero.html:17")),
    { ok: false, reason: "not-found" },
  );
  // No element carries the stamp at all.
  assert.deepEqual(
    planDesignTextEdit(moved, [{ before: "Tom & Jerry's plan", after: "Our plan" }], at("design/hero.html:20")),
    { ok: false, reason: "not-found" },
  );
  // A stamp with no line still means anywhere in the file, once.
  const anywhere = planDesignTextEdit(moved, [{ before: "Tom & Jerry's plan", after: "Our plan" }], at("design/hero.html"));
  assert.ok(anywhere.ok);
});

test("an element stamped the same way inside itself is followed to its own end tag", () => {
  const nested = `<body>
<div data-aiden-src="design/hero.html:2"><div><p>Inner</p></div><p>After</p></div>
${"<br>\n".repeat(40)}<p>Outside</p>
</body>`;
  const after = planDesignTextEdit(nested, [{ before: "After", after: "Later" }], at("design/hero.html:2"));
  assert.ok(after.ok, "text after a nested div is still inside the stamped one");
  // Line 2 is right here, so move the stamp's line away to use the stamped elements.
  const stale = nested.replace("<body>\n", `<body>\n${"\n".repeat(40)}`);
  assert.ok(planDesignTextEdit(stale, [{ before: "After", after: "Later" }], at("design/hero.html:2")).ok);
  assert.deepEqual(planDesignTextEdit(stale, [{ before: "Outside", after: "x" }], at("design/hero.html:2")), {
    ok: false,
    reason: "not-found",
  });
});

test("with a stale line, words count only where their nearest stamp is exactly the edited element's", () => {
  const page = `<body>
${"\n".repeat(40)}<section data-aiden-src="design/hero.html:2">
  <h2>Plans</h2>
  <div data-aiden-src="design/hero.html:3"><h2>Plans</h2><p>Monthly</p></div>
  <p>Yearly</p>
</section>
<p data-aiden-src="design/HERO.html:2">Hello</p>
</body>`;
  // The section's own heading, not the one in the card inside it, which the page reports under the card's stamp.
  const section = planDesignTextEdit(page, [{ before: "Plans", after: "Pricing" }], at("design/hero.html:2"));
  assert.ok(section.ok);
  assert.match(section.source, /<section[^>]*>\s*<h2>Pricing<\/h2>\s*<div[^>]*><h2>Plans<\/h2>/u);
  const card = planDesignTextEdit(page, [{ before: "Plans", after: "Tiers" }], at("design/hero.html:3"));
  assert.ok(card.ok);
  assert.match(card.source, /<div[^>]*><h2>Tiers<\/h2>/u);
  assert.deepEqual(planDesignTextEdit(page, [{ before: "Monthly", after: "x" }], at("design/hero.html:2")), {
    ok: false,
    reason: "not-found",
  });
  assert.ok(planDesignTextEdit(page, [{ before: "Yearly", after: "Annual" }], at("design/hero.html:2")).ok, "text after the card is the section's again");
  // A stamp naming the same path in other letters is another file's.
  assert.deepEqual(planDesignTextEdit(page, [{ before: "Hello", after: "Hi" }], at("design/hero.html:2")), {
    ok: false,
    reason: "not-found",
  });
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
