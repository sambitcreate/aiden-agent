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
import { join } from "node:path";

export type DesktopSkillPath = { path: string; scope: "user" | "project"; baseDir: string };

export function desktopSkillDiscoveryPaths(home: string, cwd: string, projectTrusted: boolean): DesktopSkillPath[] {
	// Skills pi already discovers on its own; adding these again would
	// produce duplicate-name conflicts at startup.
	const nativeRoots = [join(home, ".agents", "skills")];
	const discoveryRoots: Array<{ path: string; scope: "user" | "project" }> = [
		{ path: join(home, ".aiden", "skills"), scope: "user" },
		{ path: join(home, ".claude", "skills"), scope: "user" },
		...(projectTrusted ? [{ path: join(cwd, ".claude", "skills"), scope: "project" as const }] : []),
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
