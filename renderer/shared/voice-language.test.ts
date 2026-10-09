import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveLanguage, effectiveTask, normalizeLanguageIntent } from "./voice-language.js";

const parakeetV3 = { languages: ["en", "de", "fr", "uk"], capabilities: { autoDetect: true, translateToEnglish: false } };
const parakeetV2 = { languages: ["en"], capabilities: { autoDetect: false, translateToEnglish: false } };
const canary = { languages: ["en", "de", "es", "fr"], capabilities: { autoDetect: false, translateToEnglish: true } };
const whisper = { languages: ["en", "no", "tl", "he", "id", "zh", "yue"], capabilities: { autoDetect: true, translateToEnglish: false } };
const frenchOnly = { languages: ["fr"], capabilities: { autoDetect: false, translateToEnglish: false } };

test("auto lets detecting models choose and pins the rest", () => {
  assert.deepEqual(effectiveLanguage(parakeetV3, "auto"), { language: null, fallback: null });
  assert.deepEqual(effectiveLanguage(canary, "auto"), { language: "en", fallback: null });
  assert.deepEqual(effectiveLanguage(frenchOnly, "auto"), { language: "fr", fallback: null });
  assert.deepEqual(effectiveLanguage(parakeetV3, undefined), { language: null, fallback: null });
});

test("supported intents pass through; aliases map to the model's code", () => {
  assert.deepEqual(effectiveLanguage(canary, "de"), { language: "de", fallback: null });
  assert.deepEqual(effectiveLanguage(whisper, "nb"), { language: "no", fallback: null });
  assert.deepEqual(effectiveLanguage(whisper, "fil"), { language: "tl", fallback: null });
  assert.deepEqual(effectiveLanguage(whisper, "iw"), { language: "he", fallback: null });
  assert.deepEqual(effectiveLanguage(whisper, "in"), { language: "id", fallback: null });
  assert.deepEqual(effectiveLanguage(whisper, "zh-tw"), { language: "zh", fallback: null });
});

test("unsupported intents fall back and say so", () => {
  assert.deepEqual(effectiveLanguage(parakeetV2, "de"), { language: "en", fallback: "en" });
  assert.deepEqual(effectiveLanguage(parakeetV3, "ja"), { language: null, fallback: "auto" });
  assert.deepEqual(effectiveLanguage(frenchOnly, "de"), { language: "fr", fallback: "fr" });
});

test("translate only when the model can and the source is not English", () => {
  assert.equal(effectiveTask(canary, true, "de"), "translate");
  assert.equal(effectiveTask(canary, true, "en"), "transcribe");
  assert.equal(effectiveTask(canary, false, "de"), "transcribe");
  assert.equal(effectiveTask(whisper, true, "de"), "transcribe");
  assert.equal(effectiveTask(canary, true, null), "transcribe");
});

test("intent normalization keeps auto and base codes only", () => {
  assert.equal(normalizeLanguageIntent("auto"), "auto");
  assert.equal(normalizeLanguageIntent("DE"), "de");
  assert.equal(normalizeLanguageIntent("zh-TW"), "zh-tw");
  assert.equal(normalizeLanguageIntent("haw"), "haw");
  assert.equal(normalizeLanguageIntent("english"), undefined);
  assert.equal(normalizeLanguageIntent(3), undefined);
});
