import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("global scrolling utilities reserve a stable vertical gutter for every scroll container", () => {
  const globalScrollbarRule = styles.match(/(?:^|\n)\*\s*\{([\s\S]*?)\n\}/u)?.[1];
  const scrollingScrollbarRule = styles.match(
    /:where\(\.overflow-y-auto, \.overflow-auto, \.overflow-y-scroll, \.overflow-scroll\)\s*\{([\s\S]*?)\n\}/u,
  )?.[1];

  assert.ok(globalScrollbarRule, "missing global scrollbar rule");
  assert.ok(scrollingScrollbarRule, "missing scrolling-box scrollbar rule");
  assert.doesNotMatch(globalScrollbarRule, /scrollbar-gutter\s*:/u);
  assert.match(scrollingScrollbarRule, /scrollbar-gutter:\s*stable\s*;/u);
  assert.doesNotMatch(scrollingScrollbarRule, /scrollbar-gutter:\s*(?:auto|none)\s*;/u);
});
