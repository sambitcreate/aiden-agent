import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const TIMINGS_VERSION = 1;
export const SAMPLE_LIMIT = 8;
export const DEFAULT_SPEC_SECONDS = 30;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function median(values) {
  const sorted = [...values].filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function normalizeSpecFile(file) {
  if (typeof file !== "string" || file.length === 0) return "";
  const posix = file.replaceAll("\\", "/");
  const marker = "/tests/e2e/";
  const index = posix.lastIndexOf(marker);
  if (index >= 0) return posix.slice(index + marker.length);
  if (posix.startsWith("tests/e2e/")) return posix.slice("tests/e2e/".length);
  const relative = posix.replace(/^\.\//u, "");
  if (relative.endsWith(".spec.ts") && !relative.startsWith("/") && !/^[A-Za-z]:\//u.test(relative)) {
    return relative;
  }
  return posix.split("/").filter(Boolean).at(-1) ?? "";
}

export function timingPlatform(value = process.env.AIDEN_E2E_TIMINGS_PLATFORM ?? process.platform) {
  return value === "linux" || value === "Linux" ? "linux" : "darwin";
}

function visitPlaywrightSuite(suite, totals) {
  const suiteFile = normalizeSpecFile(suite?.file);
  for (const spec of suite?.specs ?? []) {
    const file = normalizeSpecFile(spec.file) || suiteFile;
    if (!file.endsWith(".spec.ts")) continue;
    let milliseconds = 0;
    let counted = false;
    for (const test of spec.tests ?? []) {
      for (const result of test.results ?? []) {
        if (!isRecord(result)) continue;
        if (result.status === "skipped" || result.status === "interrupted") continue;
        if (typeof result.duration !== "number" || !(result.duration >= 0)) continue;
        milliseconds += result.duration;
        counted = true;
      }
    }
    if (!counted) continue;
    totals.set(file, (totals.get(file) ?? 0) + milliseconds);
  }
  for (const child of suite?.suites ?? []) visitPlaywrightSuite(child, totals);
}

export function extractSpecSeconds(report) {
  const totals = new Map();
  if (!isRecord(report)) return {};
  for (const suite of report.suites ?? []) visitPlaywrightSuite(suite, totals);
  const seconds = {};
  for (const [file, milliseconds] of totals) {
    seconds[file] = Math.max(1, Math.round(milliseconds / 1000));
  }
  return seconds;
}

export function emptyTimingsStore() {
  return { version: TIMINGS_VERSION, updatedAt: "", platforms: {} };
}

export function parseTimingsStore(value) {
  if (!isRecord(value) || value.version !== TIMINGS_VERSION || !isRecord(value.platforms)) {
    return emptyTimingsStore();
  }
  return value;
}

export function readTimingsStore(filePath) {
  if (!filePath) return emptyTimingsStore();
  try {
    return parseTimingsStore(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return emptyTimingsStore();
  }
}

export function mergeTimings(previous, extracted, options = {}) {
  const store = parseTimingsStore(previous);
  const platform = timingPlatform(options.platform);
  const specs = { ...(store.platforms[platform]?.specs ?? {}) };
  for (const [file, seconds] of Object.entries(extracted ?? {})) {
    const name = normalizeSpecFile(file);
    if (!name.endsWith(".spec.ts") || !Number.isFinite(seconds) || seconds <= 0) continue;
    const previous = Array.isArray(specs[name]?.samples) ? specs[name].samples : [];
    const samples = [...previous, Math.round(seconds)].slice(-SAMPLE_LIMIT);
    const merged = median(samples);
    if (merged === null) continue;
    specs[name] = { samples, seconds: merged };
  }
  return {
    version: TIMINGS_VERSION,
    updatedAt: options.recordedAt ?? new Date().toISOString(),
    platforms: {
      ...store.platforms,
      [platform]: { specs },
    },
  };
}

export function timingWeights(store, platform) {
  const specs = parseTimingsStore(store).platforms[timingPlatform(platform)]?.specs ?? {};
  const weights = {};
  for (const [file, entry] of Object.entries(specs)) {
    if (Number.isFinite(entry?.seconds) && entry.seconds > 0) weights[file] = entry.seconds;
  }
  return weights;
}

export function specWeight(file, recorded, fallback, defaultSeconds = DEFAULT_SPEC_SECONDS) {
  return recorded[file] ?? fallback[file] ?? defaultSeconds;
}

export function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function platformFromArtifactPath(filePath) {
  const posix = filePath.replaceAll("\\", "/");
  const parent = posix.split("/").filter(Boolean).at(-2) ?? "";
  if (/linux/i.test(parent) || /linux/i.test(path.basename(posix))) return "linux";
  return "darwin";
}

export function mergeTimingArtifacts(storePath, directory, outPath) {
  let store = readTimingsStore(storePath);
  const files = [];
  try {
    for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || entry.name !== "e2e-shard-timings.json") continue;
      files.push(path.join(entry.parentPath, entry.name));
    }
  } catch {
    files.length = 0;
  }
  for (const file of files.sort()) {
    let extracted = {};
    try {
      extracted = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      extracted = {};
    }
    store = mergeTimings(store, extracted, { platform: platformFromArtifactPath(file) });
  }
  writeJson(outPath, store);
  return store;
}

function usage() {
  throw new Error("Usage: node scripts/ci-e2e-timings.mjs extract <report> <out> | merge <store> <extracted...> --platform <darwin|linux> --out <store> | merge-dir <store> <dir> --out <store>");
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command === "extract") {
    if (argv.length !== 3) usage();
    const report = JSON.parse(readFileSync(argv[1], "utf8"));
    writeJson(argv[2], extractSpecSeconds(report));
    return;
  }
  if (command === "merge") {
    const files = [];
    let platform = "darwin";
    let out = "";
    for (let index = 1; index < argv.length; index += 1) {
      if (argv[index] === "--platform") {
        platform = argv[index + 1];
        index += 1;
        continue;
      }
      if (argv[index] === "--out") {
        out = argv[index + 1];
        index += 1;
        continue;
      }
      files.push(argv[index]);
    }
    if (files.length < 2 || !out) usage();
    let store = readTimingsStore(files[0]);
    for (const file of files.slice(1)) {
      let extracted = {};
      try {
        extracted = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        extracted = {};
      }
      store = mergeTimings(store, extracted, { platform });
    }
    writeJson(out, store);
    return;
  }
  if (command === "merge-dir") {
    let out = "";
    const positional = [];
    for (let index = 1; index < argv.length; index += 1) {
      if (argv[index] === "--out") {
        out = argv[index + 1];
        index += 1;
        continue;
      }
      positional.push(argv[index]);
    }
    if (positional.length !== 2 || !out) usage();
    mergeTimingArtifacts(positional[0], positional[1], out);
    return;
  }
  usage();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
