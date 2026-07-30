import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSISTANT_AUTOMATION_DRAFT,
  assistantAutomationDraft,
  assistantPreviewText,
  unreadBadgeLabel,
} from "./assistant-dock.js";

test("automation entry point seeds an empty draft without overwriting user text", () => {
  assert.equal(assistantAutomationDraft(""), ASSISTANT_AUTOMATION_DRAFT);
  assert.equal(assistantAutomationDraft("   "), ASSISTANT_AUTOMATION_DRAFT);
  assert.equal(
    assistantAutomationDraft("Keep this unfinished question"),
    "Keep this unfinished question",
  );
});

// Invisible characters are built from code points rather than written literally:
// raw control bytes in the source make git classify this file as binary and
// throw away its diffs.
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);
const INVISIBLES = [0x00, 0x07, 0x1b, 0x200b, 0x2069].map((point) => String.fromCodePoint(point));
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);
const GRINNING_FACE = String.fromCodePoint(0x1f600);

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

test("bidi overrides and control characters cannot spoof the bubble", () => {
  // U+202E reverses everything after it, so the bubble would display text other
  // than what it contains — inside chrome styled like the app's own.
  const preview = assistantPreviewText(`All clean.${RIGHT_TO_LEFT_OVERRIDE} gnihtemos suoicilam`);
  assert.ok(preview);
  assert.doesNotMatch(preview, /[\p{Cc}\p{Cf}]/u);
  for (const control of INVISIBLES) {
    assert.doesNotMatch(assistantPreviewText(`hi${control}there`) ?? "", /[\p{Cc}\p{Cf}]/u);
  }
});

test("truncation never splits an astral character", () => {
  const preview = assistantPreviewText(`${"x".repeat(79)}${GRINNING_FACE} tail`) ?? "";
  assert.ok(!preview.includes(REPLACEMENT_CHARACTER), preview);
  // No lone surrogate survives.
  for (const unit of preview) {
    assert.ok(unit.codePointAt(0)! < 0xd800 || unit.length === 2, unit);
  }
});

test("markdown emphasis and code fences are stripped so the bubble reads as prose", () => {
  assert.equal(assistantPreviewText("**Two** files in `main`"), "Two files in main");
  assert.equal(assistantPreviewText("## Heading\nBody text"), "Heading Body text");
});
