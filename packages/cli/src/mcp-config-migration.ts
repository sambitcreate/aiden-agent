import { closeSync, fsyncSync, linkSync, mkdtempSync, openSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { acquireLease, atomicJson, readJson } from "./state.ts";

function syncDirectory(path: string): void {
  const directory = openSync(path, "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/** Keep Aiden's server IDs and encrypted credentials separate from native pi MCP. */
export function migrateAidenMcpConfig(
  agentDir: string,
  validate: (server: unknown) => unknown,
  claimSource: typeof renameSync = renameSync,
): void {
  const legacy = join(agentDir, "mcp.json");
  const destination = join(agentDir, "aiden-mcp.json");
  const release = acquireLease(destination);
  try {
    let bytes: Buffer;
    try { bytes = readFileSync(legacy); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    // Parse, validate and back up the same snapshot, never two different reads.
    const data: unknown = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(data)) return;
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
