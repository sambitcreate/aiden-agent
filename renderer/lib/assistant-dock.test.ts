import assert from "node:assert/strict";
import test from "node:test";
import { assistantPreviewText, unreadBadgeLabel } from "./assistant-dock.js";

test("no badge until there is something unread", () => {
  assert.equal(unreadBadgeLabel(0), null);
  assert.equal(unreadBadgeLabel(-3), null);
});

test("the badge counts up to nine and then saturates", () => {
  assert.equal(unreadBadgeLabel(1), "1");
  assert.equal(unreadBadgeLabel(9), "9");
  assert.equal(unreadBadgeLabel(10), "9+");
  assert.equal(unreadBadgeLabel(240), "9+");
});

test("a preview collapses newlines and runs of whitespace into one line", () => {
  assert.equal(
    assistantPreviewText("You have\n\n  two   uncommitted\tfiles."),
    "You have two uncommitted files.",
  );
});

test("a long preview is truncated on a word boundary with an ellipsis", () => {
  const source =
    "The aiden-agent project has twelve uncommitted files on the main branch, including changes to the renderer and the main process handlers.";
  const preview = assistantPreviewText(source) ?? "";
  assert.ok(preview.length <= 81, `too long: ${String(preview.length)}`);
  assert.ok(preview.endsWith("…"), preview);
  // The kept text must be a whole-word prefix of the source: the source has to
  // continue with a space right where the preview stopped, never mid-word.
  const kept = preview.slice(0, -1);
  assert.ok(source.startsWith(kept), kept);
  assert.match(source.slice(kept.length), /^\s/u);
});

test("a short preview is returned untouched", () => {
  assert.equal(assistantPreviewText("All clean."), "All clean.");
});

test("empty or whitespace-only content yields no preview", () => {
  assert.equal(assistantPreviewText(""), null);
  assert.equal(assistantPreviewText("   \n\t "), null);
});

test("markdown emphasis and code fences are stripped so the bubble reads as prose", () => {
  assert.equal(assistantPreviewText("**Two** files in `main`"), "Two files in main");
  assert.equal(assistantPreviewText("## Heading\nBody text"), "Heading Body text");
});
