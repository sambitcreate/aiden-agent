import { writeDevLog, writeDevLogSync } from "./dev-log.js";

type DiagnosticSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

interface DiagnosticProcess {
  readonly arch: string;
  readonly pid: number;
  readonly platform: NodeJS.Platform;
  readonly ppid: number;
  readonly version: string;
  readonly versions: NodeJS.ProcessVersions;
  cwd(): string;
  kill(pid: number, signal: DiagnosticSignal): boolean;
  memoryUsage(): NodeJS.MemoryUsage;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  removeListener(event: string, listener: (...args: any[]) => void): this;
  uptime(): number;
}

const SIGNALS: readonly DiagnosticSignal[] = ["SIGHUP", "SIGINT", "SIGTERM"];
const installedProcesses = new WeakSet<object>();

export function processDiagnosticSnapshot(target: DiagnosticProcess = process): Record<string, unknown> {
  const memory = target.memoryUsage();
  return {
    pid: target.pid,
    ppid: target.ppid,
    platform: target.platform,
    arch: target.arch,
    node: target.version,
    electron: target.versions.electron ?? null,
    chrome: target.versions.chrome ?? null,
    cwd: target.cwd(),
    uptimeSeconds: Number(target.uptime().toFixed(3)),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
  };
}

function safeProcessDiagnosticSnapshot(target: DiagnosticProcess): Record<string, unknown> {
  try {
    return processDiagnosticSnapshot(target);
  } catch (error) {
    return {
      pid: target.pid,
      ppid: target.ppid,
      snapshotError: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Install behavior-preserving process diagnostics for development runs. */
export function installProcessDiagnostics(target: DiagnosticProcess = process): void {
  if (installedProcesses.has(target)) return;
  installedProcesses.add(target);

  writeDevLog("info", "process", [
    "Process diagnostics installed",
    safeProcessDiagnosticSnapshot(target),
  ]);

  target.on("uncaughtExceptionMonitor", (error: unknown, origin: unknown) => {
    writeDevLogSync("error", "process", [
      "Uncaught exception",
      { origin, ...safeProcessDiagnosticSnapshot(target) },
      error,
    ]);
  });
  target.on("warning", (warning: unknown) => {
    writeDevLog("warn", "process", ["Node warning", warning]);
  });
  target.on("exit", (code: unknown) => {
    writeDevLogSync("info", "process", [
      "Process exit",
      { code, ...safeProcessDiagnosticSnapshot(target) },
    ]);
  });

  for (const signal of SIGNALS) {
    const handler = () => {
      writeDevLogSync("warn", "process", [
        "Process signal received",
        { signal, ...safeProcessDiagnosticSnapshot(target) },
      ]);
      // Preserve Node/Electron's native signal semantics after recording the event.
      target.removeListener(signal, handler);
      target.kill(target.pid, signal);
    };
    target.once(signal, handler);
  }
}
