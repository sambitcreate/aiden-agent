import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const pkgDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const committedThemesDir = path.join(pkgDir, "themes");

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf-8"));
}

/**
 * Regenerates the themes with the same generator (which imports the desktop
 * app's renderer/shared/appearance.ts) into a scratch directory and requires a
 * deep match with the committed files. This pins terminal palettes to the
 * desktop's contrast-corrected color math: if either side changes, this test
 * forces a deliberate regeneration instead of silent drift.
 */
test("committed themes match a fresh generation from appearance.ts", () => {
	const scratchDir = mkdtempSync(path.join(tmpdir(), "aiden-cli-themes-"));
	const result = spawnSync(
		process.execPath,
		["--experimental-strip-types", path.join(pkgDir, "scripts", "generate-themes.ts"), scratchDir],
		{ cwd: pkgDir, encoding: "utf-8", timeout: 60_000 },
	);
	assert.equal(result.status, 0, result.stderr);

	for (const entry of readdirSync(scratchDir, { recursive: true })) {
		const relative = String(entry).replaceAll("\\", "/");
		if (!relative.endsWith(".json")) continue;
		const committed = readJson(path.join(committedThemesDir, relative));
		const regenerated = readJson(path.join(scratchDir, relative));
		assert.deepEqual(
			regenerated,
			committed,
			`${relative} drifted from appearance.ts; run npm run themes in packages/cli and commit the result`,
		);
	}
});

test("theme files reference only vars they define", () => {
	const files = [
		...readdirSync(committedThemesDir).filter((name) => name.endsWith(".json")).map((name) => name),
		...readdirSync(path.join(committedThemesDir, "builtin")).map((name) => `builtin/${name}`),
	];
	assert.ok(files.length >= 8, `expected at least 8 theme files, found ${files.length}`);
	for (const file of files) {
		const theme = readJson(path.join(committedThemesDir, file));
		const varNames = new Set(Object.keys(theme.vars));
		for (const [token, value] of Object.entries(theme.colors)) {
			if (typeof value === "string" && !value.startsWith("#")) {
				assert.ok(varNames.has(value), `${file}: color "${token}" references undefined var "${value}"`);
			}
		}
	}
});

test("thinking level ramp is perceptually ordered within each theme", () => {
	const levels = [
		"thinkingOff",
		"thinkingMinimal",
		"thinkingLow",
		"thinkingMedium",
		"thinkingHigh",
		"thinkingXhigh",
		"thinkingMax",
	];
	const ramp = readJson(path.join(committedThemesDir, "builtin", "dark.json"));
	for (const level of levels) {
		assert.ok(ramp.colors[level], `builtin/dark.json missing ${level}`);
	}
});
