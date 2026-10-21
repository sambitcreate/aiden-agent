/**
 * Desktop-shared Agent Skills discovery (parity with
 * main/services/skills-discovery.ts priority: ~/.aiden > ~/.claude >
 * ~/.agents, plus the workspace's .claude).
 *
 * pi natively discovers ~/.aiden/agent/skills, <cwd>/.aiden/skills, and walks
 * up `.agents/skills` from the cwd — so ~/.agents is treated as RESERVED
 * (claimed by pi, never injected) and the remaining folders are discovered
 * per-skill-directory, skipping any skill name already claimed. Discovery is
 * per skill directory (each containing SKILL.md) so a name collision only
 * drops that one skill instead of the whole folder.
 *
 * Pure module (node builtins only) so it is testable under Node's TypeScript
 * stripping.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export type DesktopSkillPath = { path: string; scope: "user" | "project"; baseDir: string };

let additionalSkillDirectories: string[] = [];

export function hasAdditionalSkillDirectories(): boolean {
	return additionalSkillDirectories.length > 0;
}

/** Consume only Aiden's repeated --add-dir option before forwarding arguments to Pi. */
export function configureAdditionalSkillDirectories(argv: string[], launchCwd: string): string[] {
	const rest: string[] = [];
	const directories: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") { rest.push(...argv.slice(index)); break; }
		if (arg !== "--add-dir" && !arg.startsWith("--add-dir=")) { rest.push(arg); continue; }
		const directory = arg === "--add-dir" ? argv[++index] : arg.slice("--add-dir=".length);
		if (!directory || directory.startsWith("-")) throw new Error("--add-dir requires a directory path.");
		directories.push(resolve(launchCwd, directory));
	}
	if (directories.length > 32) throw new Error("--add-dir accepts at most 32 directories.");
	additionalSkillDirectories = [...new Set(directories)];
	return rest;
}

export function desktopSkillDiscoveryPaths(home: string, cwd: string, projectTrusted: boolean, additionalDirectories: readonly string[] = additionalSkillDirectories): DesktopSkillPath[] {
	// Skills pi already discovers on its own; adding these again would
	// produce duplicate-name conflicts at startup.
	const nativeRoots = [join(home, ".agents", "skills")];
	const discoveryRoots: Array<{ path: string; scope: "user" | "project" }> = [
		{ path: join(home, ".aiden", "skills"), scope: "user" },
		{ path: join(home, ".claude", "skills"), scope: "user" },
		...(projectTrusted ? [
			{ path: join(cwd, ".claude", "skills"), scope: "project" as const },
			...additionalDirectories.flatMap((directory) => [
				{ path: join(directory, ".aiden", "skills"), scope: "project" as const },
				{ path: join(directory, ".claude", "skills"), scope: "project" as const },
				{ path: join(directory, ".agents", "skills"), scope: "project" as const },
			]),
		] : []),
	];

	const claimed = new Set<string>();
	const claimNames = (root: string): void => {
		if (!existsSync(root)) return;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (entry.isDirectory()) claimed.add(entry.name);
		}
	};
	for (const root of nativeRoots) claimNames(root);

	const out: DesktopSkillPath[] = [];
	for (const { path: root, scope } of discoveryRoots) {
		if (!existsSync(root)) continue;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (claimed.has(entry.name)) continue;
			const skillDir = join(root, entry.name);
			if (!existsSync(join(skillDir, "SKILL.md"))) continue;
			claimed.add(entry.name);
			out.push({ path: skillDir, scope, baseDir: root });
		}
	}
	return out;
}
