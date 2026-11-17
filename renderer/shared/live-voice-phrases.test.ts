import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_VOICE_LANGUAGES, liveVoicePhrases, matchLiveVoicePhrase } from "./live-voice-phrases.js";

test("each supported language answers allow, deny, confirm and end", () => {
  for (const { code } of LIVE_VOICE_LANGUAGES) {
    for (const kind of ["allow", "deny", "confirm", "end"] as const) {
      const phrases = liveVoicePhrases(code, kind);
      assert.ok(phrases.length > 0, `${code} has no ${kind} phrase`);
      for (const phrase of phrases) {
        assert.equal(matchLiveVoicePhrase(phrase)?.kind, kind, `${code} "${phrase}"`);
      }
    }
  }
});

test("transcripts match with punctuation, case and Latin accents changed", () => {
  assert.equal(matchLiveVoicePhrase("Allow.")?.kind, "allow");
  assert.equal(matchLiveVoicePhrase("  ALLOW ONCE!  ")?.kind, "allow");
  assert.equal(matchLiveVoicePhrase("Don't allow")?.kind, "deny");
  assert.equal(matchLiveVoicePhrase("adios")?.kind, "end");
  assert.equal(matchLiveVoicePhrase("Tschuss")?.kind, "end");
  assert.equal(matchLiveVoicePhrase("Yes, do it.")?.kind, "confirm");
  assert.equal(matchLiveVoicePhrase("許可します。")?.kind, "allow");
  assert.equal(matchLiveVoicePhrase("허용 해")?.kind, "allow");
  assert.equal(matchLiveVoicePhrase("अनुमति दो।")?.kind, "allow");
  assert.equal(matchLiveVoicePhrase("বিদায়")?.kind, "end");
  assert.equal(matchLiveVoicePhrase("再见！")?.kind, "end");
});

test("a phrase inside a longer sentence, a question, a bare yes, or a greeting never counts", () => {
  for (const text of [
    "I would allow it if the tests pass",
    "please don't deny anything yet",
    "yes",
    "ok",
    "ciao",
    "salut",
    "안녕",
    "bye the way, what is it doing",
    "Allow?",
    "deny ?",
    "再见？",
    "Bye?!",
    "Allow?!",
    "¿Permitir!",
    "¿adiós",
    "",
  ]) {
    assert.equal(matchLiveVoicePhrase(text), null, text);
  }
});

test("Hindi and Bengali keep their vowel signs, so a different word does not match", () => {
  // "अनमति" drops the vowel sign of "अनुमति"; it must not fold into a match.
  assert.equal(matchLiveVoicePhrase("अनमति दो"), null);
});
