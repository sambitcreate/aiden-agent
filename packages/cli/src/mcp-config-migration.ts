import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { acquireLease, atomicJson, readJson } from "./state.ts";

/** Keep Aiden's server IDs and encrypted credentials separate from native pi MCP. */
export function migrateAidenMcpConfig(agentDir: string, validate: (server: unknown) => unknown): void {
  const legacy = join(agentDir, "mcp.json");
  const destination = join(agentDir, "aiden-mcp.json");
  const initial = readJson<unknown>(legacy, undefined);
  if (!Array.isArray(initial)) return;
  const release = acquireLease(destination);
  try {
    // Re-read after acquiring the lease: another Aiden process may have migrated it.
    const data = readJson<unknown>(legacy, undefined);
    if (!Array.isArray(data)) return;
    data.forEach(validate);
    const bytes = readFileSync(legacy);
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
    if (existing === undefined) atomicJson(destination, data);
    // Preserve a native config written by another process rather than removing it.
    if (!readFileSync(legacy).equals(bytes)) throw new Error("MCP configuration changed during migration. Restart Aiden to reconcile it.");
    unlinkSync(legacy);
    const directory = openSync(agentDir, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { release(); }
}
