// Development file logger. Initialized with a file path only in unpackaged
// (dev) runs; every platform logger call is mirrored to the file, and the
// renderer forwards uncaught errors over the devlog:write IPC channel.
// Logging must never break the app: writes are serialized on a queue and all
// failures are swallowed. Kept Electron-free so it stays unit-testable.

import * as fs from "fs/promises";
import * as path from "path";

/** Rotate the current log aside once it grows past ~2 MB. */
const MAX_BYTES = 2 * 1024 * 1024;
/** Cap a single rendered line so a huge object cannot flood the file. */
const MAX_LINE = 4096;

let filePath: string | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Start writing to `targetPath`, rotating an oversized previous log aside. */
export function initDevLog(targetPath: string): void {
  filePath = targetPath;
  queue = queue.then(async () => {
    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const stat = await fs.stat(targetPath).catch(() => null);
      if (stat && stat.size > MAX_BYTES) {
        await fs.rename(targetPath, targetPath.replace(/\.log$/, ".prev.log")).catch(() => {});
      }
      await fs.appendFile(targetPath, `\n── session ${new Date().toISOString()} ──\n`, "utf8");
    } catch {
      // Logging must never crash the app.
    }
  });
}

export function devLogPath(): string | null {
  return filePath;
}

function format(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function redactDevLogSecrets(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[^\s"',;]+/gi, "$1[REDACTED]")
    .replace(
      /(["']?(?:access_token|refresh_token|client_secret|api[_-]?key|x-consumer-api-key)["']?\s*[:=]\s*["']?)[^"',}\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
}

/** Append one line; no-op until initDevLog has run. */
export function writeDevLog(level: "debug" | "info" | "warn" | "error", scope: string, values: unknown[]): void {
  if (!filePath) return;
  const target = filePath;
  const rendered = redactDevLogSecrets(values.map(format).join(" "));
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${rendered}`.slice(0, MAX_LINE) + "\n";
  queue = queue.then(() => fs.appendFile(target, line, "utf8")).catch(() => {});
}

/** Resolve once every queued write has landed. Used by tests. */
export async function flushDevLog(): Promise<void> {
  await queue;
}
