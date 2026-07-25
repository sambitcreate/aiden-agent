// Resolves Aiden's portable user config directory, `~/.aiden`.
//
// This folder belongs to the user and is meant to be edited by hand. It holds
// `config.json` (portable providers, MCP servers, and skills) alongside the
// `skill/`, `skills/`, and `scripts/` roots that skills-discovery.ts and
// schedule-script.ts already read. Machine-local state — secrets, discovery
// caches, chats, and UI preferences — stays in Electron's userData directory.

import * as os from "os";
import * as path from "path";

/** Redirects the portable config root. Used by tests and sandboxed dev runs. */
export const AIDEN_CONFIG_DIR_ENV = "AIDEN_CONFIG_DIR";

/** Basename of the portable root inside a home or workspace directory. */
export const AIDEN_DIR_NAME = ".aiden";

/**
 * The portable config root: `$AIDEN_CONFIG_DIR`, else `~/.aiden`.
 *
 * A relative override is rejected rather than resolved against `process.cwd()` —
 * the working directory of a packaged Electron app is not something the person
 * setting the variable can predict, so silently accepting one would scatter
 * config folders wherever the app happened to launch from.
 */
export function aidenConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[AIDEN_CONFIG_DIR_ENV]?.trim();
  if (!override) return path.join(os.homedir(), AIDEN_DIR_NAME);
  if (!path.isAbsolute(override)) {
    throw new Error(
      `${AIDEN_CONFIG_DIR_ENV} must be an absolute path; received ${JSON.stringify(override)}.`,
    );
  }
  // Already known absolute, so resolve() cannot reach for cwd. It is used over
  // normalize() because it also drops a trailing separator, which would
  // otherwise make "/x" and "/x/" two distinct cache and comparison keys.
  return path.resolve(override);
}
