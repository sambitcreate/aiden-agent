import assert from "node:assert/strict";
import test from "node:test";
import {
  addDictationDictionaryEntry,
  applyDictationDictionary,
  DICTATION_DICTIONARY_MAX_ENTRIES,
  parseDictationDictionary,
} from "./dictation-dictionary.js";

test("a vocabulary term fixes casing wherever it is spoken as a whole word", () => {
  const rules = parseDictationDictionary([{ from: "Aiden", to: "" }]);
  assert.equal(
    applyDictationDictionary("ask aiden, then AIDEN again. aidens and maiden stay", rules),
    "ask Aiden, then Aiden again. aidens and maiden stay",
  );
});

test("replacement rules match phrases across irregular spacing", () => {
  const rules = parseDictationDictionary([
    { from: "pie agent", to: "Pi agent" },
    { from: "type script", to: "TypeScript" },
  ]);
  assert.equal(
    applyDictationDictionary("the pie   agent uses type\nscript", rules),
    "the Pi agent uses TypeScript",
  );
});

test("longer phrases win and replacements are never rewritten again", () => {
  const rules = parseDictationDictionary([
    { from: "open", to: "open AI" },
    { from: "open ai", to: "OpenAI" },
    { from: "ai", to: "AI" },
  ]);
  assert.equal(applyDictationDictionary("open ai and open", rules), "OpenAI and open AI");
});

test("rules with punctuation and non-Latin words keep their boundaries", () => {
  const rules = parseDictationDictionary([
    { from: "c++", to: "C++" },
    { from: "café", to: "Café Aiden" },
  ]);
  assert.equal(
    applyDictationDictionary("write c++ at the café.", rules),
    "write C++ at the Café Aiden.",
  );
  assert.equal(applyDictationDictionary("cafés", rules), "cafés");
});

test("untrusted dictionaries are trimmed, de-duplicated and bounded", () => {
  const parsed = parseDictationDictionary([
    { from: "  hello   world ", to: " Hello World " },
    { from: "HELLO WORLD", to: "ignored duplicate" },
    { from: "", to: "empty" },
    { from: "x".repeat(101), to: "too long" },
    { from: "ok", to: 7 },
    "not a row",
    null,
    { from: "kept" },
  ]);
  assert.deepEqual(parsed, [
    { from: "hello world", to: "Hello World" },
    { from: "kept", to: "" },
  ]);
  const many = Array.from({ length: DICTATION_DICTIONARY_MAX_ENTRIES + 20 }, (_, index) => ({
    from: `word${index}`,
    to: "",
  }));
  assert.equal(parseDictationDictionary(many).length, DICTATION_DICTIONARY_MAX_ENTRIES);
  assert.deepEqual(parseDictationDictionary("nope"), []);
});

test("the editor adds rules, updates an existing spoken form, and explains rejections", () => {
  let entries = parseDictationDictionary([{ from: "aiden", to: "" }]);
  const added = addDictationDictionaryEntry(entries, "  pie  agent ", "Pi agent");
  assert.ok(added.ok);
  entries = added.entries;
  const updated = addDictationDictionaryEntry(entries, "AIDEN", "Aiden Agent");
  assert.ok(updated.ok);
  assert.deepEqual(updated.entries, [
    { from: "AIDEN", to: "Aiden Agent" },
    { from: "pie agent", to: "Pi agent" },
  ]);
  assert.equal(applyDictationDictionary("hi aiden", updated.entries), "hi Aiden Agent");

  assert.equal(addDictationDictionaryEntry(entries, "   ", "x").ok, false);
  assert.equal(addDictationDictionaryEntry(entries, "a".repeat(101), "").ok, false);
  const full = Array.from({ length: DICTATION_DICTIONARY_MAX_ENTRIES }, (_, index) => ({
    from: `w${index}`,
    to: "",
  }));
  assert.equal(addDictationDictionaryEntry(full, "new", "").ok, false);
  assert.equal(addDictationDictionaryEntry(full, "W3", "Three").ok, true, "updates still fit");
});

test("an empty dictionary leaves text untouched", () => {
  assert.equal(applyDictationDictionary("  as spoken  ", []), "  as spoken  ");
});

test("dictionary matching is independent of the host Turkish locale", () => {
  const entries = parseDictationDictionary([{ from: "IĞDIR", to: "Iğdır" }]);
  assert.equal(applyDictationDictionary("IĞDIR", entries), "Iğdır");
});
