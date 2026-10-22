#!/usr/bin/env node
// Aiden voice engine spike: sherpa-onnx (the engine Aiden ships) against
// transcribe.cpp (ggml, Metal), offline and streaming, on the same clips.
//
//   npm install && node bench.mjs                 # everything this machine can run
//   node bench.mjs --only sherpa-v3-cpu2,tcpp-v3-metal --runs 3
//   node bench.mjs --list                         # configs and what they download
//
// Each config runs in its own Node process so load time and memory are not
// shared. Models are downloaded once into --cache (default ~/.cache/aiden-voice-spike),
// pinned by exact size and SHA-256. Results go to ./results/<time>.{json,md}.
import { Buffer } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import console from "node:console";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SAMPLE_RATE = 16_000;
// The pill's PCM worklet posts 100 ms chunks, so streaming engines are fed the same.
const CHUNK_SAMPLES = SAMPLE_RATE / 10;
const REDECODE_EVERY_SAMPLES = SAMPLE_RATE / 2;
const IS_MAC = process.platform === "darwin";

// ---------------------------------------------------------------- downloads

const hf = (repo, revision, file) => `https://huggingface.co/${repo}/resolve/${revision}/${file}`;
const NEMOTRON_EN = ["csukuangfj2/sherpa-onnx-nemotron-speech-streaming-en-0.6b-160ms-int8-2026-04-25", "237e551abd7a411ef92d3595454d9f6ab5fe7d6c"];
const NEMOTRON_35 = ["csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-160ms-int8-2026-06-11", "b3a4dbde84fba1a13cb4270e6730b525ac6a2db6"];

/** Every file the spike may fetch: group → role → {url, bytes, sha256}. */
const DOWNLOADS = {
  // Same GGUFs Handy's catalog pins (handy/src-tauri/src/catalog/catalog.json).
  "tcpp-parakeet-v3": {
    model: { file: "parakeet-tdt-0.6b-v3-Q8_0.gguf", url: hf("handy-computer/parakeet-tdt-0.6b-v3-gguf", "85ac09ea12fc4b1112fa76810059364bc6adc9de", "parakeet-tdt-0.6b-v3-Q8_0.gguf"), bytes: 739_508_576, sha256: "5859f77944efcd8eafa23a6350731960b2b55b2203df51f319665c807d802cc7" },
  },
  "tcpp-parakeet-unified-en": {
    model: { file: "parakeet-unified-en-0.6b-Q8_0.gguf", url: hf("handy-computer/parakeet-unified-en-0.6b-gguf", "7e948f21b7bdbac698d3318db9d350f1096f3b6c", "parakeet-unified-en-0.6b-Q8_0.gguf"), bytes: 731_357_568, sha256: "4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795" },
  },
  "tcpp-nemotron-3.5": {
    model: { file: "nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf", url: hf("handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf", "6d44e540bc31b0de1dbe174a3cea87f53a7f22fb", "nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf"), bytes: 751_094_240, sha256: "b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c" },
  },
  "sherpa-nemotron-en": {
    encoder: { file: "nemotron-en/encoder.int8.onnx", url: hf(...NEMOTRON_EN, "encoder.int8.onnx"), bytes: 652_916_849, sha256: "71111f61b18e1e65e01e369434a5c0434868d2f44892742ae54240600c681209" },
    decoder: { file: "nemotron-en/decoder.int8.onnx", url: hf(...NEMOTRON_EN, "decoder.int8.onnx"), bytes: 7_257_753, sha256: "0be9702c2f427a2b6bb241d298e0d3836a558de1f5b9fd3018f1cce6e2b3fa98" },
    joiner: { file: "nemotron-en/joiner.int8.onnx", url: hf(...NEMOTRON_EN, "joiner.int8.onnx"), bytes: 1_735_862, sha256: "a35eac38a22ebceb04d230ed7afe0d68f446ba6914a036b97f14fece95967e23" },
    tokens: { file: "nemotron-en/tokens.txt", url: hf(...NEMOTRON_EN, "tokens.txt"), bytes: 8_952, sha256: "dc0b4584ab2e4ddbf888425c076c61b736e7356a015250db7d307e6f1a8188ff" },
  },
  "sherpa-nemotron-3.5": {
    encoder: { file: "nemotron-3.5/encoder.int8.onnx", url: hf(...NEMOTRON_35, "encoder.int8.onnx"), bytes: 657_601_518, sha256: "e1b39e5e16bef578a54ed2fba5f031438e000cc36c3ea2ca49d55699d5baebd4" },
    decoder: { file: "nemotron-3.5/decoder.int8.onnx", url: hf(...NEMOTRON_35, "decoder.int8.onnx"), bytes: 14_978_075, sha256: "19f9c98fc6d0a2c33a65a43b36fdb2e914c26c0aa9764be3aebc502a1e982fb0" },
    joiner: { file: "nemotron-3.5/joiner.int8.onnx", url: hf(...NEMOTRON_35, "joiner.int8.onnx"), bytes: 9_504_438, sha256: "4101c7c679a0bc30483794b27a059e34e79232aa2068d78d51231a22c8b0d7ce" },
    tokens: { file: "nemotron-3.5/tokens.txt", url: hf(...NEMOTRON_35, "tokens.txt"), bytes: 131_440, sha256: "729cc103155bafa785f9cd45746cd41cabe97eab7182fc04d594129587958f8a" },
  },
  // Real read speech (LibriSpeech) with reference transcripts.
  clips: {
    "ls-0": { file: "clips/ls-0.wav", url: hf(...NEMOTRON_EN, "test_wavs/0.wav"), bytes: 212_044, sha256: "6bc58a4efdf20daac252b6b1502632601a71efe0308f6757dc1eda34891a7e4f" },
    "ls-1": { file: "clips/ls-1.wav", url: hf(...NEMOTRON_EN, "test_wavs/1.wav"), bytes: 534_924, sha256: "5143a6ba93c4b274e2c4ac22deb75c2c48936c853f0519add1de828b6c79cc5a" },
  },
};

const LIBRISPEECH_REFERENCE = {
  "ls-0": "AFTER EARLY NIGHTFALL THE YELLOW LAMPS WOULD LIGHT UP HERE AND THERE THE SQUALID QUARTER OF THE BROTHELS",
  "ls-1": "GOD AS A DIRECT CONSEQUENCE OF THE SIN WHICH MAN THUS PUNISHED HAD GIVEN HER A LOVELY CHILD WHOSE PLACE WAS ON THAT SAME DISHONOURED BOSOM TO CONNECT HER PARENT FOR EVER WITH THE RACE AND DESCENT OF MORTALS AND TO BE FINALLY A BLESSED SOUL IN HEAVEN",
};

// Dictation-style phrases, spoken by macOS `say` at about 3, 10 and 30 seconds.
const TTS_CLIPS = {
  "tts-3s": "Please send the updated design files to the team before lunch.",
  "tts-10s": "I looked at the onboarding flow again this morning, and the second screen still asks for too much. Can we move the provider choice later and keep the welcome short?",
  "tts-30s": "Here is where we landed after the review. The sidebar keeps its current order, but pinned chats move to the top and archived chats leave the list entirely. Search should cover titles and message text, and it needs to stay fast on large workspaces. For the settings page, group the voice options under one card, explain what loading the model in advance costs in memory, and let people turn it off. We will check the timing log on a real machine before deciding on the next engine.",
};

// Aiden's catalog archive, used only when the app's installed copy is missing.
const SHERPA_PARAKEET_V3_ARCHIVE = { url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2", bytes: 487_170_055, sha256: "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf" };

// ------------------------------------------------------------------ configs

/**
 * mode "offline": one decode per clip after release (what Aiden does today).
 * mode "stream": 100 ms chunks while the user speaks, then finalize on release.
 * mode "redecode": live preview from an offline model by decoding everything heard so far
 * every 500 ms, then once more on release.
 */
const CONFIGS = [
  { id: "sherpa-v3-cpu2", note: "Aiden today", engine: "sherpa", group: "sherpa-parakeet-v3", modes: ["offline"], threads: 2, provider: "cpu" },
  { id: "sherpa-v3-cpu4", engine: "sherpa", group: "sherpa-parakeet-v3", modes: ["offline", "redecode"], threads: 4, provider: "cpu" },
  { id: "sherpa-v3-coreml", engine: "sherpa", group: "sherpa-parakeet-v3", modes: ["offline"], threads: 2, provider: "coreml", macOnly: true },
  { id: "tcpp-v3-metal", engine: "tcpp", group: "tcpp-parakeet-v3", modes: ["offline", "redecode"], backend: "metal", macOnly: true },
  { id: "tcpp-v3-cpu4", engine: "tcpp", group: "tcpp-parakeet-v3", modes: ["offline", "redecode"], backend: "cpu", threads: 4 },
  { id: "tcpp-unified-en-metal", note: "English", engine: "tcpp", group: "tcpp-parakeet-unified-en", modes: ["offline", "stream"], backend: "metal", macOnly: true },
  { id: "tcpp-nemotron35-metal", note: "multilingual", engine: "tcpp", group: "tcpp-nemotron-3.5", modes: ["stream"], backend: "metal", macOnly: true },
  { id: "sherpa-nemotron-en-cpu4", note: "English", engine: "sherpa", group: "sherpa-nemotron-en", modes: ["stream"], threads: 4, provider: "cpu" },
  { id: "sherpa-nemotron35-cpu4", note: "multilingual", engine: "sherpa", group: "sherpa-nemotron-3.5", modes: ["stream"], threads: 4, provider: "cpu" },
];

// -------------------------------------------------------------------- audio

/** 16-bit or float WAV → 16 kHz mono Float32Array (downmixed, linearly resampled). */
function readWav(file) {
  const buf = readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${file} is not a WAV file.`);
  let fmt = null;
  let data = null;
  for (let offset = 12; offset + 8 <= buf.length; ) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    else if (id === "data") data = buf.subarray(body, Math.min(buf.length, body + size));
    offset = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${file} has no fmt or data chunk.`);
  const float = fmt.format === 3 || (fmt.format === 0xfffe && fmt.bits === 32);
  if (!float && fmt.bits !== 16) throw new Error(`${file}: only 16-bit PCM or 32-bit float WAV is supported (convert with afconvert -f WAVE -d LEI16@16000 -c 1).`);
  const bytesPerSample = fmt.bits / 8;
  const frames = Math.floor(data.length / (bytesPerSample * fmt.channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const at = (i * fmt.channels + c) * bytesPerSample;
      sum += float ? data.readFloatLE(at) : data.readInt16LE(at) / 32768;
    }
    mono[i] = sum / fmt.channels;
  }
  if (fmt.rate === SAMPLE_RATE) return mono;
  const out = new Float32Array(Math.floor((frames * SAMPLE_RATE) / fmt.rate));
  const step = fmt.rate / SAMPLE_RATE;
  for (let i = 0; i < out.length; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const next = mono[Math.min(j + 1, frames - 1)];
    out[i] = mono[j] + (next - mono[j]) * (x - j);
  }
  return out;
}

function words(text) {
  return text.toLowerCase().normalize("NFKC").replace(/['’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
}

/** Word error rate: word-level edit distance over the reference length. */
export function wordErrorRate(reference, hypothesis) {
  const ref = words(reference);
  const hyp = words(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const row = [i];
    for (let j = 1; j <= hyp.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[hyp.length] / ref.length;
}

// -------------------------------------------------------------------- stats

const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x, digits = 0) => (x == null || Number.isNaN(x) ? null : Number(x.toFixed(digits)));
const mb = (bytes) => round(bytes / 1024 / 1024);

function memory() {
  const usage = process.memoryUsage();
  const result = { rssMb: mb(usage.rss), maxRssMb: mb(process.resourceUsage().maxRSS * 1024) };
  if (IS_MAC) {
    // RSS can miss Metal buffers; the physical footprint includes them.
    try {
      const out = execFileSync("footprint", [String(process.pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 });
      const match = out.match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/i);
      if (match) result.footprintMb = round(Number(match[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[match[2].toUpperCase()]);
    } catch {
      // footprint is optional.
    }
  }
  return result;
}

// -------------------------------------------------------------- measurement

async function measureOffline(clip, decode, runs) {
  let started = performance.now();
  let text = await decode(clip.samples);
  const firstMs = performance.now() - started;
  const times = [];
  for (let r = 0; r < runs; r++) {
    started = performance.now();
    text = await decode(clip.samples);
    times.push(performance.now() - started);
  }
  return { clip: clip.id, audioMs: round(clip.samples.length / 16), firstMs: round(firstMs), p50Ms: round(median(times)), minMs: round(Math.min(...times)), wer: clip.reference ? round(wordErrorRate(clip.reference, text), 3) : null, text };
}

/**
 * Feeds 100 ms chunks as fast as the engine takes them. `feedMs` per chunk must stay
 * under 100 ms to keep up with a live microphone; `finalizeMs` is release-to-text.
 */
async function measureStream(clip, open) {
  const stream = await open();
  const feedMs = [];
  let firstWordAudioMs = null;
  let firstCommitAudioMs = null;
  let wordsAtRelease = 0;
  for (let at = 0; at < clip.samples.length; at += CHUNK_SAMPLES) {
    // A copy: transcribe.cpp borrows the buffer until the feed resolves.
    const chunk = clip.samples.slice(at, at + CHUNK_SAMPLES);
    const started = performance.now();
    const { committed, tentative } = await stream.feed(chunk);
    feedMs.push(performance.now() - started);
    const audioMs = Math.min(clip.samples.length, at + CHUNK_SAMPLES) / 16;
    if (firstWordAudioMs === null && `${committed} ${tentative}`.trim()) firstWordAudioMs = audioMs;
    if (firstCommitAudioMs === null && committed.trim()) firstCommitAudioMs = audioMs;
    wordsAtRelease = words(`${committed} ${tentative}`).length;
  }
  const started = performance.now();
  const text = await stream.finish();
  const finalizeMs = performance.now() - started;
  const audioMs = clip.samples.length / 16;
  const finalWords = words(text).length;
  return {
    clip: clip.id,
    audioMs: round(audioMs),
    updateEveryMs: CHUNK_SAMPLES / 16,
    updateP50Ms: round(median(feedMs), 1),
    updateMaxMs: round(Math.max(...feedMs), 1),
    busyPct: round((100 * feedMs.reduce((a, b) => a + b, 0)) / audioMs),
    firstWordAudioMs: round(firstWordAudioMs),
    firstCommitAudioMs: round(firstCommitAudioMs),
    shownAtReleasePct: finalWords ? round((100 * Math.min(wordsAtRelease, finalWords)) / finalWords) : null,
    finalizeMs: round(finalizeMs),
    wer: clip.reference ? round(wordErrorRate(clip.reference, text), 3) : null,
    text,
  };
}

/** Live preview without a streaming model: re-decode the whole recording every 500 ms. */
async function measureRedecode(clip, decode) {
  const updateMs = [];
  let firstWordAudioMs = null;
  for (let end = REDECODE_EVERY_SAMPLES; end < clip.samples.length; end += REDECODE_EVERY_SAMPLES) {
    const started = performance.now();
    const text = await decode(clip.samples.subarray(0, end));
    updateMs.push(performance.now() - started);
    if (firstWordAudioMs === null && text.trim()) firstWordAudioMs = end / 16;
  }
  const started = performance.now();
  const text = await decode(clip.samples);
  const finalizeMs = performance.now() - started;
  const audioMs = clip.samples.length / 16;
  return {
    clip: clip.id,
    audioMs: round(audioMs),
    updateEveryMs: REDECODE_EVERY_SAMPLES / 16,
    updateP50Ms: round(median(updateMs), 1),
    updateMaxMs: round(Math.max(0, ...updateMs), 1),
    busyPct: round((100 * updateMs.reduce((a, b) => a + b, 0)) / audioMs),
    firstWordAudioMs: round(firstWordAudioMs),
    shownAtReleasePct: null,
    finalizeMs: round(finalizeMs),
    wer: clip.reference ? round(wordErrorRate(clip.reference, text), 3) : null,
    text,
  };
}

// ------------------------------------------------------------------ engines

async function openSherpa(config, files) {
  const sherpa = require("sherpa-onnx-node");
  const started = performance.now();
  const transducer = { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner };
  const info = { sherpaVersion: JSON.parse(readFileSync(path.join(HERE, "node_modules/sherpa-onnx-node/package.json"), "utf8")).version };
  if (config.modes.includes("offline")) {
    // Same config as main/services/local-speech-engine.ts buildRecognizerConfig.
    const recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: { transducer, modelType: "nemo_transducer", tokens: files.tokens, numThreads: config.threads, provider: config.provider, debug: 0 },
    });
    const loadMs = performance.now() - started;
    return {
      info,
      loadMs,
      offline: async (samples) => {
        const stream = recognizer.createStream();
        stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
        recognizer.decode(stream);
        return recognizer.getResult(stream).text;
      },
    };
  }
  const recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: { transducer, tokens: files.tokens, numThreads: config.threads, provider: config.provider, debug: 0 },
    decodingMethod: "greedy_search",
    enableEndpoint: 0,
  });
  const loadMs = performance.now() - started;
  const drain = (stream) => {
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    return recognizer.getResult(stream).text;
  };
  return {
    info,
    loadMs,
    stream: async () => {
      const stream = recognizer.createStream();
      return {
        // Greedy transducer output only grows, so all of it counts as committed.
        feed: async (chunk) => {
          stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: chunk });
          return { committed: drain(stream), tentative: "" };
        },
        finish: async () => {
          // sherpa's streaming examples pad the tail so the last chunk is decoded.
          stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: new Float32Array(SAMPLE_RATE * 0.66) });
          stream.inputFinished();
          return drain(stream);
        },
      };
    },
  };
}

async function openTranscribeCpp(config, files) {
  const tc = await import("transcribe-cpp");
  let started = performance.now();
  await tc.initialize();
  const initMs = performance.now() - started;
  started = performance.now();
  const model = await tc.TranscribeModel.load(files.model, { backend: config.backend });
  const modelMs = performance.now() - started;
  // The session builds the native context, so it counts towards being ready for audio, like sherpa's recognizer.
  const session = model.createSession(config.threads ? { nThreads: config.threads } : {});
  const loadMs = performance.now() - started;
  const caps = model.capabilities;
  const info = {
    transcribeCpp: tc.version(),
    backend: model.backend,
    device: model.device?.name ?? null,
    arch: model.arch,
    variant: model.variant,
    supportsStreaming: caps.supportsStreaming,
    initMs: round(initMs),
    modelMs: round(modelMs),
    sessionMs: round(loadMs - modelMs),
  };
  const openStream = async () => {
    const stream = await session.stream({ commitPolicy: "stable_prefix", timestamps: "none" });
    return {
      feed: async (chunk) => {
        await stream.feed(chunk);
        const { committed, tentative } = stream.text;
        return { committed, tentative };
      },
      finish: async () => {
        await stream.finalize();
        const text = stream.snapshot.text;
        stream.reset();
        return text;
      },
    };
  };
  return {
    info,
    loadMs,
    offline: async (samples) => (await session.run(samples, { timestamps: "none" })).text,
    stream: openStream,
  };
}

async function child(payload) {
  const { config, files, clips, runs } = payload;
  const loaded = clips.map((clip) => ({ ...clip, samples: readWav(clip.file) }));
  const before = memory();
  const engine = config.engine === "sherpa" ? await openSherpa(config, files) : await openTranscribeCpp(config, files);
  const result = { id: config.id, info: engine.info, loadMs: round(engine.loadMs), memoryBefore: before, memoryLoaded: memory(), modes: {} };
  for (const mode of config.modes) {
    const rows = [];
    try {
      if (mode === "offline") {
        for (const clip of loaded) rows.push(await measureOffline(clip, engine.offline, runs));
      } else if (mode === "redecode") {
        for (const clip of loaded) rows.push(await measureRedecode(clip, engine.offline));
      } else {
        // One unmeasured pass so the first measured clip does not pay one-time setup.
        await measureStream(loaded[0], engine.stream);
        for (const clip of loaded) rows.push(await measureStream(clip, engine.stream));
      }
      result.modes[mode] = rows;
    } catch (error) {
      result.modes[mode] = { error: error instanceof Error ? error.message : String(error), partial: rows };
    }
    process.stderr.write(`  ${config.id} ${mode} done\n`);
  }
  result.memoryAfter = memory();
  process.stdout.write(`@@RESULT ${JSON.stringify(result)}\n`);
}

// ------------------------------------------------------------------ parent

function parseArgs(argv) {
  const args = { runs: 5, cache: path.join(os.homedir(), ".cache", "aiden-voice-spike"), only: null, clips: null, sherpaModel: null, list: false, timeoutMin: 20 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = () => argv[++i];
    if (key === "--runs") args.runs = Number(value());
    else if (key === "--cache") args.cache = path.resolve(value());
    else if (key === "--only") args.only = value().split(",").map((s) => s.trim()).filter(Boolean);
    else if (key === "--clips") args.clips = path.resolve(value());
    else if (key === "--sherpa-model") args.sherpaModel = path.resolve(value());
    else if (key === "--timeout-min") args.timeoutMin = Number(value());
    else if (key === "--list") args.list = true;
    else throw new Error(`Unknown option ${key}`);
  }
  return args;
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Download `entry` to `dest` unless a verified copy is there; verify size and SHA-256. */
async function fetchPinned(entry, dest) {
  const marker = `${dest}.sha256`;
  if (existsSync(dest) && statSync(dest).size === entry.bytes && existsSync(marker) && readFileSync(marker, "utf8").trim() === entry.sha256) return;
  mkdirSync(path.dirname(dest), { recursive: true });
  if (existsSync(dest) && statSync(dest).size === entry.bytes && (await sha256File(dest)) === entry.sha256) {
    writeFileSync(marker, entry.sha256);
    return;
  }
  const part = `${dest}.part`;
  const response = await globalThis.fetch(entry.url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`${entry.url}: HTTP ${response.status}`);
  const hash = createHash("sha256");
  const out = createWriteStream(part);
  let bytes = 0;
  let shown = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    bytes += chunk.length;
    if (!out.write(chunk)) await once(out, "drain");
    if (bytes - shown > 50 * 1024 * 1024) {
      shown = bytes;
      process.stderr.write(`    ${path.basename(dest)} ${Math.round((100 * bytes) / entry.bytes)}%\n`);
    }
  }
  out.end();
  await once(out, "finish");
  const digest = hash.digest("hex");
  if (bytes !== entry.bytes || digest !== entry.sha256) {
    rmSync(part, { force: true });
    throw new Error(`${entry.url}: expected ${entry.bytes} bytes ${entry.sha256}, got ${bytes} bytes ${digest}.`);
  }
  renameSync(part, dest);
  writeFileSync(marker, entry.sha256);
}

const SHERPA_V3_FILES = { encoder: "encoder.int8.onnx", decoder: "decoder.int8.onnx", joiner: "joiner.int8.onnx", tokens: "tokens.txt" };

function aidenModelDir() {
  const userData = IS_MAC ? path.join(os.homedir(), "Library", "Application Support", "Aiden Agent") : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Aiden Agent");
  return path.join(userData, "voice-models", "parakeet-v3");
}

async function resolveGroup(group, args) {
  if (group === "sherpa-parakeet-v3") {
    const candidates = [args.sherpaModel, aidenModelDir(), path.join(args.cache, "parakeet-v3")].filter(Boolean);
    for (const dir of candidates) {
      if (Object.values(SHERPA_V3_FILES).every((file) => existsSync(path.join(dir, file)))) {
        return Object.fromEntries(Object.entries(SHERPA_V3_FILES).map(([role, file]) => [role, path.join(dir, file)]));
      }
    }
    const dir = path.join(args.cache, "parakeet-v3");
    const archive = path.join(args.cache, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2");
    process.stderr.write("  Aiden's Parakeet v3 is not installed here; downloading the same archive Aiden pins.\n");
    await fetchPinned(SHERPA_PARAKEET_V3_ARCHIVE, archive);
    mkdirSync(dir, { recursive: true });
    execFileSync("tar", ["-xjf", archive, "-C", dir, "--strip-components=1"], { stdio: "inherit" });
    return Object.fromEntries(Object.entries(SHERPA_V3_FILES).map(([role, file]) => [role, path.join(dir, file)]));
  }
  const entries = DOWNLOADS[group];
  const files = {};
  for (const [role, entry] of Object.entries(entries)) {
    const dest = path.join(args.cache, entry.file);
    await fetchPinned(entry, dest);
    files[role] = dest;
  }
  return files;
}

async function prepareClips(args) {
  const clips = [];
  const dir = path.join(args.cache, "clips");
  mkdirSync(dir, { recursive: true });
  if (IS_MAC) {
    for (const [id, text] of Object.entries(TTS_CLIPS)) {
      const file = path.join(dir, `${id}.wav`);
      if (!existsSync(file)) execFileSync("say", ["-r", "175", "-o", file, "--file-format=WAVE", "--data-format=LEI16@16000", text]);
      clips.push({ id, file, reference: text });
    }
  }
  for (const [id, entry] of Object.entries(DOWNLOADS.clips)) {
    const file = path.join(args.cache, entry.file);
    await fetchPinned(entry, file);
    clips.push({ id, file, reference: LIBRISPEECH_REFERENCE[id] });
  }
  if (args.clips) {
    for (const name of readdirSync(args.clips).filter((n) => n.toLowerCase().endsWith(".wav")).sort()) {
      const txt = path.join(args.clips, name.replace(/\.wav$/i, ".txt"));
      clips.push({ id: `own-${name.replace(/\.wav$/i, "")}`, file: path.join(args.clips, name), reference: existsSync(txt) ? readFileSync(txt, "utf8").trim() : null });
    }
  }
  return clips;
}

function systemInfo() {
  const info = { platform: process.platform, arch: process.arch, node: process.version, cpu: os.cpus()[0]?.model, logicalCores: os.cpus().length, memoryGb: round(os.totalmem() / 1024 ** 3, 1) };
  const sh = (cmd, cmdArgs) => {
    try {
      return execFileSync(cmd, cmdArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  if (IS_MAC) {
    info.macos = sh("sw_vers", ["-productVersion"]);
    info.chip = sh("sysctl", ["-n", "machdep.cpu.brand_string"]);
    info.performanceCores = Number(sh("sysctl", ["-n", "hw.perflevel0.physicalcpu"])) || null;
    info.power = sh("pmset", ["-g", "batt"])?.split("\n")[0] ?? null;
  }
  return info;
}

function runChild(payload, timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", Buffer.from(JSON.stringify(payload)).toString("base64")], { cwd: HERE, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    proc.stdout.on("data", (chunk) => {
      out += chunk;
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      const line = out.split("\n").find((l) => l.startsWith("@@RESULT "));
      if (line) resolve(JSON.parse(line.slice("@@RESULT ".length)));
      else resolve({ id: payload.config.id, error: `exited with ${signal ?? code} before reporting`, output: out.slice(-2000) });
    });
  });
}

const cell = (v, suffix = "") => (v == null ? "–" : `${v}${suffix}`);

function markdown(system, results, clips) {
  const lines = [`# Aiden voice engine spike`, "", `${new Date().toISOString()} · ${system.chip ?? system.cpu} · ${system.performanceCores ?? "?"} P-cores · ${system.memoryGb} GB · macOS ${system.macos ?? "n/a"} · Node ${system.node}`, ""];
  lines.push("## Load and memory", "", "Load ms is the time until the engine accepts audio: model plus session for transcribe.cpp, recognizer for sherpa. Footprint after run includes inference buffers.", "", "| Config | Backend | Init ms | Load ms | RSS after load MB | Footprint after load MB | Footprint after run MB | Peak RSS MB |", "|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    if (r.error) {
      lines.push(`| ${r.id} | failed: ${r.error.replace(/\|/g, "/").slice(0, 120)} | | | | | | |`);
      continue;
    }
    const backend = r.info.backend ?? (r.info.sherpaVersion ? `sherpa ${r.info.sherpaVersion}` : "?");
    lines.push(`| ${r.id} | ${backend}${r.info.device ? ` (${r.info.device})` : ""} | ${cell(r.info.initMs)} | ${r.loadMs} | ${r.memoryLoaded.rssMb} | ${cell(r.memoryLoaded.footprintMb)} | ${cell(r.memoryAfter.footprintMb)} | ${r.memoryAfter.maxRssMb} |`);
  }
  const ids = clips.map((c) => c.id);
  lines.push("", "## Offline: release-to-text decode (median ms, first decode after load in brackets)", "", `| Config | ${ids.join(" | ")} | mean WER |`, `|---|${ids.map(() => "---").join("|")}|---|`);
  for (const r of results) {
    const rows = r.modes?.offline;
    if (!Array.isArray(rows)) continue;
    const by = Object.fromEntries(rows.map((row) => [row.clip, row]));
    const wers = rows.map((row) => row.wer).filter((w) => w != null);
    lines.push(`| ${r.id} | ${ids.map((id) => (by[id] ? `${by[id].p50Ms} (${by[id].firstMs})` : "–")).join(" | ")} | ${wers.length ? round(wers.reduce((a, b) => a + b, 0) / wers.length, 3) : "–"} |`);
  }
  lines.push(
    "",
    "## Live text: words while speaking, then release-to-text",
    "",
    "stream = 100 ms chunks into a streaming model. redecode = an offline model re-reads everything heard so far every 500 ms. Update cost must stay under the update interval, and busy % under 100, to keep up with speech.",
    "",
    "| Config | Mode | Clip | Update every ms | Update cost p50 / max ms | Busy % | First word at (audio ms) | Shown at release | Finalize ms | WER |",
    "|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const r of results) {
    for (const mode of ["stream", "redecode"]) {
      const rows = r.modes?.[mode];
      if (!rows) continue;
      if (!Array.isArray(rows)) {
        lines.push(`| ${r.id} | ${mode} | failed: ${rows.error.replace(/\|/g, "/").slice(0, 120)} | | | | | | | |`);
        continue;
      }
      for (const row of rows) lines.push(`| ${r.id} | ${mode} | ${row.clip} | ${row.updateEveryMs} | ${row.updateP50Ms} / ${row.updateMaxMs} | ${row.busyPct} | ${cell(row.firstWordAudioMs)} | ${cell(row.shownAtReleasePct, "%")} | ${row.finalizeMs} | ${cell(row.wer)} |`);
    }
  }
  for (const r of results) {
    for (const [mode, rows] of Object.entries(r.modes ?? {})) {
      if (!Array.isArray(rows) && rows.error) lines.push("", `- ${r.id} ${mode} failed: ${rows.error}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--child") return child(JSON.parse(Buffer.from(argv[1], "base64").toString("utf8")));
  const args = parseArgs(argv);
  const configs = CONFIGS.filter((c) => (args.only ? args.only.includes(c.id) : !c.macOnly || IS_MAC));
  if (args.list) {
    for (const c of CONFIGS) {
      const bytes = c.group === "sherpa-parakeet-v3" ? 0 : Object.values(DOWNLOADS[c.group]).reduce((a, e) => a + e.bytes, 0);
      console.log(`${c.id.padEnd(26)} ${c.engine.padEnd(7)} ${c.modes.join("+").padEnd(16)} ${c.macOnly ? "mac " : "    "} ${bytes ? `${mb(bytes)} MB download` : "uses Aiden's installed Parakeet v3"}${c.note ? ` · ${c.note}` : ""}`);
    }
    return;
  }
  if (configs.length === 0) throw new Error("No configs selected. Use --list to see them.");
  const system = systemInfo();
  console.error(`System: ${JSON.stringify(system)}`);
  const clips = await prepareClips(args);
  console.error(`Clips: ${clips.map((c) => c.id).join(", ")}`);
  const results = [];
  for (const config of configs) {
    console.error(`\n▶ ${config.id}`);
    let files;
    try {
      files = await resolveGroup(config.group, args);
    } catch (error) {
      results.push({ id: config.id, error: `download failed: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const result = await runChild({ config, files, clips, runs: args.runs }, args.timeoutMin * 60_000);
    results.push(result);
    console.error(result.error ? `  failed: ${result.error}` : `  load ${result.loadMs} ms, RSS ${result.memoryLoaded.rssMb} MB`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(HERE, "results");
  mkdirSync(dir, { recursive: true });
  const summary = markdown(system, results, clips);
  writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify({ system, clips: clips.map(({ id, reference }) => ({ id, reference })), results }, null, 2));
  writeFileSync(path.join(dir, `${stamp}.md`), summary);
  console.log(summary);
  console.error(`Saved results/${stamp}.json and results/${stamp}.md`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
