import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesSearch } from "./search-fold";

test("Latin accents and case are ignored on both sides, so cafe finds café", () => {
  assert.equal(matchesSearch(["Café Finder"], "cafe"), true);
  assert.equal(matchesSearch(["Cafe Finder"], "CAFÉ"), true);
  assert.equal(matchesSearch(["Crème brûlée"], "creme brulee"), true);
  assert.equal(matchesSearch(["Planner"], "café"), false);
  assert.equal(matchesSearch(["Planner"], "  "), true, "an empty query matches");
});

test("marks that are part of a non-Latin word still count, so an unrelated word doesn't match", () => {
  // किताब ("book"): its vowel signs are marks. Dropping them would leave कतब, which contains कत.
  assert.equal(matchesSearch(["किताब"], "कत"), false);
  assert.equal(matchesSearch(["किताब"], "किता"), true);
  // Thai: กิน ("eat") without its vowel mark is กน.
  assert.equal(matchesSearch(["กิน"], "กน"), false);
  assert.equal(matchesSearch(["กิน"], "กิน"), true);
});
