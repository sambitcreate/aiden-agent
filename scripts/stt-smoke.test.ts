// Opt-in on-device speech smoke test. Downloads every catalog model (about
// 2 GB of pinned k2-fsa archives) into a temporary root, transcribes a macOS
// `say` phrase and a silent clip with the real sherpa-onnx engine, logs decode
// time and peak RSS, and deletes everything afterwards.
//
// Run with `npm run test:stt-smoke`. Never part of `npm test` or CI.
//
// Needs two macOS voices: "Samantha" (English; required, the test skips
// without it) and "Anna" (German; without it the Whisper language-switch and
// Canary German/translate checks are skipped). Add missing voices in System
// Settings → Accessibility → Spoken Content → System Voice → Manage Voices.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SPEECH_MODELS, type SpeechModelSpec } from "../main/services/local-speech-catalog.js";
import { createSpeechModelManager } from "../main/services/local-speech-downloads.js";
import { speechEngine } from "../main/services/local-speech-engine.js";

const ENABLED = process.env.AIDEN_STT_SMOKE === "1" && process.platform === "darwin";
const SKIP_REASON = "set AIDEN_STT_SMOKE=1 on macOS to run the on-device speech smoke test";
const PHRASE = "The quick brown fox jumps over the lazy dog";
const VAD_MODEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../resources/speech/silero_vad.onnx");
const SAMPLE_RATE = 16_000;
const ENGLISH_VOICE = "Samantha";
const GERMAN_VOICE = "Anna";
const VOICE_HELP = "add it in System Settings → Accessibility → Spoken Content → System Voice → Manage Voices";

/** Installed `say` voice names, or an empty set when they can't be listed. */
function installedVoices(): Set<string> {
  if (process.platform !== "darwin") return new Set();
  try {
    const listing = execFileSync("say", ["-v", "?"]).toString();
    // Lines look like "Anna (German (Germany)) de_DE    # Hallo!…" or "Albert      en_US    # …".
    return new Set(listing.split("\n").map((line) => /^(.+?)(?:\s+\(|\s{2,})/.exec(line)?.[1] ?? "").filter(Boolean));
  } catch {
    return new Set();
  }
}
const VOICES = installedVoices();
const GERMAN_PHRASE = "Guten Morgen, ich möchte heute einen Kaffee trinken.";
// About 90 seconds of speech: numbered sentences so the first and last can be
// checked after VAD segmentation into Whisper's 30 s windows.
const LONG_SENTENCES = Array.from({ length: 24 }, (_, i) => `Sentence ${i + 1}. The weather report says the river stays calm and the boats keep sailing.`);
LONG_SENTENCES[0] = "Pineapple begins the long recording.";
LONG_SENTENCES[LONG_SENTENCES.length - 1] = "Elephant ends the long recording.";

/** Speaks the phrase with macOS `say` and returns 16 kHz mono float PCM. */
function spokenPhrase(scratch: string, voice = ENGLISH_VOICE, phrase = PHRASE): Float32Array {
  const aiff = path.join(scratch, "smoke.aiff");
  const wav = path.join(scratch, "smoke.wav");
  execFileSync("say", ["-v", voice, "-o", aiff, phrase]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  const bytes = readFileSync(wav);
  const dataAt = bytes.indexOf("data");
  assert.ok(dataAt >= 0, "afconvert produced no data chunk");
  const pcm = new Float32Array(bytes.readUInt32LE(dataAt + 4) / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(dataAt + 8 + i * 2) / 32768;
  return pcm;
}

interface Row { id: string; downloadS: number; loadMs: number; decodeMs: number; silenceMs: number; peakRssMb: number; text: string }

let peakRss = 0;
const sampleRss = () => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
};

function transcribe(spec: SpeechModelSpec, dir: string, samples: Float32Array, language: string | null = null, task: "transcribe" | "translate" = "transcribe") {
  const result = speechEngine.transcribe({ spec, modelDirectory: dir, samples, language, task, trimSilence: true, vadModelPath: VAD_MODEL });
  sampleRss();
  return result;
}

test("every catalog model transcribes a spoken phrase and returns nothing for silence", { skip: !ENABLED ? SKIP_REASON : !VOICES.has(ENGLISH_VOICE) ? `macOS voice "${ENGLISH_VOICE}" is not installed; ${VOICE_HELP}` : false, timeout: 60 * 60_000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "aiden-stt-smoke-"));
  const rows: Row[] = [];
  try {
    const manager = createSpeechModelManager({ root: () => path.join(root, "voice-models") });
    const speech = spokenPhrase(root);
    const germanSpeech = VOICES.has(GERMAN_VOICE) ? spokenPhrase(root, GERMAN_VOICE, GERMAN_PHRASE) : null;
    if (!germanSpeech) t.diagnostic(`skipping German checks: macOS voice "${GERMAN_VOICE}" is not installed; ${VOICE_HELP}`);
    const longSpeech = spokenPhrase(root, ENGLISH_VOICE, LONG_SENTENCES.join(" "));
    const silence = new Float32Array(10 * SAMPLE_RATE);

    for (const spec of SPEECH_MODELS) {
      await t.test(spec.id, async () => {
        const downloadStarted = performance.now();
        await manager.downloadModel(spec.id);
        const downloadS = (performance.now() - downloadStarted) / 1000;
        assert.ok(manager.isModelInstalled(spec.id), `${spec.id} installed`);
        const dir = manager.modelDir(spec.id)!;

        speechEngine.release();
        peakRss = process.memoryUsage().rss;
        const { loadMs } = speechEngine.load(spec, dir);
        sampleRss();

        const spoken = transcribe(spec, dir, speech);
        const text = spoken.text.toLowerCase();
        if (spec.family === "sense-voice") {
          assert.ok(text.trim().length > 0, `${spec.id} returned no text`);
        } else {
          assert.ok(text.includes("quick") && text.includes("fox"), `${spec.id} heard "${spoken.text}"`);
        }

        if (spec.family === "whisper") {
          // Native Whisper SetConfig must switch the language in place and back.
          const german = transcribe(spec, dir, speech, "de");
          assert.ok(german.text.trim().length > 0, "whisper with language de returned no text");
          const auto = transcribe(spec, dir, speech, null);
          assert.ok(auto.text.trim().length > 0, "whisper back on auto returned no text");
          t.diagnostic(`whisper de="${german.text}" auto="${auto.text}"`);
          // German audio shows the switch has an effect: auto keeps German,
          // a forced "en" makes Whisper answer in English, and auto returns.
          if (germanSpeech) {
            const heardGerman = transcribe(spec, dir, germanSpeech, null).text.toLowerCase();
            const forcedEnglish = transcribe(spec, dir, germanSpeech, "en").text.toLowerCase();
            const backToAuto = transcribe(spec, dir, germanSpeech, null).text.toLowerCase();
            t.diagnostic(`whisper german auto="${heardGerman}" en="${forcedEnglish}" auto="${backToAuto}"`);
            assert.ok(heardGerman.includes("morgen"), `auto heard "${heardGerman}"`);
            assert.ok(forcedEnglish.includes("morning") && !forcedEnglish.includes("morgen"), `forced en heard "${forcedEnglish}"`);
            assert.ok(backToAuto.includes("morgen"), `auto again heard "${backToAuto}"`);
          }

          // A ~90 s recording is segmented into windows without dropping its ends.
          const long = transcribe(spec, dir, longSpeech).text.toLowerCase();
          t.diagnostic(`whisper long clip ${(longSpeech.length / SAMPLE_RATE).toFixed(0)} s → ${long.length} chars`);
          assert.ok(long.includes("pineapple") && long.includes("elephant"), `long clip heard "${long}"`);
        }

        if (spec.family === "nemo-canary" && germanSpeech) {
          const german = transcribe(spec, dir, germanSpeech, "de").text.toLowerCase();
          const translated = transcribe(spec, dir, germanSpeech, "de", "translate").text.toLowerCase();
          t.diagnostic(`canary de="${german}" translate="${translated}"`);
          assert.ok(german.includes("morgen"), `canary de heard "${german}"`);
          assert.ok(translated.includes("morning"), `canary translate heard "${translated}"`);
        }

        const quiet = transcribe(spec, dir, silence);
        assert.equal(quiet.text, "", `${spec.id} transcribed silence as "${quiet.text}"`);

        const row: Row = {
          id: spec.id,
          downloadS,
          loadMs,
          decodeMs: spoken.decodeMs,
          silenceMs: quiet.decodeMs,
          peakRssMb: peakRss / 1_000_000,
          text: spoken.text,
        };
        rows.push(row);
        t.diagnostic(JSON.stringify(row));

        speechEngine.release();
        await manager.deleteModel(spec.id);
      });
    }
  } finally {
    speechEngine.release();
    rmSync(root, { recursive: true, force: true });
    const table = [
      "| Model | Download s | Load ms | Decode ms (phrase) | Decode ms (10 s silence) | Peak RSS MB | Text |",
      "|---|---|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.id} | ${r.downloadS.toFixed(0)} | ${r.loadMs.toFixed(0)} | ${r.decodeMs.toFixed(0)} | ${r.silenceMs.toFixed(0)} | ${r.peakRssMb.toFixed(0)} | ${r.text} |`),
    ].join("\n");
    process.stdout.write(`\n${table}\n`);
  }
});
