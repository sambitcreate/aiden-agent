import assert from "node:assert/strict";
import test from "node:test";
import { fold, matchItem, matchSegments, matchText, rankMatches, titleRanges } from "./text-match";

function highlighted(text: string, query: string): string[] {
  const match = matchText(text, query);
  assert.ok(match, `${query} should match ${text}`);
  return matchSegments(text, match.ranges).filter((part) => part.match).map((part) => part.text);
}

test("case and accents don't count, and the highlight covers the original letters", () => {
  assert.deepEqual(highlighted("Éditer le fichier", "edit"), ["Édit"]);
  assert.deepEqual(highlighted("Crème brûlée", "BRULEE"), ["brûlée"]);
});

test("folding keeps indexes aligned when a character's fold would change length", () => {
  // "İ" lowercases to two code units; Hangul syllables decompose into jamo.
  for (const text of ["İstanbul", "한국어 설정", "Ångström", "naïve café"]) {
    assert.equal(fold(text).length, text.length, text);
  }
  assert.deepEqual(highlighted("İstanbul trip", "istan"), ["İstan"]);
  assert.deepEqual(highlighted("한국어 설정", "설정"), ["설정"]);
});

test("a whole match prefers the start, then a word start, then anywhere", () => {
  const prefix = matchText("Push changes", "push");
  const wordStart = matchText("Git push", "push");
  const inside = matchText("Autopush", "push");
  assert.ok(prefix && wordStart && inside);
  assert.ok(prefix.score > wordStart.score && wordStart.score > inside.score);
  // The word-start occurrence is the one highlighted, not the first.
  assert.deepEqual(matchText("repush push", "push")?.ranges, [{ start: 7, end: 11 }]);
});

test("letters typed as word initials match the word starts", () => {
  assert.deepEqual(highlighted("Git push", "gp"), ["G", "p"]);
  assert.deepEqual(highlighted("openFolderForChat", "ofc"), ["o", "F", "C"]);
  const initials = matchText("Git push", "gp");
  const scattered = matchText("Grape", "gp");
  assert.ok(initials && scattered && initials.score > scattered.score);
});

test("letters in order match as a last resort, with neighbours joined", () => {
  assert.deepEqual(matchText("Settings", "stng")?.ranges, [
    { start: 0, end: 1 },
    { start: 2, end: 3 },
    { start: 5, end: 7 },
  ]);
});

test("nothing matches when the letters are missing or out of order", () => {
  assert.equal(matchText("Git push", "zz"), null);
  assert.equal(matchText("Git push", "pg"), null);
  // A single letter matches only where it appears as typed.
  assert.equal(matchText("Settings", "z"), null);
});

test("a keyword matches without a highlight, below any title match", () => {
  const keyword = matchItem("GPT-5", ["OpenAI"], "openai");
  assert.deepEqual(keyword?.ranges, []);
  const title = matchItem("OpenAI o3", [], "openai");
  assert.ok(keyword && title && title.score > keyword.score);
  // Keywords never match by scattered letters.
  assert.equal(matchItem("GPT-5", ["OpenAI"], "oai"), null);
});

test("every typed word can match across the title and keywords", () => {
  const match = matchItem("Use dark appearance", ["theme"], "dark theme");
  assert.ok(match);
  assert.deepEqual(matchSegments("Use dark appearance", match.ranges).filter((part) => part.match), [
    { text: "dark", match: true },
  ]);
});

test("ranking keeps input order for equal scores and drops non-matches", () => {
  const items = ["Beta notes", "Alpha notes", "Notes", "Unrelated", "More notes"];
  const ranked = rankMatches(items, "notes", (title) => ({ title })).map(({ item }) => item);
  assert.deepEqual(ranked, ["Notes", "Beta notes", "Alpha notes", "More notes"]);
  assert.deepEqual(
    rankMatches(items, "  ", (title) => ({ title })).map(({ item }) => item),
    items,
  );
});

test("segments cover the whole text in order", () => {
  assert.deepEqual(matchSegments("Git push", [{ start: 0, end: 1 }, { start: 4, end: 5 }]), [
    { text: "G", match: true },
    { text: "it ", match: false },
    { text: "p", match: true },
    { text: "ush", match: false },
  ]);
  assert.deepEqual(matchSegments("Plain", []), [{ text: "Plain", match: false }]);
});

test("an emoji is marked whole, never split between its two UTF-16 halves", () => {
  assert.deepEqual(matchItem("Party 🎉 plan", [], "p🎉")?.ranges, [
    { start: 0, end: 1 },
    { start: 6, end: 8 },
  ]);
  assert.deepEqual(matchText("🎉 party", "🎉y")?.ranges, [
    { start: 0, end: 2 },
    { start: 7, end: 8 },
  ]);
});

test("a decomposed query matches a composed label", () => {
  assert.deepEqual(highlighted("Éditer", "E\u0301dit"), ["Édit"]);
});

test("titles ranked by another field mark only whole, word-start or initials matches", () => {
  assert.deepEqual(titleRanges("Rename chat", "renam"), [{ start: 0, end: 5 }]);
  assert.deepEqual(titleRanges("Git push", "gp"), [{ start: 0, end: 1 }, { start: 4, end: 5 }]);
  // Scattered letters ("n", "a", "m", "e" from an alias like "name") mark nothing.
  assert.deepEqual(titleRanges("New chat message", "name"), []);
});
