import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SPEECH_MODELS,
  SILERO_VAD,
  formatSizeLabel,
  languagesLabel,
  speechModel,
} from "./local-speech-catalog.js";

test("exactly one model is recommended and it is Parakeet v3", () => {
  assert.deepEqual(SPEECH_MODELS.filter((m) => m.recommended).map((m) => m.id), ["parakeet-v3"]);
});

test("ids are unique, path-safe and resolvable", () => {
  const ids = SPEECH_MODELS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^[a-z0-9-]{1,64}$/);
    assert.equal(speechModel(id)?.id, id);
  }
  assert.equal(speechModel("nope"), undefined);
});

test("archives are pinned to the k2-fsa release with real digests and sizes", () => {
  for (const m of SPEECH_MODELS) {
    assert.ok(m.archive.url.startsWith("https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"), m.id);
    assert.match(m.archive.sha256, /^[0-9a-f]{64}$/, m.id);
    assert.ok(Number.isSafeInteger(m.archive.bytes) && m.archive.bytes > 1_000_000, m.id);
  }
});

test("capability claims are internally consistent", () => {
  for (const m of SPEECH_MODELS) {
    if (m.capabilities.translateToEnglish) assert.ok(m.languages.some((l) => l !== "en"), m.id);
    // A model that can neither detect nor be told the language must be single-language.
    if (!m.capabilities.autoDetect && !m.capabilities.languageHint) assert.equal(m.languages.length, 1, m.id);
    assert.ok(m.accuracy > 0 && m.accuracy <= 1 && m.speed > 0 && m.speed <= 1, m.id);
  }
});

test("size labels are derived from bytes in decimal units", () => {
  assert.equal(formatSizeLabel(487_170_055), "487 MB");
  assert.equal(formatSizeLabel(153_692_328), "154 MB");
  assert.equal(formatSizeLabel(1_699_791_751), "1.7 GB");
});

test("language labels read naturally", () => {
  assert.equal(languagesLabel({ languages: ["en"] }), "English");
  assert.equal(languagesLabel({ languages: ["zh", "yue", "en", "ja", "ko"] }), "Chinese, Cantonese, English, Japanese, Korean");
  assert.equal(languagesLabel({ languages: Array.from({ length: 25 }, (_, i) => `l${i}`) }), "25 languages");
});

test("the bundled Silero VAD matches its pinned digest", () => {
  const file = fileURLToPath(new URL(`../../resources/speech/${SILERO_VAD.file}`, import.meta.url));
  assert.equal(statSync(file).size, SILERO_VAD.bytes);
  assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), SILERO_VAD.sha256);
});
