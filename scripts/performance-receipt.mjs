import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
import { execFileSync } from "node:child_process";
import {
  PERFORMANCE_ARTIFACT_KEYS,
  PERFORMANCE_MEASUREMENT_KEYS,
  PERFORMANCE_SCENARIOS,
} from "./performance-fixture.mjs";

const MAX_DIAGNOSTIC_BYTES = 2 * 1024 * 1024;
const MAX_SHUTDOWN_SUMMARY_BYTES = 16 * 1024;
const MAX_RECEIPT_BYTES = 512 * 1024;
const MAX_DIAGNOSTIC_EVENTS = 2_048;
const MAX_DIAGNOSTIC_SERIES = 256;
const MAX_AGGREGATE_ARTIFACT_BYTES = 8 * 1024 * 1024 * 1024;
const ANCILLARY_ARTIFACTS = new Set(["chromePerformance", "reactProfiler"]);
const POSITIVE_MEASUREMENTS = new Set([
  "appReadyMs",
  "windowCreatedMs",
  "windowReadyMs",
  "shellPaintMs",
  "providersReadyMs",
  "composerReadyMs",
  "ipcMessages",
  "reactCommitCount",
  "reactCommitDurationMs",
  "heapPeakBytes",
  "heapSettledBytes",
  "rssPeakBytes",
  "rssSettledBytes",
  "rendererJavaScriptBytes",
  "largestRendererChunkBytes",
  "buildSourceMapBytes",
  "packageBytes",
]);
const SAFE_SERIES_KEY = /^[a-zA-Z0-9:_-]{1,96}$/u;
const METADATA_STAMP = /^[a-zA-Z0-9._-]{1,128}$/u;
const DIAGNOSTIC_EVENT_NAMES = new Set([
  "startup.main_loaded",
  "startup.app_ready",
  "startup.window_created",
  "startup.navigation_started",
  "startup.window_ready",
  "startup.shell_painted",
  "startup.providers_ready",
  "startup.composer_ready",
  "main.event_loop_sample",
  "main.long_task",
  "renderer.long_task",
  "renderer.react_commit",
  "renderer.scheduler_snapshot",
  "renderer.unresponsive",
  "renderer.responsive",
  "renderer.process_gone",
  "child.process_gone",
  "process.error",
  "shutdown.timeout",
  "shutdown.complete",
  "crash_loop.state",
]);
const DIAGNOSTIC_STATES = new Set(["active", "complete", "failed", "recovered", "unknown"]);
const EVENT_FIELDS = new Map([
  ...[
    "startup.main_loaded",
    "startup.app_ready",
    "startup.window_created",
    "startup.navigation_started",
    "startup.window_ready",
    "startup.shell_painted",
    "startup.providers_ready",
    "startup.composer_ready",
  ].map((name) => [name, []]),
  ["main.event_loop_sample", ["durationMs", "count", "state"]],
  ["main.long_task", ["durationMs", "state"]],
  ["renderer.long_task", ["durationMs"]],
  ["renderer.react_commit", ["durationMs", "count"]],
  ["renderer.scheduler_snapshot", ["count"]],
  ["renderer.unresponsive", ["state"]],
  ["renderer.responsive", ["state"]],
  ["renderer.process_gone", ["state"]],
  ["child.process_gone", ["state"]],
  ["process.error", ["state"]],
  ["shutdown.timeout", ["state"]],
  ["shutdown.complete", ["durationMs", "state"]],
  ["crash_loop.state", ["count", "state"]],
]);

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function onlyKeys(value, allowed) {
  const permitted = new Set(allowed);
  return Object.keys(value).every((key) => permitted.has(key));
}

function nonnegativeFinite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sumDiagnosticCounters(counters, predicate, field) {
  return Object.entries(counters)
    .filter(([key]) => predicate(key))
    .reduce((total, [, value]) => total + value[field], 0);
}

function verifyDeterministicMeasurements(receipt, diagnostics) {
  if (!PERFORMANCE_MEASUREMENT_KEYS.every((key) => nonnegativeFinite(receipt.measurements[key]))) {
    return;
  }
  const firstEvent = (name) => diagnostics.events.find((event) => event.name === name);
  const eventTotal = (name, field) =>
    diagnostics.events
      .filter((event) => event.name === name)
      .reduce((total, event) => total + (event[field] ?? 0), 0);
  const ipc = (key) => key.startsWith("ipc:") || key.startsWith("ipc-out:");
  const childLaunch = (key) => /^child:[a-z0-9-]+$/u.test(key);
  const observed = {
    mainLoadedMs: firstEvent("startup.main_loaded")?.monotonicMs,
    appReadyMs: firstEvent("startup.app_ready")?.monotonicMs,
    windowCreatedMs: firstEvent("startup.window_created")?.monotonicMs,
    navigationStartedMs: firstEvent("startup.navigation_started")?.monotonicMs,
    windowReadyMs: firstEvent("startup.window_ready")?.monotonicMs,
    shellPaintMs: firstEvent("startup.shell_painted")?.monotonicMs,
    providersReadyMs: firstEvent("startup.providers_ready")?.monotonicMs,
    composerReadyMs: firstEvent("startup.composer_ready")?.monotonicMs,
    reactCommitCount: eventTotal("renderer.react_commit", "count"),
    reactCommitDurationMs: eventTotal("renderer.react_commit", "durationMs"),
    liveRafCurrent: diagnostics.gauges["live:renderer-raf"]?.current,
    liveRafPeak: diagnostics.gauges["live:renderer-raf"]?.peak,
    liveTimerCurrent: diagnostics.gauges["live:renderer-timer"]?.current,
    liveTimerPeak: diagnostics.gauges["live:renderer-timer"]?.peak,
    scrollWrites: diagnostics.counters["renderer:scroll-write"]?.count ?? 0,
    childLaunches: sumDiagnosticCounters(diagnostics.counters, childLaunch, "count"),
    childPeak: diagnostics.gauges["live:child"]?.peak ?? 0,
    gitCommands: diagnostics.counters["child:git"]?.count ?? 0,
    ipcMessages: sumDiagnosticCounters(diagnostics.counters, ipc, "count"),
    ipcBytesIn: sumDiagnosticCounters(diagnostics.counters, ipc, "bytesIn"),
    ipcBytesOut: sumDiagnosticCounters(diagnostics.counters, ipc, "bytesOut"),
    filesystemReads: sumDiagnosticCounters(
      diagnostics.counters,
      (key) => key.startsWith("filesystem:read"),
      "count",
    ),
    filesystemReadBytes: sumDiagnosticCounters(
      diagnostics.counters,
      (key) => key.startsWith("filesystem:read"),
      "bytesOut",
    ),
    filesystemWrites: sumDiagnosticCounters(
      diagnostics.counters,
      (key) => key.startsWith("filesystem:write"),
      "count",
    ),
    filesystemWriteBytes: sumDiagnosticCounters(
      diagnostics.counters,
      (key) => key.startsWith("filesystem:write"),
      "bytesIn",
    ),
    mcpClientPeak: diagnostics.gauges["live:mcp-client"]?.peak ?? 0,
    ptyPeak: diagnostics.gauges["live:pty"]?.peak ?? 0,
    recognizerPeak: diagnostics.gauges["live:recognizer"]?.peak ?? 0,
  };
  for (const [key, value] of Object.entries(observed)) {
    if (!nonnegativeFinite(value) || receipt.measurements[key] !== value) {
      throw new Error(`Performance measurement ${key} does not match diagnostics.`);
    }
  }
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function exactIsoTime(value) {
  if (typeof value !== "string" || value.length !== 24) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export async function readBoundedJsonFile(file, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("Invalid bounded JSON read limit.");
  }
  const resolved = path.resolve(file);
  if ((await realpath(resolved)) !== resolved) {
    throw new Error("JSON input must not use symlinks.");
  }
  const handle = await open(
    resolved,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) {
      throw new Error("JSON input is not a bounded regular file.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const currentPath = await lstat(resolved, { bigint: true });
    if (
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(after, currentPath) ||
      (await realpath(resolved)) !== resolved ||
      bytes.byteLength !== Number(before.size)
    ) {
      throw new Error("JSON input changed while it was being read.");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { value: JSON.parse(text), bytes: bytes.byteLength };
  } finally {
    await handle.close();
  }
}

export function verifyPerformanceReceipt(receipt, { requireComplete = false } = {}) {
  const input = record(receipt);
  if (!input || input.schemaVersion !== 1 || !PERFORMANCE_SCENARIOS.includes(input.scenario)) {
    throw new Error("Invalid performance receipt.");
  }
  if (
    !exactKeys(input, [
      "schemaVersion",
      "runId",
      "recordedAt",
      "scenario",
      "commit",
      "dirtyStateHash",
      "buildMode",
      "appVersion",
      "electronVersion",
      "nodeVersion",
      "platform",
      "hardware",
      "logicalCpuCount",
      "memoryBytes",
      "macOSVersion",
      "architecture",
      "powerSource",
      "profilingBuild",
      "packageIdentity",
      "voiceModelIdentity",
      "fixture",
      "measurements",
      "artifacts",
    ])
  ) {
    throw new Error("Invalid performance receipt fields.");
  }
  if (!/^[0-9a-f]{40,64}$/u.test(input.commit)) {
    throw new Error("Invalid performance receipt commit.");
  }
  if (!/^[0-9a-f]{64}$/u.test(input.dirtyStateHash)) {
    throw new Error("Invalid performance receipt dirty-state hash.");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.runId)
  ) {
    throw new Error("Invalid performance receipt run identifier.");
  }
  if (!new Set(["development", "packaged", "release"]).has(input.buildMode)) {
    throw new Error("Invalid performance receipt build mode.");
  }
  if (!new Set(["darwin", "linux", "win32"]).has(input.platform)) {
    throw new Error("Invalid performance receipt platform.");
  }
  for (const key of ["appVersion", "electronVersion", "nodeVersion", "architecture"]) {
    if (!METADATA_STAMP.test(input[key])) {
      throw new Error("Invalid performance receipt runtime stamp.");
    }
  }
  if (!new Set(["ac", "battery", "unknown"]).has(input.powerSource)) {
    throw new Error("Invalid performance receipt power source.");
  }
  if (!/^[a-zA-Z0-9 ._()+@-]{1,160}$/u.test(input.hardware)) {
    throw new Error("Invalid performance receipt hardware stamp.");
  }
  if (!/^[0-9]+(?:\.[0-9]+){1,3}$/u.test(input.macOSVersion)) {
    throw new Error("Invalid performance receipt macOS stamp.");
  }
  for (const key of [
    "runId",
    "recordedAt",
    "commit",
    "dirtyStateHash",
    "buildMode",
    "appVersion",
    "electronVersion",
    "nodeVersion",
    "platform",
    "hardware",
    "macOSVersion",
    "architecture",
    "powerSource",
  ]) {
    if (typeof input[key] !== "string" || input[key].length < 1 || input[key].length > 256) {
      throw new Error("Invalid performance receipt stamp.");
    }
  }
  if (!exactIsoTime(input.recordedAt)) throw new Error("Invalid performance receipt time.");
  if (!nonnegativeFinite(input.logicalCpuCount) || !nonnegativeFinite(input.memoryBytes)) {
    throw new Error("Invalid performance receipt hardware values.");
  }
  if (typeof input.profilingBuild !== "boolean") {
    throw new Error("Invalid performance profiling build stamp.");
  }
  if (
    requireComplete &&
    (input.buildMode !== "packaged" || !input.profilingBuild || input.powerSource === "unknown")
  ) {
    throw new Error("Complete performance evidence requires a packaged profiling power run.");
  }
  if (input.packageIdentity !== null) {
    const identity = record(input.packageIdentity);
    const fields = [
      "schemaVersion",
      "commit",
      "dirtyStateHash",
      "buildMode",
      "profilingBuild",
      "runtimeNodeVersion",
      "runtimeElectronVersion",
      "runtimePlatform",
      "runtimeArchitecture",
      "appAsarSha256",
      "executableSha256",
      "codeDirectoryHash",
    ];
    if (
      !identity ||
      !exactKeys(identity, fields) ||
      identity.schemaVersion !== 1 ||
      typeof identity.profilingBuild !== "boolean" ||
      [
        "commit",
        "dirtyStateHash",
        "buildMode",
        "runtimeNodeVersion",
        "runtimeElectronVersion",
        "runtimePlatform",
        "runtimeArchitecture",
      ].some((key) => typeof identity[key] !== "string" || !METADATA_STAMP.test(identity[key])) ||
      !/^[0-9a-f]{64}$/u.test(identity.appAsarSha256) ||
      !/^[0-9a-f]{64}$/u.test(identity.executableSha256) ||
      !/^[0-9a-f]{40,64}$/u.test(identity.codeDirectoryHash) ||
      identity.commit !== input.commit ||
      identity.dirtyStateHash !== input.dirtyStateHash ||
      identity.buildMode !== input.buildMode ||
      identity.profilingBuild !== input.profilingBuild ||
      identity.runtimeNodeVersion !== input.nodeVersion ||
      identity.runtimeElectronVersion !== input.electronVersion ||
      identity.runtimePlatform !== input.platform ||
      identity.runtimeArchitecture !== input.architecture
    ) {
      throw new Error("Invalid performance package identity.");
    }
  } else if (requireComplete) {
    throw new Error("Performance receipt is not bound to a package.");
  }
  if (input.voiceModelIdentity !== null) {
    const voice = record(input.voiceModelIdentity);
    if (
      !voice ||
      !exactKeys(voice, [
        "schemaVersion",
        "catalogVersion",
        "modelId",
        "files",
        "bytes",
        "sha256",
      ]) ||
      voice.schemaVersion !== 1 ||
      voice.catalogVersion !== 1 ||
      !new Set(["parakeet-v2", "parakeet-v3"]).has(voice.modelId) ||
      !Number.isSafeInteger(voice.files) ||
      voice.files < 1 ||
      voice.files > 32 ||
      !Number.isSafeInteger(voice.bytes) ||
      voice.bytes < 1 ||
      voice.bytes > 1024 * 1024 * 1024 ||
      !/^[0-9a-f]{64}$/u.test(voice.sha256)
    ) {
      throw new Error("Invalid performance voice model identity.");
    }
    if (input.scenario !== "voice-long") {
      throw new Error("Voice model identity is valid only for the voice-long scenario.");
    }
  }
  if (input.scenario === "voice-long" && requireComplete && input.voiceModelIdentity === null) {
    throw new Error("Complete voice evidence requires an exact local model identity.");
  }
  if (input.fixture !== undefined) {
    const fixture = record(input.fixture);
    const fixtureFields = [
      "schemaVersion",
      "runId",
      "scenario",
      "generatedAt",
      "chats",
      "streams",
      "workspaceFiles",
      "attachmentFiles",
      "sparseAttachmentBytes",
      "missedSchedules",
      "terminals",
      "fixtureIdentity",
    ];
    if (
      !fixture ||
      !exactKeys(fixture, fixtureFields) ||
      fixture.schemaVersion !== 1 ||
      !exactIsoTime(fixture.generatedAt) ||
      fixture.runId !== input.runId ||
      fixture.scenario !== input.scenario
    ) {
      throw new Error("Invalid performance receipt fixture schema.");
    }
    if (!/^[0-9a-f]{64}$/u.test(fixture.fixtureIdentity)) {
      throw new Error("Invalid performance receipt fixture identity.");
    }
    for (const key of fixtureFields.slice(4, -1)) {
      const value = fixture[key];
      if (Array.isArray(value)) {
        if (value.some((entry) => !nonnegativeFinite(entry))) {
          throw new Error("Invalid performance receipt fixture values.");
        }
      } else if (!nonnegativeFinite(value)) {
        throw new Error("Invalid performance receipt fixture values.");
      }
    }
  } else if (requireComplete) {
    throw new Error("Performance receipt is missing fixture provenance.");
  }
  const measurements = record(input.measurements);
  if (!measurements || !exactKeys(measurements, PERFORMANCE_MEASUREMENT_KEYS)) {
    throw new Error("Invalid performance receipt measurement schema.");
  }
  for (const key of PERFORMANCE_MEASUREMENT_KEYS) {
    const value = measurements[key];
    if (value === null && !requireComplete) continue;
    if (
      !nonnegativeFinite(value) ||
      (requireComplete && POSITIVE_MEASUREMENTS.has(key) && value <= 0)
    ) {
      throw new Error(`Performance measurement ${key} is missing or invalid.`);
    }
  }
  const artifacts = record(input.artifacts);
  if (!artifacts || !exactKeys(artifacts, PERFORMANCE_ARTIFACT_KEYS)) {
    throw new Error("Invalid performance receipt artifact schema.");
  }
  for (const key of PERFORMANCE_ARTIFACT_KEYS) {
    const value = artifacts[key];
    if (value === null && (!requireComplete || ANCILLARY_ARTIFACTS.has(key))) continue;
    const artifact = record(value);
    if (
      !artifact ||
      !exactKeys(artifact, ["path", "sha256", "bytes"]) ||
      typeof artifact.path !== "string" ||
      artifact.path.length < 1 ||
      artifact.path.length > 256 ||
      pathIsUnsafe(artifact.path) ||
      typeof artifact.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 1 ||
      artifact.bytes > 4 * 1024 * 1024 * 1024
    ) {
      throw new Error(`Performance artifact ${key} is missing or invalid.`);
    }
    const expectedExtension = new Set(["timeProfiler", "energyLog", "coreAnimation"]).has(key)
      ? ".zip"
      : ".json";
    if (!artifact.path.endsWith(expectedExtension)) {
      throw new Error(`Performance artifact ${key} has an invalid export format.`);
    }
    if (key === "diagnosticsExport" && artifact.bytes > MAX_DIAGNOSTIC_BYTES) {
      throw new Error("Performance diagnostics exceed the artifact verification budget.");
    }
    if (key === "shutdownSummary" && artifact.bytes > MAX_SHUTDOWN_SUMMARY_BYTES) {
      throw new Error("Performance shutdown summary exceeds its verification budget.");
    }
  }
  const artifactPaths = PERFORMANCE_ARTIFACT_KEYS.map((key) => artifacts[key]?.path).filter(
    Boolean,
  );
  if (new Set(artifactPaths).size !== artifactPaths.length) {
    throw new Error("Performance artifacts must use distinct files.");
  }
  return true;
}

async function readExact(handle, length, position, label) {
  const output = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(output, offset, length - offset, position + offset);
    if (bytesRead < 1) throw new Error(`${label} changed while being read.`);
    offset += bytesRead;
  }
  return output;
}

async function inspectTraceZip(handle, fileBytes) {
  const tailLength = Math.min(fileBytes, 65_557);
  const tail = await readExact(
    handle,
    tailLength,
    fileBytes - tailLength,
    "Performance ZIP artifact",
  );
  let endOffset = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === 0x06054b50) {
      endOffset = index;
      break;
    }
  }
  if (endOffset < 0) throw new Error("Performance artifact is not a complete ZIP archive.");
  const disk = tail.readUInt16LE(endOffset + 4);
  const directoryDisk = tail.readUInt16LE(endOffset + 6);
  const diskEntries = tail.readUInt16LE(endOffset + 8);
  const entries = tail.readUInt16LE(endOffset + 10);
  const directoryBytes = tail.readUInt32LE(endOffset + 12);
  const directoryOffset = tail.readUInt32LE(endOffset + 16);
  const commentBytes = tail.readUInt16LE(endOffset + 20);
  const globalEndOffset = fileBytes - tailLength + endOffset;
  if (
    disk !== 0 ||
    directoryDisk !== 0 ||
    entries < 1 ||
    entries !== diskEntries ||
    entries === 0xffff ||
    directoryBytes > 16 * 1024 * 1024 ||
    directoryOffset === 0xffffffff ||
    directoryOffset + directoryBytes > globalEndOffset ||
    globalEndOffset + 22 + commentBytes !== fileBytes
  ) {
    throw new Error("Performance artifact has an unsupported ZIP directory.");
  }
  const directory = await readExact(
    handle,
    directoryBytes,
    directoryOffset,
    "Performance ZIP artifact",
  );
  const traceRoots = new Set();
  let offset = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Performance artifact has an invalid ZIP directory.");
    }
    const nameBytes = directory.readUInt16LE(offset + 28);
    const extraBytes = directory.readUInt16LE(offset + 30);
    const entryCommentBytes = directory.readUInt16LE(offset + 32);
    const next = offset + 46 + nameBytes + extraBytes + entryCommentBytes;
    if (nameBytes < 1 || nameBytes > 1_024 || next > directory.length) {
      throw new Error("Performance artifact has an invalid ZIP entry.");
    }
    const name = decoder.decode(directory.subarray(offset + 46, offset + 46 + nameBytes));
    if (
      name.startsWith("/") ||
      name.includes("\\") ||
      name.includes("\0") ||
      name.split("/").includes("..")
    ) {
      throw new Error("Performance artifact has an unsafe ZIP entry.");
    }
    const traceIndex = name.indexOf(".trace/");
    if (traceIndex >= 0) traceRoots.add(name.slice(0, traceIndex + 6));
    offset = next;
  }
  if (offset !== directory.length || traceRoots.size < 1) {
    throw new Error("Performance artifact does not contain an Instruments trace package.");
  }
}

async function readAndHashArtifact(file, maximumBytes, captureBytes, inspectZip = false) {
  const handle = await open(
    file,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) {
      throw new Error("Performance artifact is not a bounded regular file.");
    }
    const digest = createHash("sha256");
    const chunks = [];
    let prefix = Buffer.alloc(0);
    let offset = 0;
    while (offset < Number(before.size)) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Number(before.size) - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead < 1) throw new Error("Performance artifact changed while being read.");
      const chunk = buffer.subarray(0, bytesRead);
      if (prefix.length < 16) prefix = Buffer.from(chunk.subarray(0, 16));
      digest.update(chunk);
      if (captureBytes) chunks.push(Buffer.from(chunk));
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const currentPath = await lstat(file, { bigint: true });
    if (
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(after, currentPath) ||
      (await realpath(file)) !== path.resolve(file) ||
      offset !== Number(before.size)
    ) {
      throw new Error("Performance artifact changed while being read.");
    }
    if (inspectZip) await inspectTraceZip(handle, offset);
    return {
      bytes: offset,
      sha256: digest.digest("hex"),
      prefix,
      ...(captureBytes ? { content: Buffer.concat(chunks, offset) } : {}),
    };
  } finally {
    await handle.close();
  }
}

export async function verifyPerformanceReceiptArtifacts(
  receipt,
  receiptPath,
  { captureDiagnostics = false } = {},
) {
  verifyPerformanceReceipt(receipt, { requireComplete: true });
  const resolvedReceipt = path.resolve(receiptPath);
  if ((await realpath(resolvedReceipt)) !== resolvedReceipt) {
    throw new Error("The performance receipt path is unsafe.");
  }
  const receiptIdentity = await lstat(resolvedReceipt, { bigint: true });
  if (!receiptIdentity.isFile() || receiptIdentity.isSymbolicLink()) {
    throw new Error("The performance receipt path is unsafe.");
  }
  const currentReceiptInput = (await readBoundedJsonFile(resolvedReceipt, MAX_RECEIPT_BYTES)).value;
  if (JSON.stringify(currentReceiptInput) !== JSON.stringify(receipt)) {
    throw new Error("The performance receipt changed before artifact verification.");
  }
  const root = path.dirname(resolvedReceipt);
  const aggregateBytes = PERFORMANCE_ARTIFACT_KEYS.reduce(
    (total, key) => total + (receipt.artifacts[key]?.bytes ?? 0),
    0,
  );
  if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > MAX_AGGREGATE_ARTIFACT_BYTES) {
    throw new Error("Performance artifacts exceed the aggregate verification budget.");
  }
  let diagnosticsContent;
  let shutdownSummaryContent;
  const instrumentsDigests = new Set();
  const observedArtifactPaths = [];
  for (const key of PERFORMANCE_ARTIFACT_KEYS) {
    const expected = receipt.artifacts[key];
    if (expected === null) continue;
    if (key === "diagnosticsExport" && expected.bytes > MAX_DIAGNOSTIC_BYTES) {
      throw new Error("Performance diagnostics exceed the artifact verification budget.");
    }
    const target = path.resolve(root, expected.path);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Performance artifact ${key} escapes the receipt directory.`);
    }
    const [canonical, info] = await Promise.all([
      realpath(target),
      lstat(target, { bigint: true }),
    ]);
    if (
      canonical !== target ||
      info.isSymbolicLink() ||
      !info.isFile() ||
      info.size !== BigInt(expected.bytes)
    ) {
      throw new Error(`Performance artifact ${key} does not match its receipt.`);
    }
    observedArtifactPaths.push({ target, info });
    const observed = await readAndHashArtifact(
      target,
      expected.bytes,
      captureDiagnostics && (key === "diagnosticsExport" || key === "shutdownSummary"),
      new Set(["timeProfiler", "energyLog", "coreAnimation"]).has(key),
    );
    if (observed.bytes !== expected.bytes || observed.sha256 !== expected.sha256) {
      throw new Error(`Performance artifact ${key} does not match its receipt.`);
    }
    if (new Set(["timeProfiler", "energyLog", "coreAnimation"]).has(key)) {
      if (instrumentsDigests.has(observed.sha256)) {
        throw new Error("Required Instruments artifacts must contain distinct recordings.");
      }
      instrumentsDigests.add(observed.sha256);
      try {
        execFileSync("/usr/bin/unzip", ["-tqq", target], {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 5 * 60 * 1_000,
          maxBuffer: 1024 * 1024,
        });
      } catch {
        throw new Error(`Performance artifact ${key} failed ZIP integrity verification.`);
      }
    }
    if (
      new Set(["chromePerformance", "reactProfiler"]).has(key) &&
      !new Set([0x7b, 0x5b]).has(
        observed.prefix.find((byte) => !/\s/u.test(String.fromCharCode(byte))),
      )
    ) {
      throw new Error(`Performance artifact ${key} does not have a JSON-like prefix.`);
    }
    if (key === "diagnosticsExport") diagnosticsContent = observed.content;
    if (key === "shutdownSummary") shutdownSummaryContent = observed.content;
  }
  for (const { target, info } of observedArtifactPaths) {
    const current = await lstat(target, { bigint: true });
    if (
      !sameFileIdentity(info, current) ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      (await realpath(target)) !== target
    ) {
      throw new Error("Performance artifacts changed during verification.");
    }
  }
  const currentReceipt = await lstat(resolvedReceipt, { bigint: true });
  if (
    !sameFileIdentity(receiptIdentity, currentReceipt) ||
    !currentReceipt.isFile() ||
    currentReceipt.isSymbolicLink() ||
    (await realpath(resolvedReceipt)) !== resolvedReceipt
  ) {
    throw new Error("The performance receipt changed during artifact verification.");
  }
  return captureDiagnostics ? { diagnosticsContent, shutdownSummaryContent } : true;
}

function pathIsUnsafe(value) {
  return (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").includes("..") ||
    !/^[a-zA-Z0-9._/-]+$/u.test(value)
  );
}

function verifyDiagnosticSeries(series, gauge = false) {
  const input = record(series);
  if (!input || Object.keys(input).length > MAX_DIAGNOSTIC_SERIES) {
    throw new Error("Performance diagnostics have an invalid series set.");
  }
  for (const [key, rawValue] of Object.entries(input)) {
    const value = record(rawValue);
    if (!SAFE_SERIES_KEY.test(key) || !value) {
      throw new Error("Performance diagnostics have an invalid series.");
    }
    const fields = gauge
      ? ["current", "peak"]
      : ["count", "errors", "bytesIn", "bytesOut", "durationMs"];
    if (!exactKeys(value, fields) || fields.some((field) => !nonnegativeFinite(value[field]))) {
      throw new Error("Performance diagnostics have invalid aggregate values.");
    }
  }
}

export function verifyPerformanceDiagnosticExport(
  payload,
  receipt,
  serializedBytes,
  { requireScenarioEvidence = false } = {},
) {
  verifyPerformanceReceipt(receipt);
  if (
    !Number.isSafeInteger(serializedBytes) ||
    serializedBytes < 1 ||
    serializedBytes > MAX_DIAGNOSTIC_BYTES
  ) {
    throw new Error("Performance diagnostics exceed the export budget.");
  }
  const input = record(payload);
  const metadata = record(input?.metadata);
  const diagnostics = record(input?.diagnostics);
  if (
    !input ||
    input.schemaVersion !== 1 ||
    typeof input.exportId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      input.exportId,
    ) ||
    !metadata ||
    !diagnostics
  ) {
    throw new Error("Invalid performance diagnostics export.");
  }
  if (
    !onlyKeys(input, ["schemaVersion", "exportId", "metadata", "diagnostics", "previousSession"])
  ) {
    throw new Error("Invalid performance diagnostics export fields.");
  }
  const metadataFields = [
    "runId",
    "commit",
    "dirtyStateHash",
    "buildMode",
    "profilingBuild",
    "appVersion",
    "electronVersion",
    "nodeVersion",
    "platform",
    "architecture",
    "macOSVersion",
    "hardware",
    "logicalCpuCount",
    "memoryBytes",
    "powerSource",
    "scenario",
  ];
  if (!exactKeys(metadata, metadataFields)) {
    throw new Error("Invalid performance diagnostics metadata fields.");
  }
  for (const key of [
    "runId",
    "commit",
    "dirtyStateHash",
    "buildMode",
    "appVersion",
    "electronVersion",
    "nodeVersion",
    "platform",
    "architecture",
    "macOSVersion",
    "scenario",
  ]) {
    if (typeof metadata[key] !== "string" || !METADATA_STAMP.test(metadata[key])) {
      throw new Error("Invalid performance diagnostics metadata.");
    }
  }
  if (
    metadata.runId !== receipt.runId ||
    metadata.commit !== receipt.commit ||
    metadata.dirtyStateHash !== receipt.dirtyStateHash ||
    metadata.buildMode !== receipt.buildMode ||
    metadata.profilingBuild !== receipt.profilingBuild ||
    metadata.appVersion !== receipt.appVersion ||
    metadata.electronVersion !== receipt.electronVersion ||
    metadata.nodeVersion !== receipt.nodeVersion ||
    metadata.platform !== receipt.platform ||
    metadata.architecture !== receipt.architecture ||
    metadata.macOSVersion !== receipt.macOSVersion ||
    metadata.hardware !== receipt.hardware ||
    metadata.logicalCpuCount !== receipt.logicalCpuCount ||
    metadata.memoryBytes !== receipt.memoryBytes ||
    metadata.scenario !== receipt.scenario ||
    metadata.powerSource !== receipt.powerSource
  ) {
    throw new Error("Performance diagnostics do not match their receipt.");
  }
  if (
    !exactKeys(diagnostics, [
      "schemaVersion",
      "generatedAt",
      "sessionStartedAt",
      "droppedEvents",
      "droppedSeries",
      "events",
      "counters",
      "gauges",
    ])
  ) {
    throw new Error("Invalid performance diagnostics fields.");
  }
  if (
    diagnostics.schemaVersion !== 1 ||
    diagnostics.droppedEvents !== 0 ||
    diagnostics.droppedSeries !== 0 ||
    !exactIsoTime(diagnostics.generatedAt) ||
    !exactIsoTime(diagnostics.sessionStartedAt)
  ) {
    throw new Error("Performance diagnostics dropped samples.");
  }
  if (!Array.isArray(diagnostics.events) || diagnostics.events.length > MAX_DIAGNOSTIC_EVENTS) {
    throw new Error("Performance diagnostics have an invalid event ring.");
  }
  let previousSequence = 0;
  for (const event of diagnostics.events) {
    const value = record(event);
    const optionalFields =
      value && typeof value.name === "string" ? EVENT_FIELDS.get(value.name) : undefined;
    if (
      !value ||
      !optionalFields ||
      !exactKeys(value, ["sequence", "monotonicMs", "name", ...optionalFields]) ||
      typeof value.name !== "string" ||
      !DIAGNOSTIC_EVENT_NAMES.has(value.name) ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 1 ||
      !nonnegativeFinite(value.monotonicMs) ||
      ["durationMs", "count"].some(
        (key) => value[key] !== undefined && !nonnegativeFinite(value[key]),
      ) ||
      (value.state !== undefined && !DIAGNOSTIC_STATES.has(value.state))
    ) {
      throw new Error("Performance diagnostics have an invalid event.");
    }
    if (event.sequence <= previousSequence) {
      throw new Error("Performance diagnostics have an invalid event sequence.");
    }
    previousSequence = event.sequence;
  }
  verifyDiagnosticSeries(diagnostics.counters);
  verifyDiagnosticSeries(diagnostics.gauges, true);
  if (requireScenarioEvidence) {
    const requiredStartup = [
      "startup.main_loaded",
      "startup.app_ready",
      "startup.window_created",
      "startup.navigation_started",
      "startup.window_ready",
      "startup.shell_painted",
      "startup.providers_ready",
      "startup.composer_ready",
    ];
    const names = new Set(diagnostics.events.map(({ name }) => name));
    if (requiredStartup.some((name) => !names.has(name))) {
      throw new Error("Performance diagnostics are missing the startup sequence.");
    }
    for (const requiredEvent of [
      "main.event_loop_sample",
      "renderer.react_commit",
      "renderer.scheduler_snapshot",
    ]) {
      if (!names.has(requiredEvent)) {
        throw new Error("Performance diagnostics are missing required runtime samples.");
      }
    }
    const startupPositions = Object.fromEntries(
      diagnostics.events
        .map(({ name }, index) => [name, index])
        .filter(([name]) => requiredStartup.includes(name)),
    );
    const stableStartupChain = [
      "startup.main_loaded",
      "startup.app_ready",
      "startup.window_created",
      "startup.navigation_started",
      "startup.window_ready",
    ];
    if (
      stableStartupChain.some(
        (name, index) =>
          index > 0 && startupPositions[name] <= startupPositions[stableStartupChain[index - 1]],
      ) ||
      startupPositions["startup.composer_ready"] <= startupPositions["startup.shell_painted"] ||
      startupPositions["startup.composer_ready"] <= startupPositions["startup.providers_ready"]
    ) {
      throw new Error("Performance diagnostics have an invalid startup order.");
    }
    if (!Object.keys(diagnostics.counters).some((key) => key.startsWith("ipc:"))) {
      throw new Error("Performance diagnostics are missing core IPC counters.");
    }
    const powerTransitions = diagnostics.counters["benchmark:power-source-transition"];
    if (!powerTransitions || powerTransitions.count !== 0 || powerTransitions.errors !== 0) {
      throw new Error("Performance diagnostics show a missing or changed power source.");
    }
    if (receipt.scenario === "voice-long") {
      const voice = diagnostics.counters["benchmark:voice-fixed-decode"];
      if (!voice || voice.count !== 2 || voice.errors !== 0) {
        throw new Error("Performance diagnostics are missing the fixed voice decode evidence.");
      }
    }
    if (receipt.scenario === "mcp-duplicate-connect") {
      const mcp = diagnostics.counters["benchmark:mcp-duplicate-connect"];
      const helpers = diagnostics.counters["child:mcp-stdio"];
      const liveHelpers = diagnostics.gauges["live:child-mcp-stdio"];
      if (
        !mcp ||
        mcp.count !== 100 ||
        mcp.errors !== 100 ||
        !helpers ||
        helpers.count !== 100 ||
        !liveHelpers ||
        liveHelpers.current !== 0 ||
        liveHelpers.peak < 1
      ) {
        throw new Error("Performance diagnostics are missing the duplicate-connect evidence.");
      }
    }
    if (receipt.scenario === "schedules-20-missed") {
      const starts = diagnostics.counters["schedule:run-start"];
      const successes = diagnostics.counters["schedule:run-terminal:success"];
      const duplicates = diagnostics.counters["schedule:run-duplicate"];
      const live = diagnostics.gauges["live:schedule-run"];
      const unexpectedTerminal = Object.entries(diagnostics.counters).some(
        ([key, value]) =>
          key.startsWith("schedule:run-terminal:") &&
          key !== "schedule:run-terminal:success" &&
          value.count > 0,
      );
      if (
        !starts ||
        starts.count !== 20 ||
        starts.errors !== 0 ||
        !successes ||
        successes.count !== 20 ||
        successes.errors !== 0 ||
        !duplicates ||
        duplicates.count !== 0 ||
        duplicates.errors !== 0 ||
        !live ||
        live.current !== 0 ||
        live.peak < 2 ||
        unexpectedTerminal
      ) {
        throw new Error("Performance diagnostics are missing settled schedule catch-up evidence.");
      }
    }
    verifyDeterministicMeasurements(receipt, diagnostics);
  }
  if (input.previousSession !== undefined) {
    const previous = record(input.previousSession);
    const fields = [
      "schemaVersion",
      "runId",
      "scenario",
      "completedAt",
      "sessionStartedAt",
      "shutdownDurationMs",
      "shutdownTimeouts",
      "shutdownFailures",
      "shutdownStatus",
      "crashLoopEvents",
      "rendererProcessGoneEvents",
      "childProcessGoneEvents",
    ];
    if (
      !previous ||
      !exactKeys(previous, fields) ||
      previous.schemaVersion !== 1 ||
      previous.runId !== receipt.runId ||
      previous.scenario !== receipt.scenario ||
      !exactIsoTime(previous.completedAt) ||
      !exactIsoTime(previous.sessionStartedAt) ||
      !nonnegativeFinite(previous.shutdownDurationMs) ||
      !Number.isSafeInteger(previous.shutdownTimeouts) ||
      previous.shutdownTimeouts < 0 ||
      !Number.isSafeInteger(previous.shutdownFailures) ||
      previous.shutdownFailures < 0 ||
      !new Set(["complete", "failed"]).has(previous.shutdownStatus) ||
      (previous.shutdownStatus === "complete" && previous.shutdownFailures !== 0) ||
      (previous.shutdownStatus === "failed" && previous.shutdownFailures < 1) ||
      ["crashLoopEvents", "rendererProcessGoneEvents", "childProcessGoneEvents"].some(
        (key) => !Number.isSafeInteger(previous[key]) || previous[key] < 0,
      )
    ) {
      throw new Error("Performance diagnostics have an invalid previous-session summary.");
    }
  }
  return true;
}

export function verifyPerformanceShutdownSummary(summary, receipt, diagnosticExport) {
  const input = record(summary);
  const fields = [
    "schemaVersion",
    "runId",
    "scenario",
    "completedAt",
    "sessionStartedAt",
    "shutdownDurationMs",
    "shutdownTimeouts",
    "shutdownFailures",
    "shutdownStatus",
    "crashLoopEvents",
    "rendererProcessGoneEvents",
    "childProcessGoneEvents",
  ];
  if (
    !input ||
    !exactKeys(input, fields) ||
    input.schemaVersion !== 1 ||
    input.runId !== receipt.runId ||
    input.scenario !== receipt.scenario ||
    !exactIsoTime(input.completedAt) ||
    !exactIsoTime(input.sessionStartedAt) ||
    !nonnegativeFinite(input.shutdownDurationMs) ||
    !Number.isSafeInteger(input.shutdownTimeouts) ||
    input.shutdownTimeouts !== 0 ||
    !Number.isSafeInteger(input.shutdownFailures) ||
    input.shutdownFailures !== 0 ||
    input.shutdownStatus !== "complete" ||
    !Number.isSafeInteger(input.crashLoopEvents) ||
    input.crashLoopEvents !== 0 ||
    !Number.isSafeInteger(input.rendererProcessGoneEvents) ||
    input.rendererProcessGoneEvents !== 0 ||
    !Number.isSafeInteger(input.childProcessGoneEvents) ||
    input.childProcessGoneEvents !== 0 ||
    receipt.measurements.shutdownMs !== input.shutdownDurationMs ||
    receipt.measurements.shutdownTimeouts !== input.shutdownTimeouts ||
    (diagnosticExport && input.sessionStartedAt !== diagnosticExport.diagnostics?.sessionStartedAt)
  ) {
    throw new Error("Performance shutdown evidence does not match the measured session.");
  }
  return true;
}

async function main() {
  const receiptIndex = process.argv.indexOf("--receipt");
  const diagnosticsIndex = process.argv.indexOf("--diagnostics");
  if (receiptIndex < 0) {
    throw new Error(
      "Usage: performance-receipt.mjs --receipt <receipt.json> [--diagnostics <export.json>] [--require-complete]",
    );
  }
  const receiptRead = await readBoundedJsonFile(process.argv[receiptIndex + 1], MAX_RECEIPT_BYTES);
  const receipt = receiptRead.value;
  const requireComplete = process.argv.includes("--require-complete");
  verifyPerformanceReceipt(receipt, { requireComplete });
  const verifiedArtifacts = requireComplete
    ? await verifyPerformanceReceiptArtifacts(receipt, process.argv[receiptIndex + 1], {
        captureDiagnostics: true,
      })
    : undefined;
  if (diagnosticsIndex >= 0) {
    if (requireComplete) {
      const expected = path.resolve(
        path.dirname(path.resolve(process.argv[receiptIndex + 1])),
        receipt.artifacts.diagnosticsExport.path,
      );
      if ((await realpath(process.argv[diagnosticsIndex + 1])) !== expected) {
        throw new Error("The supplied diagnostics export is not the receipt artifact.");
      }
    }
    if (requireComplete) {
      const content = verifiedArtifacts?.diagnosticsContent;
      const shutdownContent = verifiedArtifacts?.shutdownSummaryContent;
      if (!content) throw new Error("The diagnostics artifact was not captured.");
      if (!shutdownContent) throw new Error("The shutdown artifact was not captured.");
      const diagnosticExport = JSON.parse(content.toString("utf8"));
      verifyPerformanceDiagnosticExport(diagnosticExport, receipt, content.length, {
        requireScenarioEvidence: true,
      });
      verifyPerformanceShutdownSummary(
        JSON.parse(shutdownContent.toString("utf8")),
        receipt,
        diagnosticExport,
      );
    } else {
      const diagnosticsRead = await readBoundedJsonFile(
        process.argv[diagnosticsIndex + 1],
        MAX_DIAGNOSTIC_BYTES,
      );
      verifyPerformanceDiagnosticExport(diagnosticsRead.value, receipt, diagnosticsRead.bytes);
    }
  } else if (requireComplete) {
    const content = verifiedArtifacts?.diagnosticsContent;
    const shutdownContent = verifiedArtifacts?.shutdownSummaryContent;
    if (!content) throw new Error("The diagnostics artifact was not captured.");
    if (!shutdownContent) throw new Error("The shutdown artifact was not captured.");
    const diagnosticExport = JSON.parse(content.toString("utf8"));
    verifyPerformanceDiagnosticExport(diagnosticExport, receipt, content.length, {
      requireScenarioEvidence: true,
    });
    verifyPerformanceShutdownSummary(
      JSON.parse(shutdownContent.toString("utf8")),
      receipt,
      diagnosticExport,
    );
  }
  process.stdout.write(
    "Performance receipt artifacts and automatic runtime evidence verified; interactive scenario execution still requires lab review.\n",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
