/**
 * Pure helpers for the memory extension (no desktop runtime imports beyond the
 * settings module), kept unit-testable under Node's TypeScript stripping.
 */

import { canonicalWorkspacePath, legacyCliWorkspaceScopeId, sharedWorkspaceScopeId } from "../../../../main/services/memory-shared.ts";
import { readAidenSettings } from "./aiden-settings.ts";

/**
 * Workspace memory scope = the shared `ws-<folder hash>` both surfaces use, so
 * facts remembered in the terminal are recalled by the desktop (and the
 * reverse) through the shared `~/.aiden/memory` database.
 */
export function workspaceScopeId(workspaceRoot: string): string {
	return sharedWorkspaceScopeId(workspaceRoot);
}

/** Scope ids the CLI used before sharing, absorbed into the shared scope. */
export function legacyWorkspaceScopeIds(workspaceRoot: string): Record<string, string> {
	const target = sharedWorkspaceScopeId(workspaceRoot);
	return {
		[legacyCliWorkspaceScopeId(workspaceRoot)]: target,
		[legacyCliWorkspaceScopeId(canonicalWorkspacePath(workspaceRoot))]: target,
	};
}

export function memoryEnabledFor(agentDir: string): boolean {
	return readAidenSettings(agentDir).memoryEnabled !== false;
}
