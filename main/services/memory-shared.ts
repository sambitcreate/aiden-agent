// Shared memory identity between the desktop app and the Aiden CLI.
//
// Both surfaces open the same database at `~/.aiden/memory/memory-v1.sqlite`
// (the portable Aiden root from aiden-config-dir.ts) and scope workspace
// memories by a hash of the canonical folder path rather than a
// surface-local workspace id, so a fact remembered in the terminal is
// recalled by the desktop and vice versa.
//
// Migration is handled by MemoryStore's `imports`/`scopeAliases` options:
// legacy per-surface databases are copied forward (never moved), and rows
// keyed by the old scope ids are duplicated into the shared scope. Legacy
// rows are intentionally retained so a downgraded surface still sees its own
// history — see docs/plans/aiden-cli-plan.md for the full contract.

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// `.ts` (not the repo's usual `.js`) so this module also loads under Node's
// --experimental-strip-types, which the CLI extension tests eval directly.
import { aidenConfigDir } from "./aiden-config-dir.ts";

/** Canonical folder key shared by desktop and CLI scope derivation. */
export function canonicalWorkspacePath(folderPath: string): string {
  try {
    return realpathSync(folderPath);
  } catch {
    return path.resolve(folderPath);
  }
}

/**
 * The shared workspace scope id: `ws-<sha256(canonical folder).slice(0,24)>`.
 * Matches the memory-store SAFE_ID charset and stays stable across surfaces.
 */
export function sharedWorkspaceScopeId(folderPath: string): string {
  return `ws-${createHash("sha256").update(canonicalWorkspacePath(folderPath)).digest("hex").slice(0, 24)}`;
}

/**
 * The legacy CLI scope id for a workspace folder (`cli-<sha256(raw path)>`),
 * kept so the shared store can absorb facts written before the scope ids
 * unified. Both the raw and canonicalized hash are mapped by callers.
 */
export function legacyCliWorkspaceScopeId(workspaceRoot: string): string {
  return `cli-${createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 24)}`;
}

/**
 * Where the shared memory database lives.
 *
 * - Desktop: `<aidenConfigDir>/memory` (defaults to `~/.aiden/memory`).
 * - CLI: the same when the agent dir is the default `~/.aiden/agent` or when
 *   `AIDEN_CONFIG_DIR` is set; otherwise `<agentDir>/shared-memory` so
 *   sandboxed/test agent dirs never touch the real shared database.
 */
export function sharedMemoryRoot(agentDir?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.AIDEN_CONFIG_DIR?.trim()) return path.join(aidenConfigDir(env), "memory");
  const home = path.join(os.homedir(), ".aiden");
  if (agentDir === undefined) return path.join(home, "memory");
  // Compare realpath'd so a symlinked default agent dir (or a custom agentDir
  // pointing at it) still resolves to the shared root, and a relative env
  // override cannot produce a cwd-dependent memory location.
  const realpath = (file: string): string => {
    try {
      return realpathSync.native(file);
    } catch {
      return path.resolve(file);
    }
  };
  const canonical = realpath(path.resolve(agentDir));
  const defaultAgent = realpath(path.join(home, "agent"));
  if (canonical === defaultAgent || path.resolve(agentDir) === path.join(home, "agent")) {
    return path.join(home, "memory");
  }
  return path.join(canonical, "shared-memory");
}
