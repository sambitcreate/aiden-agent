# Speech Engine Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Aiden's Parakeet-only on-device speech path with an engine-neutral sherpa-onnx 1.13.8 stack. It adds a six-model verified catalog, language and translate support, Silero VAD segmentation, a supervised worker, local-first provider resolution, and Telegram on-device routing.

**Architecture:** Pure modules hold the catalog, language, VAD planning, provider resolution and preferences. They are shared by main, renderer and CLI. An Electron-free engine adapter runs inside the existing utility-process worker. The worker speaks protocol v2 with binary PCM16. The parent supervises the worker with scaled deadlines and one crash retry. The UI extends the existing Settings → Voice components in Aiden's design system.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` specifiers), Electron 43 `utilityProcess`, `sherpa-onnx-node@1.13.8`, `ogg-opus-decoder` (MIT, WASM), React plus Testing Library, `tsx --test` (node:test).

**Spec:** [`docs/plans/stt-engine-foundation-spec.md`](../../plans/stt-engine-foundation-spec.md). Read it first. Section numbers (§) below refer to it.

## Global Constraints

- Pin `sherpa-onnx-node` to **exactly `1.13.8`** in both `package.json` (root) and `packages/cli/package.json`. No caret.
- `numThreads: 2` and `provider: "cpu"` for every recognizer.
- Archives come only from `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/`. Downloads start only on explicit user action. Make no network calls at startup or on listing.
- Pre-1.0: no migrations and no compatibility shims. Old `parakeet-models/` folders are deleted. Renamed modules leave no re-export stubs.
- UI stays Aiden's own:
  - Follow `docs/settings-design-system.md` and use semantic tokens.
  - Review `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` before any UI change.
  - No decorative colored borders.
  - Text inputs get no focus ring. Other controls keep `focus-visible`.
- IPC channel names stay stable: `localVoice:*`, `localModels:*`, `voice:transcribeLocal`, `voice:transcribeLocalCancel`. Only payload shapes change.
- Tests are behavioral, per AGENTS.md:
  - No source-grep tests and no className assertions.
  - Never assert an expression that the code under test also computes.
  - Register every new test file in a `package.json` test script (`test:voice` unless stated otherwise).
- Never copy Handy source. Port behavior only, as original TypeScript.
- Commit after each task with a message ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A 10-minute recording on Whisper turbo.** Segmentation must keep every word, with no truncation at 30 s and no duplicated text at window seams. Pin this with a `planSegments` test: a 600 s clip with continuous speech regions every 5 s produces ≥21 windows, every window ≤28 s, and windows that cover every region exactly once (Task 4).
2. **Download interrupted, app quit, relaunched, Download pressed again.** It must resume from the partial and still verify the full-file SHA-256. Pin this with a downloader test that kills the fixture mid-stream, constructs a new manager over the same root, and expects a resumed 206 request and a valid install (Task 2).
3. **User selects a language the model doesn't support** (for example German on Parakeet v2). The model must transcribe in its fallback language, and Settings must explain why. Pin it with resolver rows plus a Settings render test showing the fallback caption (Tasks 3 and 9).
4. **Mic pressed with Automatic and nothing usable** (no keys, no models). The microphone must never open. Pin this with a coordinator test where `resolveVoice` returns needs-setup: no `showPill` "recording" broadcast, and an error broadcast carrying the setup message (Task 8).
5. **The worker crashes on the retry attempt as well.** The user gets one clear failure, no infinite respawn, and the lane stays usable for the next request. Pin it with a supervision test: crash, crash, then `decode-failed`, then a third independent request succeeds (Task 6).

---

## File map

| File | Responsibility |
|---|---|
| `main/services/local-speech-catalog.ts` (new) | Frozen `SPEECH_MODELS`, selectors, size and language labels, bundled VAD descriptor |
| `main/services/local-speech-downloads.ts` (new; replaces `local-models-core.ts`) | Resumable, verified downloader plus install checks (`createSpeechModelManager`) |
| `main/services/local-speech-models.ts` (new; replaces `local-models.ts`) | Electron wiring: root path, progress broadcast, legacy folder removal |
| `renderer/shared/voice-language.ts` (new) | `effectiveLanguage`, `effectiveTask`, language-intent normalization. Lives in `renderer/shared` (not `main/services` as §8 says) so Settings can show the fallback caption. |
| `renderer/shared/voice-preferences.ts` (new) | `parseVoicePreferencePatch` for `voiceLanguage`, `voiceTranslateToEnglish`, `voiceTrimSilence` |
| `main/services/local-speech-vad.ts` (new) | Pure `planSegments` |
| `main/services/local-speech-engine.ts` (rename of `parakeet-engine.ts`) | sherpa adapter: config builders, single slot, VAD, decode |
| `main/services/local-speech-protocol.ts` (rename) | Protocol v2 types and validators |
| `main/services/local-speech-worker.ts` (rename) | Utility-process entry |
| `main/services/local-speech-process-core.ts` (rename) | Request/response client, scaled deadlines, stderr tail, `runWithCrashRetry` |
| `main/services/local-speech-lane.ts` (rename) | FIFO lane (logic unchanged; names change) |
| `main/services/local-speech-idle-unload.ts` (rename) | Idle unloader (logic unchanged; names change) |
| `main/services/local-speech.ts` (rename of `parakeet.ts`) | Parent lifecycle and public API |
| `renderer/shared/voice-provider.ts` (new) | Pure `resolveVoiceProvider` and setup copy |
| `main/services/voice-provider-resolution.ts` (new) | Gathers inputs from config, providers and models; exposes `resolveVoiceProviderNow()` |
| `resources/speech/silero_vad.onnx` (new binary) | Bundled VAD model |

---

### Task 1: Catalog, sherpa pin and bundled VAD

**Files:**
- Create: `main/services/local-speech-catalog.ts`, `main/services/local-speech-catalog.test.ts`, `resources/speech/silero_vad.onnx`
- Modify: `package.json` (dependency pin, `build.extraResources`, `test:voice`), `packages/cli/package.json` (pin), `package-lock.json` and `packages/cli/package-lock.json` (via npm)

**Interfaces:**
- Produces:
  - `SpeechModelFamily`, `SpeechModelSpec`, `SPEECH_MODELS`
  - `speechModel(id: string): SpeechModelSpec | undefined`
  - `formatSizeLabel(bytes: number): string`
  - `languagesLabel(spec: Pick<SpeechModelSpec,"languages">): string`
  - `SILERO_VAD: { file: string; bytes: number; sha256: string }`
  - `SPEECH_MODEL_RELEASE: string`

- [ ] **Step 1: Pin sherpa and fetch the VAD model.**

```bash
npm install --save-exact sherpa-onnx-node@1.13.8
(cd packages/cli && npm install --save-exact --save-optional sherpa-onnx-node@1.13.8)
mkdir -p resources/speech
curl -L --fail -o resources/speech/silero_vad.onnx https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx
shasum -a 256 resources/speech/silero_vad.onnx   # must print 9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6
```

Add to root `package.json` → `build.extraResources` (create the array if it's absent, keeping existing entries):

```json
{ "from": "resources/speech", "to": "speech", "filter": ["silero_vad.onnx"] }
```

- [ ] **Step 2: Compute the Whisper turbo digest.** GitHub publishes none for this asset.

```bash
D=$(mktemp -d); curl -L --fail -o "$D/w.tar.bz2" https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-turbo.tar.bz2
stat -f %z "$D/w.tar.bz2"      # expect 563790207
shasum -a 256 "$D/w.tar.bz2"   # record this value in the catalog below
tar -tjf "$D/w.tar.bz2" | head -20   # confirm turbo-encoder.int8.onnx, turbo-decoder.int8.onnx, turbo-tokens.txt paths
rm -rf "$D"
```

Record the digest in the catalog entry. Also add a line under `## Progress` at the bottom of this plan: `whisper-turbo sha256 computed 2026-10-XX: <hex>`.

- [ ] **Step 3: Write the failing test** `main/services/local-speech-catalog.test.ts`.

```ts
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
```

- [ ] **Step 4: Run it to verify it fails.**

Run: `npx tsx --test main/services/local-speech-catalog.test.ts`
Expected: FAIL with `Cannot find module './local-speech-catalog.js'`.

- [ ] **Step 5: Implement** `main/services/local-speech-catalog.ts`.

```ts
// Curated on-device speech catalog. Every archive is a k2-fsa sherpa-onnx
// release asset pinned by exact byte size and SHA-256; nothing here is
// fetched at runtime. Scores are relative display hints from Handy's
// catalog.json at f6b3f82 (score / 100).

export const SPEECH_MODEL_RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

export type SpeechModelFamily = "nemo-transducer" | "nemo-canary" | "whisper" | "sense-voice" | "moonshine-v2";

export interface SpeechModelSpec {
  id: string;
  name: string;
  description: string;
  family: SpeechModelFamily;
  archive: { url: string; bytes: number; sha256: string };
  /** Role → relative path inside the installed directory. */
  files: Readonly<Record<string, string>>;
  languages: readonly string[];
  capabilities: {
    autoDetect: boolean;
    languageHint: boolean;
    translateToEnglish: boolean;
    maxWindowSeconds: number | null;
  };
  accuracy: number;
  speed: number;
  recommended: boolean;
  license: { name: string; url: string; attribution?: string };
}

const PARAKEET_V3_LANGUAGES = [
  "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it",
  "lv", "lt", "mt", "pl", "pt", "ro", "ru", "sk", "sl", "es", "sv", "uk",
] as const;

// Whisper's 99 languages, in Whisper's own order.
const WHISPER_LANGUAGES = [
  "en","zh","de","es","ru","ko","fr","ja","pt","tr","pl","ca","nl","ar","sv","it","id","hi","fi","vi",
  "he","uk","el","ms","cs","ro","da","hu","ta","no","th","ur","hr","bg","lt","la","mi","ml","cy","sk",
  "te","fa","lv","bn","sr","az","sl","kn","et","mk","br","eu","is","hy","ne","mn","bs","kk","sq","sw",
  "gl","mr","pa","si","km","sn","yo","so","af","oc","ka","be","tg","sd","gu","am","yi","lo","uz","fo",
  "ht","ps","tk","nn","mt","sa","lb","my","bo","tl","mg","as","tt","haw","ln","ha","ba","jw","su",
] as const;

const NVIDIA_CC_BY = { name: "CC-BY-4.0 (NVIDIA)", url: "https://creativecommons.org/licenses/by/4.0/" };
const TRANSDUCER_FILES = {
  encoder: "encoder.int8.onnx",
  decoder: "decoder.int8.onnx",
  joiner: "joiner.int8.onnx",
  tokens: "tokens.txt",
} as const;

export const SPEECH_MODELS: readonly SpeechModelSpec[] = Object.freeze([
  {
    id: "parakeet-v3",
    name: "Parakeet TDT 0.6B v3",
    description: "Fast and accurate across 25 European languages.",
    family: "nemo-transducer",
    archive: { url: `${SPEECH_MODEL_RELEASE}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`, bytes: 487_170_055, sha256: "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf" },
    files: TRANSDUCER_FILES,
    languages: PARAKEET_V3_LANGUAGES,
    capabilities: { autoDetect: true, languageHint: false, translateToEnglish: false, maxWindowSeconds: null },
    accuracy: 0.88, speed: 0.79, recommended: true, license: NVIDIA_CC_BY,
  },
  {
    id: "parakeet-v2",
    name: "Parakeet TDT 0.6B v2",
    description: "English only, and the most accurate model for English.",
    family: "nemo-transducer",
    archive: { url: `${SPEECH_MODEL_RELEASE}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2`, bytes: 482_468_385, sha256: "157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad" },
    files: TRANSDUCER_FILES,
    languages: ["en"],
    capabilities: { autoDetect: false, languageHint: false, translateToEnglish: false, maxWindowSeconds: null },
    accuracy: 0.89, speed: 0.85, recommended: false, license: NVIDIA_CC_BY,
  },
  {
    id: "canary-180m-flash",
    name: "Canary 180M Flash",
    description: "Small and very fast. English, German, Spanish and French, with translation to English.",
    family: "nemo-canary",
    archive: { url: `${SPEECH_MODEL_RELEASE}/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8.tar.bz2`, bytes: 153_692_328, sha256: "7a38ed8b13f014ad632b09ff8d22e0c6f1359dd046af9235d281dfae841b9ab9" },
    files: { encoder: "encoder.int8.onnx", decoder: "decoder.int8.onnx", tokens: "tokens.txt" },
    languages: ["en", "de", "es", "fr"],
    capabilities: { autoDetect: false, languageHint: true, translateToEnglish: true, maxWindowSeconds: null },
    accuracy: 0.88, speed: 0.98, recommended: false, license: NVIDIA_CC_BY,
  },
  {
    id: "whisper-turbo",
    name: "Whisper Large v3 Turbo",
    description: "Broadest language coverage. Slower than the others.",
    family: "whisper",
    archive: { url: `${SPEECH_MODEL_RELEASE}/sherpa-onnx-whisper-turbo.tar.bz2`, bytes: 563_790_207, sha256: "<FILL FROM TASK 1 STEP 2>" },
    files: { encoder: "turbo-encoder.int8.onnx", decoder: "turbo-decoder.int8.onnx", tokens: "turbo-tokens.txt" },
    languages: WHISPER_LANGUAGES,
    capabilities: { autoDetect: true, languageHint: true, translateToEnglish: false, maxWindowSeconds: 30 },
    accuracy: 0.88, speed: 0.35, recommended: false, license: { name: "MIT (OpenAI Whisper)", url: "https://github.com/openai/whisper/blob/main/LICENSE" },
  },
  {
    id: "sense-voice",
    name: "SenseVoice Small",
    description: "Fast Chinese, Cantonese, English, Japanese and Korean.",
    family: "sense-voice",
    archive: { url: `${SPEECH_MODEL_RELEASE}/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2`, bytes: 163_002_883, sha256: "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e" },
    files: { model: "model.int8.onnx", tokens: "tokens.txt" },
    languages: ["zh", "yue", "en", "ja", "ko"],
    capabilities: { autoDetect: true, languageHint: true, translateToEnglish: false, maxWindowSeconds: 30 },
    accuracy: 0.81, speed: 0.98, recommended: false,
    license: { name: "FunASR Model License 1.1", url: "https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE", attribution: "SenseVoice Small, Alibaba FunAudioLLM" },
  },
  {
    id: "moonshine-base-en",
    name: "Moonshine Base",
    description: "Tiny English model for Macs with little free memory.",
    family: "moonshine-v2",
    archive: { url: `${SPEECH_MODEL_RELEASE}/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2`, bytes: 111_266_225, sha256: "43232c1d13013d37317163baec3135bd771a186a4356f28c889bab453bb0e891" },
    files: { encoder: "encoder_model.ort", mergedDecoder: "decoder_model_merged.ort", tokens: "tokens.txt" },
    languages: ["en"],
    capabilities: { autoDetect: false, languageHint: false, translateToEnglish: false, maxWindowSeconds: 30 },
    accuracy: 0.8, speed: 0.99, recommended: false, license: { name: "MIT (Moonshine English models)", url: "https://github.com/moonshine-ai/moonshine/blob/main/LICENSE" },
  },
] satisfies SpeechModelSpec[]);

export const SILERO_VAD = Object.freeze({
  file: "silero_vad.onnx",
  bytes: 643_854,
  sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
});

export function speechModel(id: string): SpeechModelSpec | undefined {
  return SPEECH_MODELS.find((model) => model.id === id);
}

export function formatSizeLabel(bytes: number): string {
  return bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`;
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", zh: "Chinese", yue: "Cantonese", ja: "Japanese", ko: "Korean",
  de: "German", es: "Spanish", fr: "French",
};

export function languagesLabel(spec: Pick<SpeechModelSpec, "languages">): string {
  if (spec.languages.length > 5) return `${spec.languages.length} languages`;
  return spec.languages.map((code) => LANGUAGE_NAMES[code] ?? code).join(", ");
}
```

Replace `<FILL FROM TASK 1 STEP 2>` with the digest you computed. The catalog test's hex check fails until you do.

- [ ] **Step 6: Run the test and register it.** Run `npx tsx --test main/services/local-speech-catalog.test.ts`. Expected: PASS (7 tests). Append `main/services/local-speech-catalog.test.ts` to the `test:voice` script.

- [ ] **Step 7: Commit.**

```bash
git add package.json package-lock.json packages/cli/package.json packages/cli/package-lock.json resources/speech main/services/local-speech-catalog.ts main/services/local-speech-catalog.test.ts
git commit -m "Add pinned on-device speech catalog and bundled Silero VAD"
```

---

### Task 2: Verified, resumable downloader and storage

**Files:**
- Create: `main/services/local-speech-downloads.ts`, `main/services/local-speech-downloads.test.ts`, `main/services/local-speech-models.ts`
- Delete: `main/services/local-models-core.ts`, `main/services/local-models.ts`
- Modify every importer (find them with `grep -rln "local-models" main packages/cli/src renderer scripts`):
  - `main/handlers/local-voice.ts`
  - `main/services/aiden-remote-speech-core.ts` (type import)
  - `main/services/aiden-remote-speech.ts`
  - `main/services/parakeet.ts` (renamed in Task 6; update the import now)
  - `packages/cli/src/speech.ts`
  - `main/index.ts` (startup cleanup call)

**Interfaces:**
- Consumes: `SPEECH_MODELS`, `SpeechModelSpec`, `formatSizeLabel`, `languagesLabel` (Task 1).
- Produces:

```ts
export interface LocalModel {
  id: string; name: string; description: string; sizeLabel: string; quant: string;
  languagesLabel: string; accuracy: number; speed: number; recommended: boolean; installed: boolean;
  languages: string[];
  capabilities: SpeechModelSpec["capabilities"];
  license: SpeechModelSpec["license"];
}
export interface LocalModelDownloadState {
  id: string; percentage: number; phase: "download" | "verify" | "extract";
  status: "downloading" | "failed"; error?: string;
}
export interface SpeechModelManagerDependencies {
  root(): string;
  catalog?: readonly SpeechModelSpec[];          // tests inject tiny fixtures
  fetchImpl?: typeof fetch;
  stallMs?: number;                              // default 60_000
  connectMs?: number;                            // default 15_000
  progress?(value: { id: string; downloaded: number; total: number; percentage: number; phase: LocalModelDownloadState["phase"] }): void;
  info?(message: string): void;
}
export function createSpeechModelManager(deps: SpeechModelManagerDependencies): {
  modelDir(id: string): string | null;
  isModelInstalled(id: string): boolean;
  listModels(): LocalModel[];
  localModelDownloadStates(): LocalModelDownloadState[];
  downloadModel(id: string): Promise<void>;
  cancelDownload(id: string): boolean;
  deleteModel(id: string): Promise<void>;
  stopDownloads(): Promise<void>;
  cleanupLeftovers(): Promise<void>;
  specFor(id: string): SpeechModelSpec | undefined;
};
```

`quant` stays as `"int8"` for every current entry, so existing Remote clients keep their field.

- [ ] **Step 1: Write the failing tests** `main/services/local-speech-downloads.test.ts`.
  - Build fixture archives with real `tar` in a temp dir.
  - Serve them from a `node:http` server that honors `Range` and can be told to misbehave.
  - Use small `stallMs` and `connectMs` values.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeechModelSpec } from "./local-speech-catalog.js";
import { createSpeechModelManager } from "./local-speech-downloads.js";

type Mode = "normal" | "ignore-range" | "wrong-offset" | "cut-after-half" | "stall" | "oversize";

function fixtureArchive(): { bytes: Buffer; sha256: string } {
  const dir = mkdtempSync(join(tmpdir(), "speech-fixture-"));
  const top = join(dir, "sherpa-onnx-fixture");
  mkdirSync(join(top, "test_wavs"), { recursive: true });
  writeFileSync(join(top, "model.int8.onnx"), Buffer.alloc(200_000, 7));
  writeFileSync(join(top, "tokens.txt"), "a 0\nb 1\n");
  writeFileSync(join(top, "test_wavs", "0.wav"), Buffer.alloc(1000, 1));
  writeFileSync(join(top, "model.onnx"), Buffer.alloc(5000, 2)); // unused precision → pruned
  const archive = join(dir, "fixture.tar.bz2");
  execFileSync("tar", ["-cjf", archive, "-C", dir, "sherpa-onnx-fixture"]);
  const bytes = readFileSync(archive);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function serve(bytes: Buffer, state: { mode: Mode; requests: Array<string | undefined> }): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    state.requests.push(req.headers.range);
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    let start = range && state.mode !== "ignore-range" ? Number(range[1]) : 0;
    if (state.mode === "wrong-offset" && range) start = Math.max(0, Number(range[1]) - 10);
    const body = state.mode === "oversize" ? Buffer.concat([bytes, Buffer.alloc(10)]) : bytes;
    const slice = body.subarray(start);
    res.writeHead(start > 0 ? 206 : 200, {
      "content-length": String(slice.length),
      ...(start > 0 ? { "content-range": `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
    });
    if (state.mode === "stall") { res.write(slice.subarray(0, 100)); return; }
    if (state.mode === "cut-after-half") { res.write(slice.subarray(0, Math.floor(slice.length / 2))); res.destroy(); return; }
    res.end(slice);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return { server, url: `http://127.0.0.1:${address.port}/fixture.tar.bz2` };
}

function spec(url: string, bytes: number, sha256: string): SpeechModelSpec {
  return {
    id: "fixture", name: "Fixture", description: "x", family: "sense-voice",
    archive: { url, bytes, sha256 }, files: { model: "model.int8.onnx", tokens: "tokens.txt" },
    languages: ["en"], capabilities: { autoDetect: false, languageHint: false, translateToEnglish: false, maxWindowSeconds: 30 },
    accuracy: 0.5, speed: 0.5, recommended: true, license: { name: "MIT", url: "https://example.invalid" },
  };
}

test("installs a verified archive and prunes files outside the spec", async (t) => {
  const { bytes, sha256 } = fixtureArchive();
  const state = { mode: "normal" as Mode, requests: [] as Array<string | undefined> };
  const { server, url } = await serve(bytes, state);
  t.after(() => server.close());
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const manager = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, sha256)] });
  await manager.downloadModel("fixture");
  assert.equal(manager.isModelInstalled("fixture"), true);
  assert.deepEqual(readdirSync(join(root, "fixture")).sort(), ["model.int8.onnx", "tokens.txt"]);
});

test("a hash mismatch deletes the partial and reports corruption", async (t) => {
  const { bytes } = fixtureArchive();
  const { server, url } = await serve(bytes, { mode: "normal", requests: [] });
  t.after(() => server.close());
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const manager = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, "0".repeat(64))] });
  await assert.rejects(manager.downloadModel("fixture"), /corrupted/i);
  assert.equal(manager.isModelInstalled("fixture"), false);
  assert.equal(existsSync(join(root, ".partial", "fixture.tar.bz2.part")), false);
});

test("an interrupted download resumes with Range after a relaunch", async (t) => {
  const { bytes, sha256 } = fixtureArchive();
  const state = { mode: "cut-after-half" as Mode, requests: [] as Array<string | undefined> };
  const { server, url } = await serve(bytes, state);
  t.after(() => server.close());
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const first = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, sha256)] });
  await assert.rejects(first.downloadModel("fixture"));
  const partial = statSync(join(root, ".partial", "fixture.tar.bz2.part")).size;
  assert.ok(partial > 0 && partial < bytes.length);
  state.mode = "normal";
  const second = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, sha256)] });
  await second.downloadModel("fixture");
  assert.equal(state.requests.at(-1), `bytes=${partial}-`);
  assert.equal(second.isModelInstalled("fixture"), true);
});

test("a server that ignores Range restarts from zero and still verifies", async (t) => {
  const { bytes, sha256 } = fixtureArchive();
  const state = { mode: "cut-after-half" as Mode, requests: [] as Array<string | undefined> };
  const { server, url } = await serve(bytes, state);
  t.after(() => server.close());
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const manager = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, sha256)] });
  await assert.rejects(manager.downloadModel("fixture"));
  state.mode = "ignore-range";
  await manager.downloadModel("fixture");
  assert.equal(manager.isModelInstalled("fixture"), true);
});

test("a 206 at the wrong offset discards the partial and restarts", async (t) => {
  const { bytes, sha256 } = fixtureArchive();
  const state = { mode: "cut-after-half" as Mode, requests: [] as Array<string | undefined> };
  const { server, url } = await serve(bytes, state);
  t.after(() => server.close());
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const manager = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, sha256)] });
  await assert.rejects(manager.downloadModel("fixture"));
  state.mode = "wrong-offset";
  await assert.rejects(manager.downloadModel("fixture"), /restart|try again/i);
  state.mode = "normal";
  await manager.downloadModel("fixture");
  assert.equal(manager.isModelInstalled("fixture"), true);
});

test("an oversize stream is cut and rejected", async (t) => {
  const { bytes, sha256 } = fixtureArchive();
  const { server, url } = await serve(bytes, { mode: "oversize", requests: [] });
  t.after(() => server.close());
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const manager = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, sha256)] });
  await assert.rejects(manager.downloadModel("fixture"), /size|corrupted/i);
});

test("a stalled stream aborts with a retryable error", async (t) => {
  const { bytes, sha256 } = fixtureArchive();
  const { server, url } = await serve(bytes, { mode: "stall", requests: [] });
  t.after(() => server.close());
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const manager = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, sha256)], stallMs: 200 });
  await assert.rejects(manager.downloadModel("fixture"), /stalled/i);
  assert.ok(existsSync(join(root, ".partial", "fixture.tar.bz2.part")));
});

test("progress passes through verify before extract", async (t) => {
  const { bytes, sha256 } = fixtureArchive();
  const { server, url } = await serve(bytes, { mode: "normal", requests: [] });
  t.after(() => server.close());
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const phases: string[] = [];
  const manager = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, sha256)], progress: (p) => { if (phases.at(-1) !== p.phase) phases.push(p.phase); } });
  await manager.downloadModel("fixture");
  assert.deepEqual(phases, ["download", "verify", "extract"]);
});

test("cleanupLeftovers removes stale staging and unknown partials", async () => {
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  mkdirSync(join(root, ".partial"), { recursive: true });
  writeFileSync(join(root, ".partial", "gone.tar.bz2.part"), "x");
  mkdirSync(join(root, "fixture.extracting"));
  const manager = createSpeechModelManager({ root: () => root, catalog: [spec("http://127.0.0.1:1/x", 10, "0".repeat(64))] });
  await manager.cleanupLeftovers();
  assert.equal(existsSync(join(root, ".partial", "gone.tar.bz2.part")), false);
  assert.equal(existsSync(join(root, "fixture.extracting")), false);
});

test("listModels projects catalog metadata and derived size labels", () => {
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const manager = createSpeechModelManager({ root: () => root });
  const v3 = manager.listModels().find((m) => m.id === "parakeet-v3");
  assert.equal(v3?.sizeLabel, "487 MB");
  assert.equal(v3?.installed, false);
  assert.equal(v3?.capabilities.autoDetect, true);
  assert.equal(v3?.languages.length, 25);
});
```

- [ ] **Step 2: Run it to verify it fails.** Run `npx tsx --test main/services/local-speech-downloads.test.ts`. Expected: module not found.

- [ ] **Step 3: Implement `local-speech-downloads.ts`.**

  **Paths.**
  - `root/.partial/<id>.tar.bz2.part` holds the partial download.
  - `root/<id>.extracting/` is the staging directory.
  - `root/<id>/` is the installed model.
  - Create the root with mode `0o700`.

  **Start of `downloadModel`.**
  - Reject a duplicate download.
  - Open the partial. If its size equals `bytes`, skip to verify.
  - If its size is greater than 0, request with `Range: bytes=<size>-`.

  **Response handling.**
  - **206:** parse `content-range` with `/^bytes (\d+)-/`. If the start isn't equal to the partial size, delete the partial and throw `Error("The download server returned an unexpected range. Press Download to restart.")`.
  - **200 to a Range request:** truncate the partial to 0.
  - **416:** fall through to verify. Verify throws on a mismatch.
  - **Any other non-ok status:** throw `Download failed: <status>`.

  **Connect timeout.** Use an `AbortController` that aborts after `connectMs` if `fetch` hasn't resolved. Clear it once headers arrive.

  **Reading the body.**
  - Use `res.body.getReader()`.
  - Arm a stall timer (`stallMs`) that is reset on every chunk. When it fires, abort and throw `Error("The download stalled. Press Download to resume.")`, keeping the partial.
  - Append to the partial with `fs.createWriteStream(part, { flags: "a" })`.
  - Cut at `bytes`: if the total would exceed `bytes`, abort and throw `Error("The download is larger than expected and was corrupted. Try again.")` after deleting the partial.

  **Progress.** Emit at most every 200 ms: `percentage = Math.min(90, round(done / bytes * 90))`, `phase: "download"`.

  **Verify.**
  - Emit `phase: "verify"` at 90 %.
  - Hash the complete partial by streaming it through `createHash("sha256")`. This one pass covers resumed bytes too.
  - On a mismatch, delete the partial and throw `Error("The download was corrupted. Try again.")`.

  **Extract.**
  - Emit `phase: "extract"` from 90 % to 100 %.
  - Recreate the staging directory and run `execFile("/usr/bin/tar" (fallback "tar" when /usr/bin/tar is absent), ["-xjf", part, "-C", staging, "--strip-components=1"], { timeout: 300_000, signal })`.
  - Walk the staging directory and delete every file whose relative path isn't a value in `spec.files`, then delete any empty directories.
  - Check that every `spec.files` value exists.
  - `rm -rf root/<id>`, rename staging to it, then delete the partial.

  **Cancel.** Abort the controller, keep the partial, and clear the state.

  **Failure state.** Record `status: "failed"` with the message, as today.

  **`cleanupLeftovers()`.**
  - Delete every `*.extracting` directory.
  - Delete every `.partial/*.part` whose id isn't in the catalog or isn't currently downloading.
  - Also delete legacy `.<id>.staging-*` directories.

  **`listModels()`.** Map the catalog to `LocalModel`:
  - `sizeLabel: formatSizeLabel(spec.archive.bytes)`
  - `quant: "int8"`
  - `languagesLabel: languagesLabel(spec)`
  - `languages: [...spec.languages]`
  - `capabilities` and `license` copied across

  **`isModelInstalled`.** Every value in `spec.files` exists under `root/<id>`.

- [ ] **Step 4: Implement `local-speech-models.ts`** (Electron wiring).

```ts
import path from "node:path";
import { rm } from "node:fs/promises";
import { app, ipcMain, logger } from "../platform.js";
import { createSpeechModelManager } from "./local-speech-downloads.js";
export type { LocalModel, LocalModelDownloadState } from "./local-speech-downloads.js";

const manager = createSpeechModelManager({
  root: () => path.join(app.getPath("userData"), "voice-models"),
  progress: (value) => ipcMain.broadcast("localModels:progress", value),
  info: (message) => logger.info("local-speech", message),
});

export const { modelDir, isModelInstalled, listModels, localModelDownloadStates, downloadModel, cancelDownload, deleteModel, specFor } = manager;

/** Startup housekeeping: pre-1.0 the unverified Parakeet folder is removed, not migrated. */
export async function prepareLocalSpeechStorage(): Promise<void> {
  await rm(path.join(app.getPath("userData"), "parakeet-models"), { recursive: true, force: true }).catch((error: unknown) => {
    logger.warn("local-speech", `Could not remove the legacy Parakeet folder: ${String(error)}`);
  });
  await manager.cleanupLeftovers();
}
```

In `main/index.ts`, after app ready and where other voice handlers are registered, call `void prepareLocalSpeechStorage()`. It doesn't touch the network.

- [ ] **Step 5: Update the importers.**
  - In `packages/cli/src/speech.ts`, use `createSpeechModelManager({ root: () => join(agentDir, "voice-models") })` and run `await rm(join(agentDir, "parakeet-models"), { recursive: true, force: true })` at the start of `createCliSpeech`.
  - Delete `local-models-core.ts` and `local-models.ts`.
  - `grep -rn "local-models" main packages/cli/src renderer scripts` must return nothing.

- [ ] **Step 6: Run tests and register them.** Run `npx tsx --test main/services/local-speech-downloads.test.ts main/services/aiden-remote-speech.test.ts`. Expected: PASS. Append the new test file to `test:voice`. Also run `npm run type-check`.

- [ ] **Step 7: Commit** with `git commit -m "Verified resumable speech model downloads under voice-models"`.

---

### Task 3: Language resolver and voice preferences

**Files:**
- Create: `renderer/shared/voice-language.ts`, `renderer/shared/voice-language.test.ts`, `renderer/shared/voice-preferences.ts`, `renderer/shared/voice-preferences.test.ts`
- Modify:
  - `main/services/types.ts` (`AppSettings` gains the three keys)
  - `main/handlers/providers.ts` (`settings:set` merges `parseVoicePreferencePatch`; find where `parseDictationPreferencePatch` is applied and do the same)
  - `main/services/portable-config-core.ts` (import/export allowlist, next to `localVoiceIdleUnloadMinutes`)
  - wherever `runtimeSettingsFrom` drops invalid dictation keys (`grep -rn "runtimeSettingsFrom" main`)
  - `renderer/lib/types.ts` (if it mirrors `AppSettings`)

**Interfaces:**
- Produces:

```ts
// renderer/shared/voice-language.ts
export interface LanguageCapableModel {
  languages: readonly string[];
  capabilities: { autoDetect: boolean; translateToEnglish: boolean };
}
export function normalizeLanguageIntent(value: unknown): string | undefined; // "auto" | base code | undefined
export function effectiveLanguage(model: LanguageCapableModel, intent: string | undefined): { language: string | null; fallback: string | null };
export function effectiveTask(model: LanguageCapableModel, translate: boolean, source: string | null): "transcribe" | "translate";
// renderer/shared/voice-preferences.ts
export interface VoicePreferencePatch { voiceLanguage?: string; voiceTranslateToEnglish?: boolean; voiceTrimSilence?: boolean }
export function parseVoicePreferencePatch(patch: Record<string, unknown>): VoicePreferencePatch;
export function voiceTrimSilenceEnabled(value: boolean | undefined): boolean; // default true
```

`effectiveLanguage(...).fallback` is the language actually used when the intent couldn't be honored, and `null` otherwise. For a model that can't auto-detect, the resolved language is always non-null.

- [ ] **Step 1: Write the failing tests.**

```ts
// renderer/shared/voice-language.test.ts
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
```

```ts
// renderer/shared/voice-preferences.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVoicePreferencePatch, voiceTrimSilenceEnabled } from "./voice-preferences.js";

test("valid voice preferences pass and invalid shapes are dropped", () => {
  assert.deepEqual(parseVoicePreferencePatch({ voiceLanguage: "de", voiceTranslateToEnglish: true, voiceTrimSilence: false }),
    { voiceLanguage: "de", voiceTranslateToEnglish: true, voiceTrimSilence: false });
  assert.deepEqual(parseVoicePreferencePatch({ voiceLanguage: "klingon!", voiceTranslateToEnglish: "yes", voiceTrimSilence: 0 }), {});
  assert.deepEqual(parseVoicePreferencePatch({ unrelated: 1 }), {});
});

test("trim silence defaults on", () => {
  assert.equal(voiceTrimSilenceEnabled(undefined), true);
  assert.equal(voiceTrimSilenceEnabled(false), false);
});
```

- [ ] **Step 2: Run them to verify they fail.** Run `npx tsx --test renderer/shared/voice-language.test.ts renderer/shared/voice-preferences.test.ts`. Expected: module not found.

- [ ] **Step 3: Implement.**

```ts
// renderer/shared/voice-language.ts
export interface LanguageCapableModel {
  languages: readonly string[];
  capabilities: { autoDetect: boolean; translateToEnglish: boolean };
}

const ALIASES: Record<string, string> = { nb: "no", fil: "tl", iw: "he", in: "id" };

export function normalizeLanguageIntent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.trim().toLowerCase();
  if (lower === "auto") return "auto";
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(lower) ? lower : undefined;
}

function autoChoice(model: LanguageCapableModel): string | null {
  if (model.capabilities.autoDetect) return null;
  return model.languages.includes("en") ? "en" : (model.languages[0] ?? "en");
}

/** Resolve a user's language intent for one model at the point of use; never persisted. */
export function effectiveLanguage(
  model: LanguageCapableModel,
  intent: string | undefined,
): { language: string | null; fallback: string | null } {
  const normalized = normalizeLanguageIntent(intent) ?? "auto";
  if (normalized === "auto") return { language: autoChoice(model), fallback: null };
  const base = normalized.split("-")[0]!;
  for (const candidate of [normalized, base, ALIASES[base]]) {
    if (candidate && model.languages.includes(candidate)) return { language: candidate, fallback: null };
  }
  const chosen = autoChoice(model);
  return { language: chosen, fallback: chosen ?? "auto" };
}

export function effectiveTask(
  model: LanguageCapableModel,
  translate: boolean,
  source: string | null,
): "transcribe" | "translate" {
  return translate && model.capabilities.translateToEnglish && source !== null && source !== "en"
    ? "translate"
    : "transcribe";
}
```

```ts
// renderer/shared/voice-preferences.ts
import { normalizeLanguageIntent } from "./voice-language.js";

export interface VoicePreferencePatch {
  voiceLanguage?: string;
  voiceTranslateToEnglish?: boolean;
  voiceTrimSilence?: boolean;
}

export function parseVoicePreferencePatch(patch: Record<string, unknown>): VoicePreferencePatch {
  const result: VoicePreferencePatch = {};
  if ("voiceLanguage" in patch) {
    const language = normalizeLanguageIntent(patch.voiceLanguage);
    if (language) result.voiceLanguage = language;
  }
  if (typeof patch.voiceTranslateToEnglish === "boolean") result.voiceTranslateToEnglish = patch.voiceTranslateToEnglish;
  if (typeof patch.voiceTrimSilence === "boolean") result.voiceTrimSilence = patch.voiceTrimSilence;
  return result;
}

export function voiceTrimSilenceEnabled(value: boolean | undefined): boolean {
  return value !== false;
}
```

Add to `AppSettings` in `main/services/types.ts`, next to `localVoiceModel`:

```ts
  /** "auto" or a base language code; resolved per model at use (see renderer/shared/voice-language.ts). */
  voiceLanguage?: string;
  /** Translate speech to English when the active on-device model can. */
  voiceTranslateToEnglish?: boolean;
  /** Trim silence and segment long audio with Silero VAD before on-device decode (default on). */
  voiceTrimSilence?: boolean;
```

Wire `parseVoicePreferencePatch` into `settings:set`, the portable config allowlist and `runtimeSettingsFrom` exactly where the dictation keys are handled. Mirror the type in `renderer/lib/types.ts` if `AppSettings` is duplicated there.

- [ ] **Step 4: Run tests.** Run the two files plus `npx tsx --test main/services/portable-config-core.test.ts`. Expected: PASS. If portable-config has an exhaustive key test, extend it with the three keys. Register both new files in `test:voice`. Run `npm run type-check`.

- [ ] **Step 5: Commit** with `git commit -m "Add voice language resolver and voice preferences"`.

---

### Task 4: VAD segment planning

**Files:** Create `main/services/local-speech-vad.ts` and `main/services/local-speech-vad.test.ts`.

**Interfaces:**
- Produces:

```ts
export interface SampleRange { start: number; end: number } // [start, end) in samples
export const VAD_PAD_SAMPLES: number;       // 7200 (450 ms @ 16 kHz)
export const MAX_SEGMENT_SECONDS = 28;
export function planSegments(regions: readonly SampleRange[], totalSamples: number, maxWindowSeconds: number | null, sampleRate?: number): SampleRange[];
export function fixedChunks(totalSamples: number, maxWindowSeconds: number | null, sampleRate?: number): SampleRange[];
```

- [ ] **Step 1: Write the failing tests.**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixedChunks, planSegments, VAD_PAD_SAMPLES } from "./local-speech-vad.js";

const SR = 16_000;
const s = (seconds: number) => Math.round(seconds * SR);

test("no speech plans nothing", () => {
  assert.deepEqual(planSegments([], s(10), 30), []);
  assert.deepEqual(planSegments([], s(10), null), []);
});

test("unwindowed models get one trimmed range with padding", () => {
  const plan = planSegments([{ start: s(2), end: s(3) }, { start: s(6), end: s(7) }], s(10), null);
  assert.deepEqual(plan, [{ start: s(2) - VAD_PAD_SAMPLES, end: s(7) + VAD_PAD_SAMPLES }]);
});

test("padding clamps to the clip", () => {
  const plan = planSegments([{ start: 100, end: s(1) }], s(1.2), null);
  assert.deepEqual(plan, [{ start: 0, end: s(1.2) }]);
});

test("close regions merge; windows never exceed 28 s", () => {
  const regions = [{ start: s(1), end: s(10) }, { start: s(10.2), end: s(20) }, { start: s(25), end: s(40) }];
  const plan = planSegments(regions, s(45), 30);
  for (const range of plan) assert.ok(range.end - range.start <= s(28), JSON.stringify(range));
  assert.ok(plan.length >= 2);
});

test("a 10-minute recording is fully covered without overlap", () => {
  const regions = Array.from({ length: 120 }, (_, i) => ({ start: s(i * 5), end: s(i * 5 + 4) }));
  const total = s(600);
  const plan = planSegments(regions, total, 30);
  assert.ok(plan.length >= 21);
  for (const range of plan) assert.ok(range.end - range.start <= s(28));
  for (let i = 1; i < plan.length; i++) assert.ok(plan[i]!.start >= plan[i - 1]!.end, "windows must not overlap");
  for (const region of regions) {
    const covering = plan.filter((r) => r.start <= region.start && r.end >= region.end);
    assert.equal(covering.length, 1, `region ${region.start} covered exactly once`);
  }
});

test("a single region longer than the window is split at the limit", () => {
  const plan = planSegments([{ start: 0, end: s(70) }], s(70), 30);
  assert.equal(plan.length, 3);
  assert.equal(plan[0]!.end - plan[0]!.start, s(28));
  assert.equal(plan.at(-1)!.end, s(70));
});

test("fixedChunks covers the clip in ≤28 s pieces for windowed models", () => {
  assert.deepEqual(fixedChunks(s(60), 30).map((r) => r.end - r.start), [s(28), s(28), s(4)]);
  assert.deepEqual(fixedChunks(s(60), null), [{ start: 0, end: s(60) }]);
});
```

- [ ] **Step 2: Run it to verify it fails** (module not found).

- [ ] **Step 3: Implement.**

```ts
// Pure planning of which sample ranges to decode after Silero VAD. Values
// follow Handy's SmoothedVad (450 ms pre/post roll) adapted to whole-clip
// decoding; window packing keeps Whisper/Moonshine/SenseVoice under 30 s.
// Padding never crosses the midpoint to a neighbouring region, so window
// seams fall in silence and every detected region lands in exactly one window.

export interface SampleRange { start: number; end: number }

const DEFAULT_RATE = 16_000;
export const VAD_PAD_SAMPLES = Math.round(0.45 * DEFAULT_RATE);
export const MAX_SEGMENT_SECONDS = 28;

function paddedBounds(regions: readonly SampleRange[], total: number, pad: number): SampleRange[] {
  const sorted = [...regions]
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(total, r.end) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  return sorted.map((region, index) => {
    const previous = sorted[index - 1];
    const next = sorted[index + 1];
    const start = previous
      ? Math.max(region.start - pad, Math.ceil((previous.end + region.start) / 2))
      : Math.max(0, region.start - pad);
    const end = next
      ? Math.min(region.end + pad, Math.floor((region.end + next.start) / 2))
      : Math.min(total, region.end + pad);
    return { start, end };
  });
}

function split(range: SampleRange, limit: number): SampleRange[] {
  const out: SampleRange[] = [];
  for (let start = range.start; start < range.end; start += limit) out.push({ start, end: Math.min(range.end, start + limit) });
  return out;
}

export function planSegments(
  regions: readonly SampleRange[],
  totalSamples: number,
  maxWindowSeconds: number | null,
  sampleRate = DEFAULT_RATE,
): SampleRange[] {
  const bounds = paddedBounds(regions, totalSamples, Math.round(VAD_PAD_SAMPLES * (sampleRate / DEFAULT_RATE)));
  if (bounds.length === 0) return [];
  if (maxWindowSeconds === null) return [{ start: bounds[0]!.start, end: bounds.at(-1)!.end }];
  const limit = Math.min(maxWindowSeconds - 2, MAX_SEGMENT_SECONDS) * sampleRate;
  const windows: SampleRange[] = [];
  for (const range of bounds.flatMap((r) => (r.end - r.start > limit ? split(r, limit) : [r]))) {
    const last = windows.at(-1);
    if (last && range.end - last.start <= limit) last.end = range.end;
    else windows.push({ ...range });
  }
  return windows;
}

export function fixedChunks(totalSamples: number, maxWindowSeconds: number | null, sampleRate = DEFAULT_RATE): SampleRange[] {
  if (totalSamples <= 0) return [];
  if (maxWindowSeconds === null) return [{ start: 0, end: totalSamples }];
  return split({ start: 0, end: totalSamples }, Math.min(maxWindowSeconds - 2, MAX_SEGMENT_SECONDS) * sampleRate);
}
```

- [ ] **Step 4: Run tests** (PASS) and register the file in `test:voice`.

- [ ] **Step 5: Commit** with `git commit -m "Plan VAD speech segments for windowed recognizers"`.

---

### Task 5: Engine adapter (families, single slot, VAD, results)

**Files:**
- Rename: `git mv main/services/parakeet-engine.ts main/services/local-speech-engine.ts`
- Create: `main/services/local-speech-engine.test.ts`

**Interfaces:**
- Consumes: `SpeechModelSpec` (Task 1), `planSegments`, `fixedChunks`, `SampleRange` (Task 4).
- Produces:

```ts
export interface SherpaModule {
  OfflineRecognizer: new (config: unknown) => SherpaRecognizer;
  Vad: new (config: unknown, bufferSizeInSeconds: number) => SherpaVad;
}
export interface EngineTranscribeRequest {
  spec: SpeechModelSpec; modelDirectory: string; samples: Float32Array;
  language: string | null; task: "transcribe" | "translate";
  trimSilence: boolean; vadModelPath: string;
}
export interface EngineTranscribeResult { text: string; language: string | null; decodeMs: number }
export function buildRecognizerConfig(spec: SpeechModelSpec, dir: string, opts: { language: string | null; task: "transcribe" | "translate" }): Record<string, unknown>;
export function joinSegmentTexts(texts: readonly string[]): string;
export function createSpeechEngine(load: () => SherpaModule): {
  status(): { ready: boolean; error: string | null };
  load(spec: SpeechModelSpec, dir: string): { loadMs: number };
  transcribe(request: EngineTranscribeRequest): EngineTranscribeResult;
  release(): void;
  loadedModelId(): string | null;
};
export const speechEngine: ReturnType<typeof createSpeechEngine>; // default instance using require("sherpa-onnx-node")
```

- [ ] **Step 1: Write the failing tests.** They use a fake sherpa module that records configs and lets a test script `setConfig` throws, VAD regions and decode text.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SPEECH_MODELS, speechModel } from "./local-speech-catalog.js";
import { buildRecognizerConfig, createSpeechEngine, joinSegmentTexts, type SherpaModule } from "./local-speech-engine.js";

function fakeSherpa(options: { regions?: Array<[number, number]>; setConfigThrows?: boolean; text?: (n: number) => string } = {}) {
  const created: unknown[] = [];
  const released: number[] = [];
  let decodes = 0;
  const streamOptions: Array<[string, string]> = [];
  class OfflineRecognizer {
    id = created.length;
    constructor(public config: unknown) { created.push(config); }
    createStream() { return { samples: 0, acceptWaveform: function (this: { samples: number }, i: { samples: Float32Array }) { this.samples = i.samples.length; }, setOption: (k: string, v: string) => streamOptions.push([k, v]) }; }
    setConfig(config: unknown) { if (options.setConfigThrows) throw new Error("unsupported"); this.config = config; }
    decode() { decodes += 1; }
    getResult(stream: { samples: number }) { return { text: options.text?.(decodes) ?? ` part${decodes} `, lang: "<|de|>", samples: stream.samples }; }
  }
  class Vad {
    queue: Array<{ start: number; samples: Float32Array }> = [];
    constructor(public config: unknown) {}
    acceptWaveform() {}
    flush() { this.queue = (options.regions ?? []).map(([s, e]) => ({ start: s, samples: new Float32Array(e - s) })); }
    isEmpty() { return this.queue.length === 0; }
    front() { return this.queue[0]!; }
    pop() { this.queue.shift(); }
  }
  return { module: { OfflineRecognizer, Vad } as unknown as SherpaModule, created, released, streamOptions, decodes: () => decodes };
}

const v3 = speechModel("parakeet-v3")!;
const canary = speechModel("canary-180m-flash")!;
const whisper = speechModel("whisper-turbo")!;
const sense = speechModel("sense-voice")!;
const moon = speechModel("moonshine-base-en")!;
const req = (spec = v3, extra: Partial<Parameters<ReturnType<typeof createSpeechEngine>["transcribe"]>[0]> = {}) => ({
  spec, modelDirectory: "/m", samples: new Float32Array(16_000 * 3), language: null, task: "transcribe" as const,
  trimSilence: false, vadModelPath: "/vad.onnx", ...extra,
});

test("every catalog family maps each file role into the recognizer config", () => {
  for (const spec of SPEECH_MODELS) {
    const json = JSON.stringify(buildRecognizerConfig(spec, "/dir", { language: null, task: "transcribe" }));
    for (const file of Object.values(spec.files)) assert.ok(json.includes(`/dir/${file}`), `${spec.id} missing ${file}`);
    assert.ok(json.includes('"numThreads":2') && json.includes('"provider":"cpu"'), spec.id);
  }
});

test("canary translate targets English; transcribe keeps the source language", () => {
  const t = buildRecognizerConfig(canary, "/d", { language: "de", task: "translate" }) as { modelConfig: { canary: { srcLang: string; tgtLang: string } } };
  assert.deepEqual([t.modelConfig.canary.srcLang, t.modelConfig.canary.tgtLang], ["de", "en"]);
  const s = buildRecognizerConfig(canary, "/d", { language: "fr", task: "transcribe" }) as typeof t;
  assert.deepEqual([s.modelConfig.canary.srcLang, s.modelConfig.canary.tgtLang], ["fr", "fr"]);
});

test("whisper auto passes an empty language and sense-voice uses auto", () => {
  const w = buildRecognizerConfig(whisper, "/d", { language: null, task: "transcribe" }) as { modelConfig: { whisper: { language: string } } };
  assert.equal(w.modelConfig.whisper.language, "");
  const sv = buildRecognizerConfig(sense, "/d", { language: null, task: "transcribe" }) as { modelConfig: { senseVoice: { language: string } } };
  assert.equal(sv.modelConfig.senseVoice.language, "auto");
  const m = buildRecognizerConfig(moon, "/d", { language: null, task: "transcribe" }) as { modelConfig: { moonshine: Record<string, string> } };
  assert.deepEqual(Object.keys(m.modelConfig.moonshine).sort(), ["encoder", "mergedDecoder"]);
});

test("one model slot: loading another model replaces the recognizer", () => {
  const fake = fakeSherpa();
  const engine = createSpeechEngine(() => fake.module);
  engine.load(v3, "/a");
  engine.load(v3, "/a");
  assert.equal(fake.created.length, 1);
  engine.load(canary, "/b");
  assert.equal(fake.created.length, 2);
  assert.equal(engine.loadedModelId(), "canary-180m-flash");
});

test("a language change uses setConfig, and rebuilds when setConfig throws", () => {
  const ok = fakeSherpa();
  const engine = createSpeechEngine(() => ok.module);
  engine.transcribe(req(canary, { language: "de" }));
  engine.transcribe(req(canary, { language: "fr" }));
  assert.equal(ok.created.length, 1);
  const broken = fakeSherpa({ setConfigThrows: true });
  const engine2 = createSpeechEngine(() => broken.module);
  engine2.transcribe(req(canary, { language: "de" }));
  engine2.transcribe(req(canary, { language: "fr" }));
  assert.equal(broken.created.length, 2);
});

test("whisper language is applied per stream", () => {
  const fake = fakeSherpa();
  createSpeechEngine(() => fake.module).transcribe(req(whisper, { language: "de" }));
  assert.deepEqual(fake.streamOptions, [["language", "de"]]);
});

test("trimmed silence decodes nothing and returns empty text", () => {
  const fake = fakeSherpa({ regions: [] });
  const result = createSpeechEngine(() => fake.module).transcribe(req(whisper, { trimSilence: true }));
  assert.equal(result.text, "");
  assert.equal(fake.decodes(), 0);
});

test("long whisper audio is decoded in ≤28 s windows and joined", () => {
  const fake = fakeSherpa({ regions: [[0, 16_000 * 25], [16_000 * 30, 16_000 * 55], [16_000 * 60, 16_000 * 85]] });
  const result = createSpeechEngine(() => fake.module).transcribe(req(whisper, { trimSilence: true, samples: new Float32Array(16_000 * 90) }));
  assert.equal(fake.decodes(), 3);
  assert.equal(result.text, "part1 part2 part3");
  assert.equal(result.language, "de");
});

test("short clips are padded to 1.25 s before decode", () => {
  const fake = fakeSherpa({ text: () => "hi" });
  const engine = createSpeechEngine(() => fake.module);
  const result = engine.transcribe(req(v3, { samples: new Float32Array(4000) }));
  assert.equal(result.text, "hi");
});

test("CJK segments join without spaces; others with one space", () => {
  assert.equal(joinSegmentTexts(["你好", "世界"]), "你好世界");
  assert.equal(joinSegmentTexts(["hello", "world"]), "hello world");
  assert.equal(joinSegmentTexts(["hello", "", "  world "]), "hello world");
});

test("VAD failure fails open to decoding the clip", () => {
  const fake = fakeSherpa();
  (fake.module as unknown as { Vad: unknown }).Vad = class { constructor() { throw new Error("no vad"); } };
  const result = createSpeechEngine(() => fake.module).transcribe(req(v3, { trimSilence: true }));
  assert.equal(fake.decodes(), 1);
  assert.ok(result.text.length > 0);
});
```

Also add a guarded integration test against the real `sherpa-onnx-node` `Vad` and the bundled model. Skip it with a reason when the native module fails to load. The PCM is 1 s silence, 1 s of a 220 Hz sine at 0.3 amplitude modulated like speech (alternate 100 ms on/off), then 1 s silence. Assert at least one region starts between 0.8 s and 1.3 s. If Silero doesn't trigger on synthetic tone, generate the audio with macOS `say -o /tmp/x.aiff "hello world"` plus `afconvert` when `process.platform === "darwin"`, and skip elsewhere. Record which approach worked in `## Progress`.

- [ ] **Step 2: Run tests to verify they fail.**

- [ ] **Step 3: Implement** `local-speech-engine.ts`. Keep the existing lazy `require("sherpa-onnx-node")` with cached error.

  **`buildRecognizerConfig`.** Base object:
  - `featConfig: { sampleRate: 16000, featureDim: 80 }`
  - `modelConfig: { tokens: join(dir, files.tokens), numThreads: 2, provider: "cpu", debug: 0, ...family }`

  Family part per spec §5:

  | Family | Config |
  |---|---|
  | `nemo-transducer` | `transducer: { encoder, decoder, joiner }`, plus `modelType: "nemo_transducer"` in `modelConfig` |
  | `nemo-canary` | `canary: { encoder, decoder, srcLang: language ?? "en", tgtLang: task === "translate" ? "en" : (language ?? "en"), usePnc: 1 }` |
  | `whisper` | `whisper: { encoder, decoder, language: language ?? "", task: "transcribe" }` |
  | `sense-voice` | `senseVoice: { model, language: language ?? "auto", useInverseTextNormalization: 1 }` |
  | `moonshine-v2` | `moonshine: { encoder, mergedDecoder }` |

  **Slot.** The slot holds `{ id, configKey, recognizer }`, where `configKey = JSON.stringify({ language, task })` for families that bake the language into the config (canary, sense-voice) and `""` otherwise.
  - `load()` builds the recognizer when the slot id differs, and returns `loadMs` from `performance.now()`.
  - `transcribe()` handles a `configKey` change as follows: `try { recognizer.setConfig(config) } catch { rebuild }`.

  **Decode.**
  1. Pad samples shorter than 16000 to 20000 with zeros.
  2. Compute ranges. With `trimSilence`, use `vadRegions()` followed by `planSegments(regions, n, spec.capabilities.maxWindowSeconds)`. Without it, use `fixedChunks(n, maxWindowSeconds)`.
  3. For each range, create a stream. For whisper with a non-null language, call `stream.setOption("language", language)`. Then call `acceptWaveform({ sampleRate: 16000, samples: samples.subarray(start, end) })`, `decode`, and `getResult`.
  4. Join the results with `joinSegmentTexts`.
  5. Read `language` from the first result whose `lang` matches `/<\|([a-z]{2,3})\|>|^([a-z]{2,3})$/`.
  6. Return `decodeMs`.

  **`vadRegions(samples)`.**
  - Create `new sherpa.Vad({ sileroVad: { model: vadModelPath, threshold: 0.3, minSilenceDuration: 0.45, minSpeechDuration: 0.06, windowSize: 512, maxSpeechDuration: 28 }, sampleRate: 16000, numThreads: 1, provider: "cpu", debug: 0 }, 60)`.
  - Feed in 512-sample windows, `flush()`, then drain `front()`/`pop()` into `{ start, end: start + samples.length }`.
  - Wrap everything in try/catch. On a throw, log `console.warn` (stderr) and return `null`, which makes the caller use `fixedChunks`.

  **`joinSegmentTexts`.** Trim each part and drop empty ones. Join with `""` when the previous text ends and the next text begins with a CJK character (`/[぀-ヿ㐀-鿿가-힯]/`); otherwise join with `" "`.

  **Default instance.** `export const speechEngine = createSpeechEngine(loadSherpa)`.

  **Remove** the old exports (`engineStatus`, `transcribePcm`, `warmRecognizer`, `releaseRecognizer`) and update importers in Task 6.

- [ ] **Step 4: Run tests** (PASS) and register the file in `test:voice`.

- [ ] **Step 5: Commit** with `git commit -m "Engine-neutral sherpa adapter with VAD segmentation"`.

---

### Task 6: Protocol v2, worker, supervision and parent service

**Files:**
- Renames (`git mv`):
  - `parakeet-protocol.ts` → `local-speech-protocol.ts`
  - `parakeet-worker.ts` → `local-speech-worker.ts`
  - `parakeet-process-core.ts` → `local-speech-process-core.ts`
  - `parakeet-transcription-lane.ts` → `local-speech-lane.ts`
  - `parakeet-idle-unload.ts` → `local-speech-idle-unload.ts`
  - `parakeet.ts` → `local-speech.ts`
  - their `.test.ts` files likewise
- Modify:
  - `scripts/build-electron.mjs` (worker entry `local-speech-worker`)
  - `scripts/verify-macos-package.mjs` and its test (entry name, plus `speech/silero_vad.onnx` present)
  - `scripts/verify-linux-package.mjs` (same resource check)
  - `main/handlers/local-voice.ts`
  - `main/services/aiden-remote-speech.ts`
  - `main/services/dictation.ts`
  - `main/handlers/providers.ts` (`reconfigureParakeetIdleUnload` → `reconfigureLocalSpeechIdleUnload`)
  - `packages/cli/src/speech.ts`, `packages/cli/src/speech-worker.ts`, `packages/cli/scripts/build.mjs` (copy `resources/speech/silero_vad.onnx` to `dist/app/speech/silero_vad.onnx`)
  - `packages/cli/tests/bundle.test.mjs` (assert that file exists)
  - `renderer/lib/voice-recorder-core.ts`, `renderer/lib/ipc-voice.ts`
  - every `parakeet` importer (`grep -rln "parakeet" main renderer packages/cli/src scripts`)

**Interfaces:**
- Consumes: `speechEngine` and `EngineTranscribeResult` (Task 5); `specFor`, `modelDir` and `isModelInstalled` (Task 2); `effectiveLanguage`, `effectiveTask` and `voiceTrimSilenceEnabled` (Task 3).
- Produces:

```ts
// local-speech-protocol.ts
export const LOCAL_SPEECH_PROTOCOL_VERSION = 2 as const;
export const MAX_PCM_SAMPLES = 16_000 * 60 * 30;
export type LocalSpeechAudio = { kind: "pcm16"; pcm: Int16Array } | { kind: "ogg-opus"; bytes: Uint8Array };
export type LocalSpeechParentMessage =
  | { version: 2; kind: "status"; requestId: string }
  | { version: 2; kind: "load"; requestId: string; modelId: string; modelDirectory: string; spec: SpeechModelSpec }
  | { version: 2; kind: "transcribe"; requestId: string; modelId: string; modelDirectory: string; spec: SpeechModelSpec;
      audio: LocalSpeechAudio; language: string | null; translate: boolean; trimSilence: boolean; vadModelPath: string }
  | { version: 2; kind: "release"; requestId: string };
export type LocalSpeechWorkerMessage =
  | { version: 2; kind: "result"; requestId: string; ready?: boolean; error?: string | null; text?: string; language?: string | null; decodeMs?: number; loadMs?: number }
  | { version: 2; kind: "failure"; requestId: string; message: string; code?: "model-missing" | "engine-unavailable" | "decode-failed" | "unsupported-audio" };
export function isLocalSpeechParentMessage(v: unknown): v is LocalSpeechParentMessage;
export function isLocalSpeechWorkerMessage(v: unknown): v is LocalSpeechWorkerMessage;
// local-speech-process-core.ts
export function transcribeDeadlineMs(audioSeconds: number): number; // max(120_000, 20_000 × s)
export const LOAD_DEADLINE_MS = 180_000; export const STATUS_DEADLINE_MS = 30_000;
export class LocalSpeechProcessClient { /* status(), load(), transcribe() → {text, language, decodeMs}, release(), dispose(), stderrTail(): string[], pushStderr(line: string) */ }
export async function runWithCrashRetry<T>(attempt: (n: 1 | 2) => Promise<T>, opts: { isCancelled(): boolean; isCrash(error: unknown): boolean; onCrash(error: unknown, n: 1 | 2): void }): Promise<T>;
export class WorkerCrashError extends Error {}
// local-speech.ts (public)
export async function engineStatus(): Promise<{ ready: boolean; error: string | null }>;
export async function warmLocalVoice(modelId: string): Promise<void>;
export async function releaseRecognizer(modelId: string): Promise<void>;
export async function transcribeLocalPcm16(pcm: Int16Array, modelId: string, signal?: AbortSignal): Promise<string>;
export async function transcribeLocalOggOpus(bytes: Uint8Array, modelId: string, signal?: AbortSignal): Promise<string>;
export function reconfigureLocalSpeechIdleUnload(): Promise<void>;
export function disposeLocalSpeech(): void;
export function onLocalSpeechState(listener: (state: LocalSpeechState) => void): () => void; // used by Task 8
export interface LocalSpeechState { modelId: string; state: "loading" | "ready" | "failed" | "unloaded"; error?: string }
```

The worker translates on its own: it calls `effectiveTask(spec, translate, language ?? detected)` with the resolved language. The parent passes the already-resolved `language` from `effectiveLanguage(spec, settings.voiceLanguage).language` and `translate = settings.voiceTranslateToEnglish === true`.

- [ ] **Step 1: Write the failing tests.**

`local-speech-protocol.test.ts` (rename and rewrite):
- A v2 `transcribe` with `audio: { kind: "pcm16", pcm: new Int16Array(10) }` validates.
- `pcm` longer than `MAX_PCM_SAMPLES` is rejected.
- `language: "Deutsch"` is rejected; `"de"` and `null` are accepted.
- `spec.id !== modelId` is rejected.
- A version 1 message is rejected.
- A `failure` with an unknown `code` is rejected.

`local-speech-process-core.test.ts` (rename and extend). Keep the existing cases and add:

```ts
test("deadlines scale with audio length", () => {
  assert.equal(transcribeDeadlineMs(3), 120_000);
  assert.equal(transcribeDeadlineMs(600), 12_000_000);
});

test("crash retries once in a fresh worker, then fails clearly; the lane survives", async () => {
  const attempts: number[] = [];
  await assert.rejects(
    runWithCrashRetry(async (n) => { attempts.push(n); throw new WorkerCrashError("exit 9"); }, { isCancelled: () => false, isCrash: (e) => e instanceof WorkerCrashError, onCrash: () => {} }),
    /couldn't finish|decode-failed/i,
  );
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(await runWithCrashRetry(async () => "ok", { isCancelled: () => false, isCrash: () => true, onCrash: () => {} }), "ok");
});

test("a cancelled request is never retried", async () => {
  let calls = 0;
  await assert.rejects(runWithCrashRetry(async () => { calls += 1; throw new WorkerCrashError("killed"); }, { isCancelled: () => true, isCrash: () => true, onCrash: () => {} }));
  assert.equal(calls, 1);
});

test("non-crash errors are not retried", async () => {
  let calls = 0;
  await assert.rejects(runWithCrashRetry(async () => { calls += 1; throw new Error("model missing"); }, { isCancelled: () => false, isCrash: (e) => e instanceof WorkerCrashError, onCrash: () => {} }), /model missing/);
  assert.equal(calls, 1);
});

test("stderr tail keeps the last 64 lines and an exit reports a WorkerCrashError", async () => {
  // Build a client on a fake port (existing test helper), push 70 stderr lines, fire exit(134):
  // expect pending request rejects with WorkerCrashError and stderrTail() has length 64 ending with line 69.
});
```

Write the last test fully, reusing the existing fake-port helper in the renamed test file.

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implement.**

  **Protocol.** Validators check `pcm instanceof Int16Array` (and `bytes instanceof Uint8Array` for ogg-opus) with length bounds. `language === null || /^[a-z]{2,3}$/`. `spec` is a record whose `id` equals `modelId`, whose `family` is one of the five, and whose `files` is a record of strings.

  **Process core.**
  - Replace the fixed timeout with a per-request deadline: status 30 s, load 180 s, transcribe `transcribeDeadlineMs(samples / 16000)`; for ogg-opus, estimate seconds as `bytes / 2000`.
  - On timeout, call `onHang` (the parent kills the worker) and reject with `WorkerCrashError("hang")`.
  - Port exit rejects all pending requests with `WorkerCrashError(\`exit ${code}\`)`.
  - Keep a 64-line ring buffer filled by `pushStderr(line)`.
  - `runWithCrashRetry`:
    - Attempt 1. On error: if `isCancelled()` or `!isCrash(error)`, rethrow.
    - Otherwise call `onCrash(error, 1)` and run attempt 2.
    - On a second crash, call `onCrash(error, 2)` and throw `Error("On-device transcription couldn't finish (decode-failed). Try again.")`.

  **Worker** (`local-speech-worker.ts`):
  - Handles `status`, `load` (`speechEngine.load`, replying with `loadMs`) and `release` (`speechEngine.release()`).
  - Handles `transcribe`:
    1. Convert `pcm16` to Float32 by dividing by 32768.
    2. For `ogg-opus`, `await` the decoder from Task 7. Until Task 7 lands, reply `failure { code: "unsupported-audio" }`.
    3. Call `speechEngine.transcribe({ spec, modelDirectory, samples, language, task, trimSilence, vadModelPath })`. Compute `task` as `effectiveTask(spec, translate, language)`; that is good enough, since a null source means auto and Canary never auto-detects.
    4. Reply `{ text, language, decodeMs }`.
  - Missing model files produce `code: "model-missing"`.
  - The CLI `speech-worker.ts` gets the same handler body. Move the shared body into `local-speech-worker-core.ts` exporting `handleLocalSpeechMessage(message): Promise<LocalSpeechWorkerMessage>`, and have both entries call it.

  **Parent** (`local-speech.ts`, from `parakeet.ts`):
  - Fork the worker with `stdio: "pipe"`. Read `child.stderr` lines into `client.pushStderr` and drain `child.stdout`.
  - The VAD path is `app.isPackaged ? path.join(process.resourcesPath, "speech", "silero_vad.onnx") : fileURLToPath(new URL("../../resources/speech/silero_vad.onnx", import.meta.url))`. Resolve it in the parent and pass it per request; the CLI passes `join(dirname(process.env.AIDEN_CLI_ENTRY!), "speech", "silero_vad.onnx")`.
  - Transcribe goes through the lane plus a lease, then `runWithCrashRetry`. On a crash, dispose the current client (the next `getClient()` forks fresh) and log `logger.warn("local-speech", "worker crashed", { attempt, stderr: client.stderrTail().join("\n") })`.
  - Settings are read once per request: `voiceLanguage`, `voiceTranslateToEnglish`, `voiceTrimSilence`.
  - Emit state events: `loading` before `load` or before a transcribe that will load (the parent tracks `loadedModelId`); `ready` after; `failed` with the error; `unloaded` on idle unload or dispose.
  - Keep the in-process fallback (`isolationUnavailable`) using `speechEngine` directly.

  **Renderer** (`voice-recorder-core.ts`):
  - Replace `float32ToBase64` with `float32ToPcm16(samples: Float32Array): Int16Array` (clamp to [-1, 1], ×32767, round).
  - Call `voiceApi.transcribeLocal(pcm16.buffer, modelId, operationId)`.
  - In `ipc-voice.ts`, change the signature to `(pcm: ArrayBuffer, modelId: string, operationId: string)`.

  **IPC** (`main/handlers/local-voice.ts`): accept `pcm` as an `ArrayBuffer` or `Uint8Array`. Reject anything else with `Invalid on-device audio.`; reject more than `MAX_PCM_SAMPLES × 2` bytes. Wrap it as `new Int16Array(buffer)`, which requires an even byte length (reject odd lengths), and call `transcribeLocalPcm16`.

  **Remote, CLI and Telegram callers.** Decode the base64 once with the existing `decodeAidenRemotePcm16` (it returns Float32). Add `decodeAidenRemotePcm16ToInt16(base64): Int16Array` in `aiden-remote-speech-codec.ts` and call `transcribeLocalPcm16`. `transcribePcm16Base64` in `local-speech.ts` stays as a thin wrapper for the Remote dependencies.

  **Electron 43 structured-clone check.** Before relying on typed arrays crossing `UtilityProcess.postMessage` and `ipcRenderer.invoke`, run `npm run build && npm run dev`, dictate once with on-device Parakeet, and confirm that the worker receives `pcm instanceof Int16Array`. Add a temporary `console.error` in the worker and remove it afterwards. If a hop delivers a plain object or a `Buffer`, normalize it in the receiving validator (`ArrayBuffer.isView` → `new Int16Array(view.buffer, view.byteOffset, view.byteLength / 2)`). Record the result in `## Progress`.

- [ ] **Step 4: Run the renamed suites and the full voice lane.** Run `npm run test:voice && npm run test:aiden-remote-speech && npm run type-check && npx vite build`. Then in `packages/cli`, run `npm run build && npm test`. Expected: PASS. Update the `test:voice` file list for the renamed tests.

- [ ] **Step 5: Commit** with `git commit -m "Speech worker protocol v2 with binary PCM and crash supervision"`.

---

### Task 7: Provider resolution, cloud language hints and Telegram routing

**Files:**
- Create: `renderer/shared/voice-provider.ts`, `renderer/shared/voice-provider.test.ts`, `main/services/voice-provider-resolution.ts`, `main/services/transcription-routing.test.ts`, `main/services/local-speech-opus.ts`
- Modify:
  - `main/services/transcription.ts` (`transcribe()` routing and OpenAI `language`)
  - `main/services/gemini-live-transcription.ts` (`languageCodes`)
  - `main/handlers/local-voice.ts` (new `voice:resolveProvider` handler)
  - `renderer/lib/ipc-voice.ts` (`voiceApi.resolveProvider`)
  - `renderer/pill-preload-channels.ts` (allow the new channel)
  - `renderer/pill/pill-app.tsx` (3 sites)
  - `renderer/components/composer.tsx`
  - `renderer/components/settings/voice-settings.tsx`
  - `renderer/components/settings/model-manager-view.tsx` (remove auto-activate at about lines 163–175)
  - `main/services/local-speech-worker-core.ts` (ogg-opus)
  - `package.json` (`ogg-opus-decoder` dependency)

**Interfaces:**
- Consumes: `listModels` and `isModelInstalled` (Task 2); `engineStatus` and `transcribeLocalOggOpus` (Task 6); `effectiveLanguage` (Task 3).
- Produces:

```ts
// renderer/shared/voice-provider.ts
export type VoiceProviderResolution =
  | { kind: "ready"; provider: "local"; modelId: string; automatic: boolean }
  | { kind: "ready"; provider: "openai" | "gemini"; automatic: boolean }
  | { kind: "needs-setup"; reason: "no-local-model" | "no-provider" | "local-engine-unavailable" };
export interface VoiceProviderInputs {
  explicit: "openai" | "gemini" | "local" | undefined;
  localModelId: string | undefined;
  installedLocalModels: readonly string[];
  engineReady: boolean;
  hasOpenAIKey: boolean;
  hasGeminiVoice: boolean;
}
export function resolveVoiceProvider(input: VoiceProviderInputs): VoiceProviderResolution;
export function voiceSetupMessage(reason: Extract<VoiceProviderResolution, { kind: "needs-setup" }>["reason"]): string;
// main/services/voice-provider-resolution.ts
export async function resolveVoiceProviderNow(): Promise<VoiceProviderResolution>;
```

- [ ] **Step 1: Write the failing tests.**

```ts
// renderer/shared/voice-provider.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveVoiceProvider, voiceSetupMessage, type VoiceProviderInputs } from "./voice-provider.js";

const base: VoiceProviderInputs = { explicit: undefined, localModelId: undefined, installedLocalModels: [], engineReady: true, hasOpenAIKey: false, hasGeminiVoice: false };

test("automatic prefers an installed on-device model", () => {
  assert.deepEqual(resolveVoiceProvider({ ...base, installedLocalModels: ["parakeet-v3", "whisper-turbo"], hasOpenAIKey: true }),
    { kind: "ready", provider: "local", modelId: "parakeet-v3", automatic: true });
});
test("automatic honors the chosen local model when installed, else the first installed", () => {
  assert.equal((resolveVoiceProvider({ ...base, localModelId: "whisper-turbo", installedLocalModels: ["parakeet-v3", "whisper-turbo"] }) as { modelId: string }).modelId, "whisper-turbo");
  assert.equal((resolveVoiceProvider({ ...base, localModelId: "gone", installedLocalModels: ["sense-voice"] }) as { modelId: string }).modelId, "sense-voice");
});
test("automatic falls back to OpenAI, then Gemini, then setup", () => {
  assert.deepEqual(resolveVoiceProvider({ ...base, hasOpenAIKey: true, hasGeminiVoice: true }), { kind: "ready", provider: "openai", automatic: true });
  assert.deepEqual(resolveVoiceProvider({ ...base, hasGeminiVoice: true }), { kind: "ready", provider: "gemini", automatic: true });
  assert.deepEqual(resolveVoiceProvider(base), { kind: "needs-setup", reason: "no-provider" });
  assert.deepEqual(resolveVoiceProvider({ ...base, installedLocalModels: ["parakeet-v3"], engineReady: false, hasOpenAIKey: true }), { kind: "ready", provider: "openai", automatic: true });
});
test("an explicit choice always wins", () => {
  assert.deepEqual(resolveVoiceProvider({ ...base, explicit: "gemini", installedLocalModels: ["parakeet-v3"] }), { kind: "ready", provider: "gemini", automatic: false });
  assert.deepEqual(resolveVoiceProvider({ ...base, explicit: "openai" }), { kind: "ready", provider: "openai", automatic: false });
  assert.deepEqual(resolveVoiceProvider({ ...base, explicit: "local", hasOpenAIKey: true }), { kind: "needs-setup", reason: "no-local-model" });
  assert.deepEqual(resolveVoiceProvider({ ...base, explicit: "local", installedLocalModels: ["parakeet-v3"], engineReady: false }), { kind: "needs-setup", reason: "local-engine-unavailable" });
});
test("setup messages point to Settings → Voice", () => {
  assert.equal(voiceSetupMessage("no-local-model"), "Download a voice model in Settings → Voice.");
  assert.equal(voiceSetupMessage("no-provider"), "Set up a voice provider in Settings → Voice.");
  assert.match(voiceSetupMessage("local-engine-unavailable"), /Restart Aiden/);
});
```

`main/services/transcription-routing.test.ts`:
- Factor `transcribe()` into a testable `createTranscribeRouter(deps)` in `transcription.ts`, with `deps = { resolve, local: { oggOpus }, openai, gemini }`.
- **Local + ogg:** routes to `local.oggOpus` with the decoded bytes; cloud is never called.
- **Local + `audio/mpeg`:** throws `"This audio format needs a cloud voice provider."`.
- **Needs-setup:** throws the setup message.
- **OpenAI:** routes to `openai`, unchanged.

In the Telegram test (or `telegram-inbound` test if one exists), assert that a local-resolution voice note produces `[Voice transcript]` text with a fake router.

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implement.**
  - **`resolveVoiceProvider`** follows spec §9 exactly. Local model choice: `localModelId` if it's in `installedLocalModels`, else `installedLocalModels[0]`. Automatic local requires `engineReady`.
  - **`resolveVoiceProviderNow()`** gathers:
    - `configStore.getSettings()`;
    - `listModels().filter(m => m.installed).map(m => m.id)`;
    - `engineStatus()` (cached by Task 6's parent);
    - OpenAI key presence via `providerRegistry.getBuiltinRequestAuth("openai")`;
    - Gemini key presence via `getBuiltinRequestAuth(GOOGLE_PROVIDER_ID)` plus `geminiUsageScope` allowing voice. Reuse the existing helper in `renderer/shared/gemini-usage-scope.ts`.

    Key values never leave main. Wrap each lookup in try/catch → false.
  - **IPC.** Register `voice:resolveProvider` (no args) → `resolveVoiceProviderNow()`. Add it to the preload allowlist used by the main window and to `renderer/pill-preload-channels.ts`. Add `voiceApi.resolveProvider = () => invoke<VoiceProviderResolution>("voice:resolveProvider")`.
  - **Renderer call sites.**
    - Composer and pill call `voiceApi.resolveProvider()` at mic press, not from render-time settings.
    - Use the resolved `provider`, plus `modelId` for local.
    - `shouldUseGeminiLiveTranscription(resolution.provider, settings.voiceModel)`.
    - `transcriptionBudgetMs(resolution.provider, …)` (Task 8 extends the signature).
  - **`voice-settings.tsx`.** The provider select gets an "Automatic" option whose value is `""` and maps to `voiceProvider: undefined`. Use the existing settings patch semantics; if `settings:set` can't clear a key, send `voiceProvider: null` and make the parser treat `null` as delete. Add a caption under the select when automatic is active: `Automatic — using ${label}`, where label is "On-device (<model name>)", "OpenAI" or "Gemini", or the setup message.
  - **Remove auto-activation** in `model-manager-view.tsx`. A download no longer writes `voiceProvider` or `localVoiceModel`.
  - **OpenAI.** In `transcribeOpenAI`, append `language` when `normalizeLanguageIntent(settings.voiceLanguage)` exists and isn't `"auto"` (use its base code).
  - **Gemini Live.** `languageCodes: lang && lang !== "auto" ? [lang] : []`.
  - **Gemini batch.** Check the Interactions `transcription_config` docs (context7 or ai.google.dev). If a language field exists, pass it. Otherwise add nothing, and record the finding in `## Progress`.
  - **Opus.**
    1. `npm install --save-exact ogg-opus-decoder@1.7.5`.
    2. `main/services/local-speech-opus.ts` exports `decodeOggOpusToPcm16k(bytes: Uint8Array): Promise<Float32Array>`.
    3. It creates `new OggOpusDecoder()`, `await decoder.ready`, then `decodeFile(bytes)` → `{ channelData, sampleRate }`. It downmixes by averaging channels, resamples to 16 kHz with sherpa's `LinearResampler` (`new sherpa.LinearResampler(sampleRate, 16000)` → `resample(samples, true)`), and calls `decoder.free()`.
    4. Measure the packaged size delta after `npm run dist:dir` (or the repo's unpacked-build script) and record it in `.memory/packaging-size.md`.
    5. If the delta is over 5 MB, swap to `opus-decoder` + `codec-parser` with the same function signature.
    6. Use it in `local-speech-worker-core.ts` for `audio.kind === "ogg-opus"`.
  - **`transcribe()` router** (`transcription.ts`):

```ts
export async function transcribe(input: TranscribeInput): Promise<string> {
  const resolution = await resolveVoiceProviderNow();
  if (resolution.kind === "needs-setup") throw new Error(voiceSetupMessage(resolution.reason));
  if (resolution.provider === "local") {
    if (!/^audio\/(ogg|opus)\b/i.test(input.mimeType)) throw new Error("This audio format needs a cloud voice provider.");
    return transcribeLocalOggOpus(Buffer.from(input.audioBase64, "base64"), resolution.modelId, input.signal);
  }
  return resolution.provider === "gemini" ? transcribeGemini(input) : transcribeOpenAI(input);
}
```

  The renderer's batch path (`voice:transcribe`) only sends cloud work, because local goes through `voice:transcribeLocal`. The `phase2.ts` handler therefore keeps calling the cloud functions directly. Change it to call an exported `transcribeCloud(input, provider)` so it never re-resolves to local with a WebM blob.

- [ ] **Step 4: Run tests.** Run `npm run test:voice` (register the new files), `npx tsx --test main/services/telegram/*.test.ts`, `npm run type-check`, and `npx vite build`.

- [ ] **Step 5: Commit** with `git commit -m "Local-first voice provider resolution and Telegram on-device voice notes"`.

---

### Task 8: Model state, slow-load notice, no-model guard and scaled budgets

**Files:**
- Modify:
  - `main/services/local-speech.ts` (broadcast `localVoice:state`)
  - `main/handlers/local-voice.ts`
  - `renderer/lib/ipc-voice.ts` (`onState`)
  - `renderer/pill-preload-channels.ts` (allow the `localVoice:state` notification)
  - `renderer/lib/dictation-operation-gate.ts`
  - `main/services/dictation-coordinator.ts` (+ test)
  - `main/services/dictation.ts`
  - `renderer/pill/pill-app.tsx` (+ test)
  - `renderer/lib/use-voice-recorder.ts`
  - `renderer/components/composer.tsx`
- Create: `renderer/lib/slow-model-load.ts` and `renderer/lib/slow-model-load.test.ts`

**Interfaces:**
- Consumes: `onLocalSpeechState` and `LocalSpeechState` (Task 6); `resolveVoiceProviderNow` and `voiceSetupMessage` (Task 7).
- Produces:

```ts
// renderer/lib/slow-model-load.ts
export const SLOW_MODEL_LOAD_MS = 2000;
export class SlowModelLoadNotice {
  constructor(deps: { setTimer(cb: () => void, ms: number): unknown; clearTimer(t: unknown): void; onShow(): void });
  /** Feed every localVoice:state event for the active model while waiting for a result. */
  observe(state: "loading" | "ready" | "failed" | "unloaded"): void;
  /** Result arrived or operation ended. */
  dispose(): void;
  get shown(): boolean;
}
// renderer/lib/dictation-operation-gate.ts
export function transcriptionBudgetMs(provider: string, audioSeconds?: number): number; // local: max(125_000, 20_000*s + 15_000)
// DictationCoordinatorDeps gains:
resolveVoice?: () => Promise<{ ok: true } | { ok: false; message: string }>;
```

- [ ] **Step 1: Write the failing tests.**

```ts
// renderer/lib/slow-model-load.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SlowModelLoadNotice } from "./slow-model-load.js";

function clock() {
  let now = 0; const timers: Array<{ at: number; cb: () => void; dead?: boolean }> = [];
  return {
    deps: (onShow: () => void) => ({ setTimer: (cb: () => void, ms: number) => { const t = { at: now + ms, cb }; timers.push(t); return t; }, clearTimer: (t: unknown) => { (t as { dead: boolean }).dead = true; }, onShow }),
    advance(ms: number) { now += ms; for (const t of timers) if (!t.dead && t.at <= now) { t.dead = true; t.cb(); } },
  };
}

test("a warm load never shows the notice", () => {
  const c = clock(); let shown = 0;
  const n = new SlowModelLoadNotice(c.deps(() => { shown += 1; }));
  n.observe("loading"); c.advance(1500); n.observe("ready"); c.advance(5000);
  assert.equal(shown, 0);
});

test("a slow load shows once after 2 s and an idle 'unloaded' does not end it", () => {
  const c = clock(); let shown = 0;
  const n = new SlowModelLoadNotice(c.deps(() => { shown += 1; }));
  n.observe("loading"); c.advance(1000); n.observe("unloaded"); c.advance(1500);
  assert.equal(shown, 1); assert.equal(n.shown, true);
  n.observe("loading"); c.advance(3000);
  assert.equal(shown, 1);
});

test("failure ends the wait without showing", () => {
  const c = clock(); let shown = 0;
  const n = new SlowModelLoadNotice(c.deps(() => { shown += 1; }));
  n.observe("loading"); n.observe("failed"); c.advance(5000);
  assert.equal(shown, 0);
});
```

Extend `renderer/lib/dictation-operation-gate.test.ts` (create it if it's absent, and register it):

```ts
assert.equal(transcriptionBudgetMs("local"), 125_000);
assert.equal(transcriptionBudgetMs("local", 600), 12_015_000);
assert.equal(transcriptionBudgetMs("openai", 600), 45_000);
```

Extend `main/services/dictation-coordinator.test.ts` using its existing harness:

```ts
test("needs-setup never starts recording and shows the setup message", async () => {
  // harness with resolveVoice: async () => ({ ok: false, message: "Download a voice model in Settings → Voice." })
  // press() → expect: showPill called once; broadcasts contain { state: "error", message: "Download a voice model in Settings → Voice." };
  // no broadcast with state "recording"; warmUp not called; stage returns to idle so a later press works.
});
```

Write it concretely, following the harness pattern already in that file.

Extend the pill test (`renderer/pill/*.test.tsx`, which mounts the pill with mocked `window.aidenAPI`):
- With a resolution of `needs-setup`, `navigator.mediaDevices.getUserMedia` is never called.
- With a local resolution and state events `loading` followed by 2.1 s of fake time, "Loading model…" text renders.

- [ ] **Step 2: Run tests to verify they fail.**

- [ ] **Step 3: Implement.**
  - **`SlowModelLoadNotice`.**
    - `loading` (while not yet loading and not shown) arms a 2 s timer.
    - `ready` or `failed` clears the timer and ends the loading state.
    - `unloaded` is ignored.
    - When the timer fires, it sets `shown` and calls `onShow` once. Once shown, it stays latched until `dispose`.
  - **Main.** `local-speech.ts` exposes the `onLocalSpeechState` listeners. `main/handlers/local-voice.ts` subscribes and calls `ipcMain.broadcast("localVoice:state", state)`. `voiceApi.onState(handler)` wraps `onNotification("localVoice:state", handler)`.
  - **Pill and composer.**
    - After stop, while awaiting a local result, create a notice, feed it `onState` events for the resolved `modelId`, and on show set the phase copy to "Loading model…". It uses the existing phase text slot and adds no new layout.
    - Dispose it on result, error or cancel.
    - Composer: `use-voice-recorder.ts` exposes `loadingModel: boolean`, and `composer.tsx` shows "Loading model…" in its existing voice status text.
  - **Coordinator.**
    - In `press()` from idle, *before* `startWarmUp()` and before broadcasting `recording`, `await this.deps.resolveVoice?.()`.
    - If it isn't ok: `const created = await this.deps.showPill()` (to have a surface), then `broadcastError(this.operationId, message)`, then set `stage = "idle"` and `operationId = null`, and return.
    - `dictation.ts` wires `resolveVoice` with `resolveVoiceProviderNow()`, mapped through `voiceSetupMessage`.
    - Warm-up happens only when the resolution is local: pass `warmUp: () => resolution.provider === "local" ? warmLocalVoice(resolution.modelId) : undefined`, using the resolution captured on press.
  - **Composer mic press.** Call `voiceApi.resolveProvider()` first. On needs-setup, set the existing voice error to `voiceSetupMessage(reason)` and never call `getUserMedia`.
  - **Budgets.**
    - `transcriptionBudgetMs(provider, audioSeconds?)` = local ? `Math.max(125_000, 20_000 * (audioSeconds ?? 0) + 15_000)` : 45_000.
    - Callers pass the duration measured from recording start to stop.
    - The coordinator watchdog (`dictation-coordinator.ts` about line 60, 135 s) becomes `max(135_000, budget + 10_000)`. The pill reports the duration in its `stopping` → `transcribing` hand-off; add an optional `audioSeconds` to `dictation:progress` if the coordinator needs it. Otherwise re-arm the watchdog when the pill reports `finalizing`.

- [ ] **Step 4: Run tests.** Run `npm run test:voice`, `npx tsx --test main/services/dictation-coordinator.test.ts renderer/lib/slow-model-load.test.ts`, `npm run type-check`, and `npx vite build`. Register the new files.

- [ ] **Step 5: Commit** with `git commit -m "Slow model-load notice, no-model guard and audio-scaled budgets"`.

---

### Task 9: Settings → Voice UI (Aiden design system)

**Files:**
- Modify:
  - `renderer/components/settings/model-manager-view.tsx`
  - `renderer/components/settings/voice-settings.tsx`
  - `renderer/components/settings/local-voice-settings.tsx`
  - `renderer/lib/ipc*.ts` (model list type gains the new fields)
- Create or extend: `renderer/components/settings/model-manager-view.test.tsx` and `renderer/components/settings/voice-settings.test.tsx`

**Before coding:** read `docs/settings-design-system.md`, `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html`. Look at how existing settings rows (switch rows, select rows, captions) are composed in `local-voice-settings.tsx` and `dictation-shortcut-settings.tsx`, and reuse those primitives exactly. No new colors, no borders on cards, and no new button geometry.

**Interfaces:**
- Consumes: `LocalModel` with `languages`, `capabilities` and `license` (Task 2); `effectiveLanguage` (Task 3); `voiceApi.resolveProvider` (Task 7); download `phase: "verify"`.

- [ ] **Step 1: Write the failing render tests.** Use Testing Library with mocked APIs, following existing settings tests (for example `dictation-dictionary-settings.test.tsx`).
  - **Model manager:**
    - The SenseVoice row shows "Chinese, Cantonese, English, Japanese, Korean".
    - The Canary row shows the "Translate" capability label.
    - The Parakeet v3 row shows "Auto-detect".
    - Every row shows a licence line, and SenseVoice includes "SenseVoice Small, Alibaba FunAudioLLM".
    - A download state with `phase: "verify"` renders "Verifying…".
    - Sizes render "487 MB" for v3.
  - **Voice settings:**
    - With no explicit provider and a resolution of local Parakeet v3, the provider select shows "Automatic" and the caption "Automatic — using On-device (Parakeet TDT 0.6B v3)".
    - With the active local model Parakeet v2 and `voiceLanguage: "de"`, the caption reads "Parakeet TDT 0.6B v2 doesn't support German. Using English."
    - The "Translate to English" switch is present only when the active local model is `canary-180m-flash`.
    - Toggling it calls `settingsApi.set({ voiceTranslateToEnglish: true })`.
    - The "Trim silence" switch defaults on and toggling it calls `settingsApi.set({ voiceTrimSilence: false })`.
    - The language select lists "Automatic" followed by the active model's languages by display name. Use `Intl.DisplayNames(["en"], { type: "language" })` for names, falling back to the code.

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implement.**
  - **Model rows.**
    - Under the description, add a secondary-text line: `{languagesLabel} · {sizeLabel}`.
    - Add capability chips using the existing neutral badge/chip primitive (the same one as the Recommended badge, in its neutral variant) for "Auto-detect" and "Translate".
    - Add a tertiary licence line: `License: {license.name}` plus ` — {attribution}` when present.
  - **Verify phase.** The progress label uses "Downloading…", "Verifying…" and "Installing…".
  - **Voice settings section.** Use the same grouped-card layout, with rows in this order:
    1. Provider (select; options Automatic, On-device, OpenAI, Gemini; caption with the resolution)
    2. Language (select; caption with the fallback notice when `effectiveLanguage(...).fallback` is non-null)
    3. Translate to English (switch, conditional)
    4. existing cloud-model rows
  - **On-Device Engine section** (`local-voice-settings.tsx`): add "Trim silence" (switch, caption "Skips silence and splits long recordings so every model can transcribe them.") next to the existing idle-unload row.
  - **Language options.**
    - With on-device active: the active model's `languages`.
    - With cloud: `["en","es","fr","de","it","pt","nl","ja","ko","zh","hi","ar","ru","pl","tr","uk","sv"]`.
    - Always preceded by Automatic.
  - **Accessibility.** Every select and switch has a visible label tied to it through the shared row primitive, and keeps the focus-visible ring.

- [ ] **Step 4: Run tests and do visual acceptance.**
  - Run the two test files, `npm run test:voice` and `npx vite build`.
  - Launch the app (`npm run dev`, or the repo's `run` skill) and open Settings → Voice in light and dark themes.
  - Screenshot both, check them against the inspiration docs, and fix spacing that drifts from neighboring rows.
  - Run the Playwright `tests/e2e/settings-model-picker.spec.ts` voice checks and update selectors that depended on the removed auto-activation.

- [ ] **Step 5: Commit** with `git commit -m "Settings → Voice: model capabilities, language, translate and trim silence"`.

---

### Task 10: Remote, native clients, CLI, packaging verification, smoke test and docs

**Files:**
- Modify:
  - `main/services/aiden-remote-speech-core.ts` (pass the additive fields through; transcription uses `voiceLanguage`, translate and trim through `transcribeLocalPcm16`)
  - `main/services/aiden-remote-speech.test.ts`
  - `ios/AidenOnTheGoTests/AidenRemoteClientTests.swift`
  - `android/app/src/test/java/sbtbiswas/AidenOnTheGo/networking/AidenRemoteClientTest.kt` (path from `find android -name AidenRemoteClientTest.kt`)
  - `packages/cli/src/speech.ts`
  - `.memory/dictation-parakeet-modes.md` (pointer)
  - new `.memory/stt-engine-foundation.md`
  - `docs/plans/README.md`
  - `package.json` (`test:stt-smoke` script, not part of `test`)
- Create: `scripts/stt-smoke.test.ts`

- [ ] **Step 1: Remote test.**
  - Extend `aiden-remote-speech.test.ts`: `status()` lists all six catalog ids in catalog order. Each model includes `languages`, `capabilities` and `license`. `sizeLabel` for v3 is `"487 MB"`. A download state with `phase: "verify"` passes through.
  - Run `npm run test:aiden-remote-speech`.

- [ ] **Step 2: Native decode tests.** Add one test per client that decodes a `/speech` JSON fixture containing all the additive fields and six models, and asserts `models.count == 6` and the `phase` string `"verify"` round-trips.
  - **iOS:** `xcodebuild test -scheme AidenOnTheGo -only-testing:AidenOnTheGoTests/AidenRemoteClientTests -destination 'platform=iOS Simulator,name=iPhone 17'`. Pick an available simulator with `xcrun simctl list devices available`.
  - **Android:** `cd android && ./gradlew testDebugUnitTest --tests '*AidenRemoteClientTest*'`.
  - Then inspect `AidenWorkspaceShellView.swift` (iOS) and `AidenVoiceSettingsScreen.kt` (Android) to confirm the model list scrolls and doesn't truncate six rows. Note any change needed. If a layout fix is required, make it minimal and in the native client's own design language.

- [ ] **Step 3: Write the CLI smoke test** `scripts/stt-smoke.test.ts`. It is opt-in and never runs in CI.
  - Skip unless `process.env.AIDEN_STT_SMOKE === "1"` and `process.platform === "darwin"`.
  - For each catalog model:
    1. Download into a temp root with `createSpeechModelManager`.
    2. Generate `say -v Samantha -o /tmp/smoke.aiff "The quick brown fox jumps over the lazy dog"`, then `afconvert -f WAVE -d LEI16@16000 -c 1`.
    3. Read the PCM, run `speechEngine.transcribe` with the bundled VAD, and assert the lowercase text includes "quick" and "fox".
    4. Also run a 10 s all-zero clip and assert `""`.
    5. Log `decodeMs` and peak `process.memoryUsage().rss`.
  - For SenseVoice (no English-only guarantee), assert only that the text is non-empty.
  - Add `"test:stt-smoke": "AIDEN_STT_SMOKE=1 tsx --test scripts/stt-smoke.test.ts"`.

  Run it once, with the owner's machine and network:

```bash
npm run test:stt-smoke 2>&1 | tee /tmp/stt-smoke.log
```

  Paste the per-model timing/RSS table into the PR description. If Moonshine fails to load (ORT format), remove it from `SPEECH_MODELS` per spec risk §, and record why in the spec and in `## Progress`.

- [ ] **Step 4: Packaging.** Run `npm run build` and the repo's unpacked macOS package command (see `scripts/verify-macos-package.mjs` usage in `package.json`). Then run `node scripts/verify-macos-package.mjs <app>`. Expected: the worker entry `local-speech-worker.js` is found and `Resources/speech/silero_vad.onnx` exists. In `packages/cli`, run `npm run build && npm test`; expected: `dist/app/speech/silero_vad.onnx` is present.

- [ ] **Step 5: Docs and memory.**
  - Write `.memory/stt-engine-foundation.md`: what shipped, the module map, decisions (single slot, VAD values, delete-not-migrate, Automatic provider), verification results, deferred items, and the Handy reference commit `f6b3f82` with the file paths studied (spec "Licensing and attribution").
  - Add a one-line pointer at the top of `.memory/dictation-parakeet-modes.md` saying the parakeet modules were renamed to `local-speech*`.
  - Update the `docs/plans/README.md` row status to "Implemented on PR #<n>".

- [ ] **Step 6: Full local gate.** Run `npm run test:voice && npm run test:aiden-remote-speech && npm run type-check && npx eslint main/services/local-speech* renderer/shared/voice-* renderer/components/settings/*voice* renderer/components/settings/model-manager-view.tsx && npx vite build && (cd packages/cli && npm run build && npm test)`. Also run the serial/preflight lanes that include the dictation files: `npm run test:serial` (or the narrower scripts that list `dictation-*` tests). Expected: all pass.

- [ ] **Step 7: Commit** with `git commit -m "Remote/native/CLI parity, packaging checks and docs for speech engine foundation"`.

---

## Progress

(Executors append dated facts here: computed digests, Electron structured-clone result, Gemini batch language finding, Opus package delta, smoke-run table.)

- whisper-turbo sha256 computed 2026-10-09: b11acbbcd660b44a8e0df33724feb5aaa709cf65668f2823d59f656312544f22 (563790207 bytes; archive contains sherpa-onnx-whisper-turbo/turbo-encoder.int8.onnx, turbo-decoder.int8.onnx, turbo-tokens.txt)
