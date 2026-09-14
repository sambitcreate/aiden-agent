/**
 * Desktop-shared Agent Skills injection (parity with
 * main/services/skills-discovery.ts priority: ~/.aiden > ~/.claude >
 * ~/.agents, plus the workspace's .claude).
 *
 * pi natively discovers ~/.aiden/agent/skills, <cwd>/.aiden/skills, and walks
 * up `.agents/skills` from the cwd — so ~/.agents is treated as RESERVED
 * (claimed by pi, never injected) and the remaining folders are injected
 * per-skill-directory, skipping any skill name already claimed. Injection is
 * per skill directory (each containing SKILL.md) so a name collision only
 * drops that one skill instead of the whole folder.
 *
 * Pure module (node builtins only) so it is testable under Node's TypeScript
 * stripping.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function desktopSkillInjectionPaths(home: string, cwd: string): string[] {
	// Skills pi already discovers on its own; injecting these again would
	// produce duplicate-name conflicts at startup.
	const nativeRoots = [join(home, ".agents", "skills")];
	const injectRoots = [
		join(home, ".aiden", "skills"),
		join(home, ".claude", "skills"),
		join(cwd, ".claude", "skills"),
	];

	const claimed = new Set<string>();
	const claimNames = (root: string): void => {
		if (!existsSync(root)) return;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (entry.isDirectory()) claimed.add(entry.name);
		}
	};
	for (const root of nativeRoots) claimNames(root);

	const out: string[] = [];
	for (const root of injectRoots) {
		if (!existsSync(root)) continue;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (claimed.has(entry.name)) continue;
			const skillDir = join(root, entry.name);
			if (!existsSync(join(skillDir, "SKILL.md"))) continue;
			claimed.add(entry.name);
			out.push(skillDir);
		}
	}
	return out;
}
