/**
 * Pure helpers for the memory extension (no desktop runtime imports beyond the
 * settings module), kept unit-testable under Node's TypeScript stripping.
 */

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { canonicalWorkspacePath, legacyCliWorkspaceScopeId, sharedWorkspaceScopeId } from "../../../../main/services/memory-shared.ts";
import { readJson } from "../state.ts";
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

interface CliWorkspaceEntry { folderPath?: string; memoryEnabled?: boolean }

function workspaceEntries(agentDir: string): CliWorkspaceEntry[] {
	try {
		const parsed = readJson<unknown>(join(agentDir, "workspaces.json"), []);
		return Array.isArray(parsed) ? (parsed as CliWorkspaceEntry[]) : [];
	} catch {
		return [];
	}
}

/**
 * Strict read for the per-workspace memory gate: a corrupt or mis-shaped
 * workspaces.json cannot prove memory is allowed, so fail closed (a missing
 * file still defaults on — new workspaces have no entry to find anyway).
 */
function workspaceEntriesStrict(agentDir: string): CliWorkspaceEntry[] | undefined {
	try {
		const parsed = readJson<unknown>(join(agentDir, "workspaces.json"), []);
		return Array.isArray(parsed) ? (parsed as CliWorkspaceEntry[]) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Legacy-scope remap covering every registered workspace — not just the
 * current cwd — so facts the old CLI wrote in other folders are absorbed into
 * their canonical `ws-` scopes instead of being orphaned under `cli-*` ids
 * nothing queries anymore.
 */
export function legacyWorkspaceScopeIdMap(agentDir: string, workspaceRoot: string): Record<string, string> {
	const map = legacyWorkspaceScopeIds(workspaceRoot);
	for (const entry of workspaceEntries(agentDir)) {
		const folder = entry.folderPath;
		if (!folder || map[legacyCliWorkspaceScopeId(folder)]) continue;
		const target = sharedWorkspaceScopeId(folder);
		map[legacyCliWorkspaceScopeId(folder)] ??= target;
		map[legacyCliWorkspaceScopeId(canonicalWorkspacePath(folder))] ??= target;
	}
	return map;
}

/**
 * Memory is enabled only when both the global CLI flag and — when the folder
 * is a registered workspace — the per-workspace flag allow it, matching the
 * desktop's memoryEnabledForChat two-level gate.
 */
export function memoryEnabledFor(agentDir: string, workspaceRoot?: string): boolean {
	if (readAidenSettings(agentDir).memoryEnabled === false) return false;
	if (!workspaceRoot) return true;
	let canonical: string;
	try {
		canonical = realpathSync(workspaceRoot);
	} catch {
		canonical = workspaceRoot;
	}
	const entries = workspaceEntriesStrict(agentDir);
	if (!entries) return false;
	const entry = entries.find((item) => {
		if (!item.folderPath) return false;
		try { return realpathSync(item.folderPath) === canonical; } catch { return item.folderPath === workspaceRoot; }
	});
	return entry?.memoryEnabled !== false;
}
