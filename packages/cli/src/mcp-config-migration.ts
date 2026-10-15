import { closeSync, fsyncSync, linkSync, mkdtempSync, openSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { acquireLease, atomicJson, readJson } from "./state.ts";

function syncDirectory(path: string): void {
  const directory = openSync(path, "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/**
 * Read the native file only to recognise a legacy Aiden array. Anything else
 * (absent, a native pi object, unreadable, or malformed) belongs to pi and must
 * never block Aiden: an unusable file is skipped with a one-line warning.
 */
function readLegacySource(legacy: string): { bytes: Buffer; servers: unknown[] } | undefined {
  let bytes: Buffer;
  try { bytes = readFileSync(legacy); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") process.stderr.write(`aiden: skipped MCP migration; ${legacy} is unreadable (${(error as NodeJS.ErrnoException).code ?? "error"}).\n`);
    return undefined;
  }
  let data: unknown;
  try { data = JSON.parse(bytes.toString("utf8")); }
  catch { process.stderr.write(`aiden: skipped MCP migration; ${legacy} is not valid JSON.\n`); return undefined; }
  return Array.isArray(data) ? { bytes, servers: data } : undefined;
}

/** Keep Aiden's server IDs and encrypted credentials separate from native pi MCP. */
export function migrateAidenMcpConfig(
  agentDir: string,
  validate: (server: unknown) => unknown,
  claimSource: typeof renameSync = renameSync,
): void {
  const legacy = join(agentDir, "mcp.json");
  const destination = join(agentDir, "aiden-mcp.json");
  // Startup and the first store construction in each process run this, so the
  // no-op paths (no legacy file, or a native pi config object) stay lock-free: a read must not contend with,
  // or throw beside, another process's writer. Anything else is re-read and
  // validated under the lease below.
  if (!readLegacySource(legacy)) return;
  const release = acquireLease(destination);
  try {
    // Parse, validate and back up the same snapshot, never two different reads.
    const source = readLegacySource(legacy);
    if (!source) return;
    const { bytes, servers: data } = source;
    data.forEach(validate);
    const existing = readJson<unknown>(destination, undefined);
    if (existing !== undefined && !isDeepStrictEqual(existing, data)) {
      throw new Error("Both mcp.json and aiden-mcp.json contain Aiden servers. Reconcile them before continuing; neither file was changed.");
    }
    const backup = join(agentDir, "mcp.pre-pi-1.json");
    try {
      const fd = openSync(backup, "wx", 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !readFileSync(backup).equals(bytes)) throw error;
    }
    // Publish first: a crash while retiring the source must not lose Aiden's inventory.
    if (existing === undefined) atomicJson(destination, data);
    const recoveryDir = mkdtempSync(join(agentDir, ".mcp-migration-"));
    const claimed = join(recoveryDir, "mcp.json");
    try { claimSource(legacy, claimed); }
    catch (error) { rmdirSync(recoveryDir); throw error; }
    try {
      syncDirectory(recoveryDir);
      syncDirectory(agentDir);
      if (!readFileSync(claimed).equals(bytes)) throw new Error("MCP configuration changed during migration.");
      // Keep the retired inode: a writer that opened it before the rename can
      // still change it. Never unlink the live pathname or discard those bytes.
    } catch (error) {
      // Exclusive link publication restores the claimed source only if no new
      // native config exists. Preserve both files when another writer won.
      try { linkSync(claimed, legacy); syncDirectory(agentDir); }
      catch (restoreError) {
        if ((restoreError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new Error(`MCP migration needs reconciliation; the source is preserved at ${claimed}. ${String(restoreError)}`);
        }
      }
      throw new Error(`MCP configuration changed during migration. Reconcile ${legacy} and the preserved source at ${claimed} before continuing. ${String(error)}`);
    }
  } finally { release(); }
}
