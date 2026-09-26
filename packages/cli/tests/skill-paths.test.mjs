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
	const { desktopSkillInjectionPaths } = await import(pathToFileURL(path.join(pkgDir, "src", "skill-paths.ts")));
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

		const injected = desktopSkillInjectionPaths(home, cwd);
		const names = injected.map((dir) => path.basename(path.dirname(dir)) === "skills" ? path.basename(dir) : path.basename(dir));
		assert.deepEqual(names.sort(), ["aiden-unique", "claude-unique", "workspace-unique"].sort());
		assert.ok(!names.includes("native-only"), "pi-native skill must not be re-injected");
		assert.ok(!names.includes("shared"), "colliding name must be injected exactly once (by priority)");
		assert.ok(injected.every((dir) => dir.includes(home) || dir.includes(cwd)));
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("skill injection is empty when no desktop folders exist", async () => {
	const { desktopSkillInjectionPaths } = await import(pathToFileURL(path.join(pkgDir, "src", "skill-paths.ts")));
	const home = mkdtempSync(path.join(tmpdir(), "aiden-cli-skills-"));
	const cwd = mkdtempSync(path.join(tmpdir(), "aiden-cli-cwd-"));
	try {
		assert.deepEqual(desktopSkillInjectionPaths(home, cwd), []);
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});
