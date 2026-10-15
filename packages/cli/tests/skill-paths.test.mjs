import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const pkgDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";

function makeSkill(root, name) {
	mkdirSync(path.join(root, name), { recursive: true });
	writeFileSync(path.join(root, name, "SKILL.md"), `---\nname: ${name}\n---\nbody\n`);
}

test("skill injection follows desktop priority, dedupes, and reserves native coverage", async () => {
	const { desktopSkillDiscoveryPaths } = await import(pathToFileURL(path.join(pkgDir, "src", "skill-paths.ts")));
	const home = mkdtempSync(path.join(tmpdir(), "aiden-cli-skills-"));
	const cwd = mkdtempSync(path.join(tmpdir(), "aiden-cli-cwd-"));
	try {
		// ~/.agents/skills is pi-native (walk-up): reserved, never injected.
		makeSkill(path.join(home, ".agents", "skills"), "native-only");
		makeSkill(path.join(home, ".agents", "skills"), "shared");
		// Priority: .aiden wins over .claude for the same name.
		makeSkill(path.join(home, ".aiden", "skills"), "shared");
		makeSkill(path.join(home, ".aiden", "skills"), "aiden-unique");
		// .claude keeps its unique skill but drops the .aiden-colliding one.
		makeSkill(path.join(home, ".claude", "skills"), "shared");
		makeSkill(path.join(home, ".claude", "skills"), "claude-unique");
		// Workspace .claude skill with a fresh name is injected.
		makeSkill(path.join(cwd, ".claude", "skills"), "workspace-unique");

		const injected = desktopSkillDiscoveryPaths(home, cwd, true);
		const names = injected.map((entry) => path.basename(entry.path));
		assert.deepEqual(names.sort(), ["aiden-unique", "claude-unique", "workspace-unique"].sort());
		assert.ok(!names.includes("native-only"), "pi-native skill must not be re-injected");
		assert.ok(!names.includes("shared"), "colliding name must be injected exactly once (by priority)");
		assert.equal(injected.find((entry) => path.basename(entry.path) === "workspace-unique")?.scope, "project");
		assert.ok(injected.filter((entry) => entry.scope === "user").every((entry) => entry.path.startsWith(home)));
		assert.deepEqual(desktopSkillDiscoveryPaths(home, cwd, false).map((entry) => path.basename(entry.path)).sort(), ["aiden-unique", "claude-unique"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("skill injection is empty when no desktop folders exist", async () => {
	const { desktopSkillDiscoveryPaths } = await import(pathToFileURL(path.join(pkgDir, "src", "skill-paths.ts")));
	const home = mkdtempSync(path.join(tmpdir(), "aiden-cli-skills-"));
	const cwd = mkdtempSync(path.join(tmpdir(), "aiden-cli-cwd-"));
	try {
		assert.deepEqual(desktopSkillDiscoveryPaths(home, cwd, true), []);
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a home-directory launch keeps home skill roots in user scope", async () => {
	const { desktopSkillDiscoveryPaths } = await import(pathToFileURL(path.join(pkgDir, "src", "skill-paths.ts")));
	const home = mkdtempSync(path.join(tmpdir(), "aiden-cli-home-"));
	try {
		makeSkill(path.join(home, ".claude", "skills"), "home-probe");
		assert.deepEqual(desktopSkillDiscoveryPaths(home, home, false).map(({ scope }) => scope), ["user"]);
		assert.equal(desktopSkillDiscoveryPaths(home, home, true).length, 1);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
