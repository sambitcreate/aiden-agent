import { projectDiagnosticError, type DiagnosticSafeFields } from "./diagnostics-contract.js";
import { writeDiagnosticEvent, writeDiagnosticEventSync } from "./diagnostic-journal.js";

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

function journalProcessFields(target: DiagnosticProcess): DiagnosticSafeFields {
  try {
    const memory = target.memoryUsage();
    return {
      pid: target.pid,
      ppid: target.ppid,
      platform: target.platform,
      arch: target.arch,
      nodeVersion: target.version,
      electronVersion: target.versions.electron ?? null,
      chromeVersion: target.versions.chrome ?? null,
      uptimeSeconds: Number(target.uptime().toFixed(3)),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
    };
  } catch {
    return { pid: target.pid, ppid: target.ppid, snapshotFailed: true };
  }
}

/** Install behavior-preserving process diagnostics for development runs. */
export function installProcessDiagnostics(target: DiagnosticProcess = process): void {
  if (installedProcesses.has(target)) return;
  installedProcesses.add(target);

  writeDiagnosticEvent({
    level: "info",
    area: "diagnostics",
    event: "process-monitor-installed",
    outcome: "completed",
    fields: journalProcessFields(target),
  });

  target.on("uncaughtExceptionMonitor", (error: unknown, origin: unknown) => {
    const projected = projectDiagnosticError(error);
    writeDiagnosticEventSync({
      level: "fatal",
      area: "app",
      event: "uncaught-exception",
      outcome: "failed",
      code: projected.code,
      fields: {
        ...journalProcessFields(target),
        origin: typeof origin === "string" ? origin : "unknown",
        errorType: projected.errorType,
        fingerprint: projected.fingerprint ?? null,
      },
    });
  });
  target.on("warning", (warning: unknown) => {
    const projected = projectDiagnosticError(warning);
    writeDiagnosticEvent({
      level: "warn",
      area: "app",
      event: "node-warning",
      outcome: "degraded",
      code: projected.code,
      fields: {
        errorType: projected.errorType,
        fingerprint: projected.fingerprint ?? null,
      },
    });
  });
  target.on("exit", (code: unknown) => {
    writeDiagnosticEventSync({
      level: "info",
      area: "app",
      event: "process-exit",
      outcome: "completed",
      fields: {
        ...journalProcessFields(target),
        exitCode: typeof code === "number" ? code : null,
      },
    });
  });

  for (const signal of SIGNALS) {
    const handler = () => {
      writeDiagnosticEventSync({
        level: "warn",
        area: "app",
        event: "process-signal",
        outcome: "cancelled",
        fields: { ...journalProcessFields(target), signal },
      });
      // Preserve Node/Electron's native signal semantics after recording the event.
      target.removeListener(signal, handler);
      target.kill(target.pid, signal);
    };
    target.once(signal, handler);
  }
}
