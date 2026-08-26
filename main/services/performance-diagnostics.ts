import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  monitorEventLoopDelay,
  performance,
  type IntervalHistogram,
  type EventLoopUtilization,
} from "node:perf_hooks";
import {
  PerformanceDiagnosticBuffer,
  type DiagnosticEventInput,
  type DiagnosticSnapshot,
} from "./performance-diagnostics-core.js";

declare const __AIDEN_EMBEDDED_BUILD_IDENTITY__: string | undefined;

interface EmbeddedPerformanceBuildIdentity {
  schemaVersion: 1;
  commit: string;
  dirtyStateHash: string;
  buildMode: string;
  profilingBuild: boolean;
}

function embeddedPerformanceBuildIdentity(): EmbeddedPerformanceBuildIdentity {
  const unavailable: EmbeddedPerformanceBuildIdentity = {
    schemaVersion: 1,
    commit: "unavailable",
    dirtyStateHash: "unavailable",
    buildMode: "development",
    profilingBuild: false,
  };
  if (typeof __AIDEN_EMBEDDED_BUILD_IDENTITY__ === "undefined") return unavailable;
  try {
    const parsed = JSON.parse(
      __AIDEN_EMBEDDED_BUILD_IDENTITY__,
    ) as Partial<EmbeddedPerformanceBuildIdentity>;
    return parsed.schemaVersion === 1 &&
      typeof parsed.commit === "string" &&
      typeof parsed.dirtyStateHash === "string" &&
      typeof parsed.buildMode === "string" &&
      typeof parsed.profilingBuild === "boolean"
      ? (parsed as EmbeddedPerformanceBuildIdentity)
      : unavailable;
  } catch {
    return unavailable;
  }
}

export interface PerformanceDiagnosticMetadata {
  runId: string;
  commit: string;
  dirtyStateHash: string;
  buildMode: string;
  profilingBuild: boolean;
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  platform: string;
  architecture: string;
  macOSVersion: string;
  hardware: string;
  logicalCpuCount: number;
  memoryBytes: number;
  powerSource: "ac" | "battery" | "unknown";
  scenario: string;
}

export interface PerformanceDiagnosticExportV1 {
  schemaVersion: 1;
  exportId: string;
  metadata: PerformanceDiagnosticMetadata;
  diagnostics: DiagnosticSnapshot;
  previousSession?: PreviousPerformanceDiagnosticSessionV1;
}

export interface PreviousPerformanceDiagnosticSessionV1 {
  schemaVersion: 1;
  runId: string;
  scenario: string;
  completedAt: string;
  sessionStartedAt: string;
  shutdownDurationMs: number;
  shutdownTimeouts: number;
  shutdownFailures: number;
  shutdownStatus: "complete" | "failed";
  crashLoopEvents: number;
  rendererProcessGoneEvents: number;
  childProcessGoneEvents: number;
}

export type RendererDiagnosticReport =
  | { name: "startup.shell_painted" | "startup.providers_ready" | "startup.composer_ready" }
  | { name: "renderer.long_task"; durationMs: number }
  | { name: "renderer.react_commit"; count: number; durationMs: number }
  | {
      name: "renderer.scheduler_snapshot";
      rafCount: number;
      timerCount: number;
      scrollWrites: number;
    };

const diagnostics = new PerformanceDiagnosticBuffer();
export const performanceDiagnosticsEnabled = process.env.AIDEN_PERFORMANCE_DIAGNOSTICS === "1";
let eventLoopHistogram: IntervalHistogram | null = null;
let previousUtilization: EventLoopUtilization | undefined;
let eventLoopSampleTimer: NodeJS.Timeout | undefined;
let previousSession: PreviousPerformanceDiagnosticSessionV1 | undefined;
let sessionSummaryPath: string | undefined;
let persistenceAuthority = 0;
let cachedMacOSVersion = os.release();
const DIAGNOSTIC_PERSISTENCE_DEADLINE_MS = 1_000;

async function settleDiagnosticIoWithin(operation: Promise<void>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), DIAGNOSTIC_PERSISTENCE_DEADLINE_MS);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boundedDiagnosticNumber(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, maximum)
    : undefined;
}

function exactOwnKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  let count = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (++count > allowed.size || !allowed.has(key)) return false;
  }
  return count === allowed.size;
}

export function parseRendererDiagnosticReport(value: unknown): RendererDiagnosticReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid renderer diagnostic report.");
  }
  const input = value as Record<string, unknown>;
  const name = input.name;
  if (
    name === "startup.shell_painted" ||
    name === "startup.providers_ready" ||
    name === "startup.composer_ready"
  ) {
    if (!exactOwnKeys(input, new Set(["name"]))) {
      throw new Error("Invalid renderer diagnostic report.");
    }
    return { name };
  }
  if (name === "renderer.long_task") {
    if (!exactOwnKeys(input, new Set(["name", "durationMs"]))) {
      throw new Error("Invalid renderer diagnostic report.");
    }
    const durationMs = boundedDiagnosticNumber(input.durationMs, 60_000);
    if (durationMs === undefined) throw new Error("Invalid renderer diagnostic duration.");
    return { name, durationMs };
  }
  if (name === "renderer.react_commit") {
    if (!exactOwnKeys(input, new Set(["name", "count", "durationMs"]))) {
      throw new Error("Invalid renderer diagnostic report.");
    }
    const count = boundedDiagnosticNumber(input.count, 1_000_000);
    const durationMs = boundedDiagnosticNumber(input.durationMs, 60_000);
    if (count === undefined || durationMs === undefined) {
      throw new Error("Invalid renderer diagnostic commit sample.");
    }
    return { name, count, durationMs };
  }
  if (name === "renderer.scheduler_snapshot") {
    const allowed = new Set(["name", "rafCount", "timerCount", "scrollWrites"]);
    let ownCount = 0;
    for (const key in input) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
      if (++ownCount > allowed.size || !allowed.has(key)) {
        throw new Error("Invalid renderer diagnostic report.");
      }
    }
    if (ownCount !== allowed.size) throw new Error("Invalid renderer diagnostic report.");
    const rafCount = boundedDiagnosticNumber(input.rafCount, 1_000_000);
    const timerCount = boundedDiagnosticNumber(input.timerCount, 1_000_000);
    const scrollWrites = boundedDiagnosticNumber(input.scrollWrites, 1_000_000_000);
    if (rafCount === undefined || timerCount === undefined || scrollWrites === undefined) {
      throw new Error("Invalid renderer diagnostic counters.");
    }
    return { name, rafCount, timerCount, scrollWrites };
  }
  throw new Error("Invalid renderer diagnostic name.");
}

export function recordDiagnosticEvent(event: DiagnosticEventInput): void {
  if (!performanceDiagnosticsEnabled) return;
  diagnostics.record(event);
}

export function recordDiagnosticCounter(
  key: string,
  sample: {
    count?: number;
    errors?: number;
    bytesIn?: number;
    bytesOut?: number;
    durationMs?: number;
  } = {},
): void {
  if (!performanceDiagnosticsEnabled) return;
  diagnostics.count(key, sample);
}

export function recordDiagnosticGauge(key: string, value: number): void {
  if (!performanceDiagnosticsEnabled) return;
  diagnostics.gauge(key, value);
}

export function startEventLoopDiagnostics(): void {
  if (eventLoopHistogram) return;
  eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
  eventLoopHistogram.enable();
  previousUtilization = performance.eventLoopUtilization();
  eventLoopSampleTimer = setInterval(captureMainPerformanceSample, 5_000);
  eventLoopSampleTimer.unref();
}

export function stopEventLoopDiagnostics(): void {
  eventLoopHistogram?.disable();
  eventLoopHistogram = null;
  previousUtilization = undefined;
  if (eventLoopSampleTimer) clearInterval(eventLoopSampleTimer);
  eventLoopSampleTimer = undefined;
}

export function captureMainPerformanceSample(): void {
  const currentUtilization = performance.eventLoopUtilization();
  const utilization = previousUtilization
    ? performance.eventLoopUtilization(currentUtilization, previousUtilization)
    : currentUtilization;
  previousUtilization = currentUtilization;
  const maximumDelayMs = eventLoopHistogram ? eventLoopHistogram.max / 1_000_000 : 0;
  diagnostics.record({
    name: "main.event_loop_sample",
    durationMs: eventLoopHistogram ? eventLoopHistogram.percentile(99) / 1_000_000 : 0,
    count: utilization.utilization * 1_000_000,
    state: eventLoopHistogram ? "complete" : "unknown",
  });
  if (maximumDelayMs >= 50) {
    diagnostics.record({
      name: "main.long_task",
      durationMs: maximumDelayMs,
      state: "complete",
    });
  }
  eventLoopHistogram?.reset();
}

export function diagnosticSnapshot(): DiagnosticSnapshot {
  return diagnostics.snapshot();
}

export function parsePreviousPerformanceDiagnosticSession(
  value: unknown,
): PreviousPerformanceDiagnosticSessionV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const keys = new Set([
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
  ]);
  if (!exactOwnKeys(input, keys) || input.schemaVersion !== 1) return undefined;
  const safeStamp = (value: unknown): value is string =>
    typeof value === "string" && /^[a-zA-Z0-9._-]{1,128}$/u.test(value);
  if (!safeStamp(input.runId) || !safeStamp(input.scenario)) return undefined;
  const exactIsoTime = (candidate: unknown): candidate is string => {
    if (typeof candidate !== "string" || candidate.length !== 24) return false;
    try {
      return new Date(candidate).toISOString() === candidate;
    } catch {
      return false;
    }
  };
  if (!exactIsoTime(input.completedAt) || !exactIsoTime(input.sessionStartedAt)) {
    return undefined;
  }
  const numericKeys = [
    "shutdownDurationMs",
    "shutdownTimeouts",
    "shutdownFailures",
    "crashLoopEvents",
    "rendererProcessGoneEvents",
    "childProcessGoneEvents",
  ] as const;
  const shutdownDurationMs = boundedDiagnosticNumber(
    input.shutdownDurationMs,
    24 * 60 * 60 * 1_000,
  );
  if (
    shutdownDurationMs === undefined ||
    numericKeys
      .slice(1)
      .some((key) => !Number.isSafeInteger(input[key]) || (input[key] as number) < 0) ||
    (input.shutdownStatus !== "complete" && input.shutdownStatus !== "failed") ||
    (input.shutdownStatus === "complete" && input.shutdownFailures !== 0) ||
    (input.shutdownStatus === "failed" &&
      (!Number.isSafeInteger(input.shutdownFailures) || (input.shutdownFailures as number) < 1))
  )
    return undefined;
  return {
    schemaVersion: 1,
    runId: input.runId,
    scenario: input.scenario,
    completedAt: input.completedAt,
    sessionStartedAt: input.sessionStartedAt,
    shutdownDurationMs,
    shutdownTimeouts: input.shutdownTimeouts as number,
    shutdownFailures: input.shutdownFailures as number,
    shutdownStatus: input.shutdownStatus,
    crashLoopEvents: input.crashLoopEvents as number,
    rendererProcessGoneEvents: input.rendererProcessGoneEvents as number,
    childProcessGoneEvents: input.childProcessGoneEvents as number,
  };
}

async function loadPreviousPerformanceDiagnosticSession(
  userDataDirectory: string,
): Promise<PreviousPerformanceDiagnosticSessionV1 | undefined> {
  sessionSummaryPath = path.join(userDataDirectory, "performance-diagnostics-last-session.json");
  try {
    const handle = await fs.open(
      sessionSummaryPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 16 * 1024) return undefined;
      return parsePreviousPerformanceDiagnosticSession(
        JSON.parse(await handle.readFile("utf8")) as unknown,
      );
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

export async function configurePerformanceDiagnosticPersistence(
  userDataDirectory: string,
): Promise<void> {
  if (!performanceDiagnosticsEnabled) return;
  const authority = ++persistenceAuthority;
  if (process.platform === "darwin") {
    try {
      const systemVersion = await fs.readFile(
        "/System/Library/CoreServices/SystemVersion.plist",
        "utf8",
      );
      const productVersion = /<key>ProductVersion<\/key>\s*<string>([0-9.]+)<\/string>/u.exec(
        systemVersion,
      )?.[1];
      if (productVersion) cachedMacOSVersion = productVersion;
    } catch {
      // The kernel release remains a stable fallback.
    }
  }
  let loaded: PreviousPerformanceDiagnosticSessionV1 | undefined;
  const settled = await settleDiagnosticIoWithin(
    loadPreviousPerformanceDiagnosticSession(userDataDirectory).then((value) => {
      loaded = value;
    }),
  );
  if (authority !== persistenceAuthority) return;
  if (!settled) {
    persistenceAuthority += 1;
    previousSession = undefined;
  } else {
    previousSession = loaded;
  }
}

async function persistPerformanceDiagnosticSessionFile(
  shutdownDurationMs: number,
  shutdownStatus: "complete" | "failed",
  shutdownFailures: number,
  authority: number,
): Promise<void> {
  if (!sessionSummaryPath) return;
  const snapshot = diagnostics.snapshot();
  const count = (name: DiagnosticEventInput["name"]) =>
    snapshot.events.filter((event) => event.name === name).length;
  const summary: PreviousPerformanceDiagnosticSessionV1 = {
    schemaVersion: 1,
    runId:
      process.env.AIDEN_BENCHMARK_RUN_ID &&
      /^[a-zA-Z0-9._-]{1,128}$/u.test(process.env.AIDEN_BENCHMARK_RUN_ID)
        ? process.env.AIDEN_BENCHMARK_RUN_ID
        : "unavailable",
    scenario:
      process.env.AIDEN_BENCHMARK_SCENARIO &&
      /^[a-zA-Z0-9._-]{1,128}$/u.test(process.env.AIDEN_BENCHMARK_SCENARIO)
        ? process.env.AIDEN_BENCHMARK_SCENARIO
        : "unavailable",
    completedAt: new Date().toISOString(),
    sessionStartedAt: snapshot.sessionStartedAt,
    shutdownDurationMs: Math.min(Math.max(0, shutdownDurationMs), 24 * 60 * 60 * 1_000),
    shutdownTimeouts: count("shutdown.timeout"),
    shutdownFailures: Math.min(Math.max(0, Math.trunc(shutdownFailures)), 1_000_000),
    shutdownStatus,
    crashLoopEvents: snapshot.events.filter(
      (event) => event.name === "crash_loop.state" && event.state === "active",
    ).length,
    rendererProcessGoneEvents: count("renderer.process_gone"),
    childProcessGoneEvents: count("child.process_gone"),
  };
  const serialized = `${JSON.stringify(summary)}\n`;
  const destination = sessionSummaryPath;
  const directory = path.dirname(destination);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let handle: fs.FileHandle | undefined;
  try {
    await fs.mkdir(directory, { recursive: true });
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    const installedIdentity = await handle.stat({ bigint: true });
    await handle.close();
    handle = undefined;
    if (authority !== persistenceAuthority) {
      await fs.unlink(temporary).catch(() => {});
      return;
    }
    await fs.rename(temporary, destination);
    if (authority !== persistenceAuthority) {
      try {
        const current = await fs.lstat(destination, { bigint: true });
        if (current.dev === installedIdentity.dev && current.ino === installedIdentity.ino) {
          await fs.unlink(destination);
        }
      } catch {
        // A newer authority already replaced or removed this stale summary.
      }
      return;
    }
    try {
      const directoryHandle = await fs.open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // The summary is already installed and remains useful after a normal restart.
    }
    if (authority !== persistenceAuthority) {
      try {
        const current = await fs.lstat(destination, { bigint: true });
        if (current.dev === installedIdentity.dev && current.ino === installedIdentity.ino) {
          await fs.unlink(destination);
        }
      } catch {
        // A newer authority already replaced or removed this stale summary.
      }
      return;
    }
    if (authority === persistenceAuthority) previousSession = summary;
  } catch {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

export async function persistPerformanceDiagnosticSession(
  shutdownDurationMs: number,
  shutdownStatus: "complete" | "failed" = "complete",
  shutdownFailures = 0,
): Promise<void> {
  if (!performanceDiagnosticsEnabled) return;
  const authority = ++persistenceAuthority;
  const settled = await settleDiagnosticIoWithin(
    persistPerformanceDiagnosticSessionFile(
      shutdownDurationMs,
      shutdownStatus,
      shutdownFailures,
      authority,
    ),
  );
  if (!settled) {
    if (authority === persistenceAuthority) persistenceAuthority += 1;
    recordDiagnosticEvent({ name: "shutdown.timeout", state: "failed" });
  }
}

export function diagnosticMetadata(input: {
  appVersion: string;
  buildMode: string;
  powerSource?: "ac" | "battery" | "unknown";
  scenario?: string;
}): PerformanceDiagnosticMetadata {
  const embedded = embeddedPerformanceBuildIdentity();
  const cpu = os
    .cpus()[0]
    ?.model.replace(/[^a-zA-Z0-9 ._()-]/gu, "")
    .slice(0, 120);
  const safeStamp = (value: string | undefined): string =>
    value && /^[a-zA-Z0-9._-]{1,128}$/u.test(value) ? value : "unavailable";
  return {
    runId: safeStamp(process.env.AIDEN_BENCHMARK_RUN_ID),
    commit: safeStamp(embedded.commit),
    dirtyStateHash: safeStamp(embedded.dirtyStateHash),
    buildMode: safeStamp(embedded.buildMode || input.buildMode),
    profilingBuild: embedded.profilingBuild,
    appVersion: safeStamp(input.appVersion),
    electronVersion: safeStamp(process.versions.electron),
    nodeVersion: safeStamp(process.versions.node),
    platform: safeStamp(process.platform),
    architecture: safeStamp(process.arch),
    macOSVersion: safeStamp(cachedMacOSVersion),
    hardware: cpu || "unavailable",
    logicalCpuCount: os.cpus().length,
    memoryBytes: os.totalmem(),
    powerSource: input.powerSource ?? "unknown",
    scenario: safeStamp(input.scenario ?? process.env.AIDEN_BENCHMARK_SCENARIO),
  };
}

export async function writePerformanceDiagnosticExport(
  destination: string,
  metadata: PerformanceDiagnosticMetadata,
): Promise<void> {
  captureMainPerformanceSample();
  const payload: PerformanceDiagnosticExportV1 = {
    schemaVersion: 1,
    exportId: randomUUID(),
    metadata,
    diagnostics: diagnostics.snapshot(),
    ...(previousSession ? { previousSession } : {}),
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024) {
    throw new Error("Performance diagnostics exceed the export limit.");
  }
  const directory = path.dirname(destination);
  const temporary = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, destination);
    try {
      const directoryHandle = await fs.open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // The exact report is already installed. Treat a directory-sync failure
      // as committed so a retry cannot create a misleading duplicate export.
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

if (performanceDiagnosticsEnabled) startEventLoopDiagnostics();
if (performanceDiagnosticsEnabled) {
  process.on("uncaughtExceptionMonitor", () => {
    recordDiagnosticEvent({ name: "process.error", state: "failed" });
  });
}
