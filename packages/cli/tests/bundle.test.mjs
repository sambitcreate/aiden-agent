import assert from "node:assert/strict";
import { accessSync, constants, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const pkgDir = dirname(fileURLToPath(import.meta.url)) + "/..";
const appDir = join(pkgDir, "dist", "app");

/**
 * The rebrand rides on dist/app/package.json being the nearest package.json to
 * the bundle: pi's config resolution walks up from the bundle file and reads
 * its piConfig. These assertions pin that contract.
 */
test("bundled app package.json carries the Aiden rebrand", () => {
	const appPackageJson = JSON.parse(readFileSync(join(appDir, "package.json"), "utf-8"));
	const outerPackageJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
	assert.deepEqual(appPackageJson.piConfig, { name: "aiden", configDir: ".aiden" });
	assert.equal(appPackageJson.type, "module");
	assert.equal(appPackageJson.version, outerPackageJson.version);
});

test("bundle entry is executable and lazy loaders are emitted beside it", () => {
	accessSync(join(appDir, "cli.js"), constants.X_OK);
	for (const lazy of [
		"anthropic.js",
		"bedrock-converse-stream.js",
		"github-copilot.js",
		"image-resize-worker.js",
		"kimi-coding.js",
		"openai-codex.js",
		"openrouter.js",
		"radius.js",
		"xai.js",
	]) {
		assert.ok(existsSync(join(appDir, lazy)), `missing lazy loader ${lazy}`);
	}
});

test("Aiden palettes replace pi's built-in dark and light themes", () => {
	const dark = JSON.parse(readFileSync(join(appDir, "src", "modes", "interactive", "theme", "dark.json"), "utf-8"));
	const light = JSON.parse(readFileSync(join(appDir, "src", "modes", "interactive", "theme", "light.json"), "utf-8"));
	assert.equal(dark.name, "dark");
	assert.equal(light.name, "light");
	// Accent anchors from renderer/shared/appearance.ts THEME_PRESETS.
	assert.equal(dark.vars.accent, "#3E97F6");
	assert.equal(light.vars.accent, "#006AD6");
	assert.equal(dark.vars.text, "#D1D4DA");
	assert.equal(light.vars.text, "#3D3F41");
});

test("all theme presets and pi originals ship beside the bundle", () => {
	const bundled = join(appDir, "themes");
	const expected = [
		"berry-dark",
		"berry-light",
		"moss-dark",
		"moss-light",
		"slate-dark",
		"slate-light",
	];
	for (const name of expected) {
		const theme = JSON.parse(readFileSync(join(bundled, `${name}.json`), "utf-8"));
		assert.equal(theme.name, name, `${name}.json must carry a matching name`);
		assert.ok(theme.vars && theme.colors, `${name}.json must define vars and colors`);
	}
	// Pi's own palettes are deliberately not shipped: Aiden themes only.
	for (const gone of ["pi-dark", "pi-light"]) {
		assert.ok(!existsSync(join(bundled, `${gone}.json`)), `${gone} must not ship`);
	}
});

test("pi's docs directory is vendored for auth/model guidance pointers", () => {
	assert.ok(existsSync(join(appDir, "docs", "providers.md")));
	assert.ok(existsSync(join(appDir, "docs", "models.md")));
});

/**
 * The branding patch rewrites pi's dist before bundling; these assertions pin
 * the user-visible outcome in the shipped artifact. If a pi upgrade changes
 * the anchors, scripts/patch-branding.mjs fails the build first — these catch
 * anything that slips past an anchor match.
 */
test("bundle presents as Aiden, not Pi", () => {
	const cliBundle = readFileSync(join(appDir, "cli.js"), "utf-8");
	const chunkFiles = readdirSync(join(appDir, "chunks"));
	const chunks = chunkFiles.map((name) => readFileSync(join(appDir, "chunks", name), "utf-8"));
	const everything = [cliBundle, ...chunks].join("\n");
	assert.equal(
		everything.includes("Pi can explain its own features"),
		false,
		"the Pi self-promotion header line must not ship",
	);
	assert.ok(everything.includes("operating inside Aiden, a coding agent harness"), "system prompt identity");
	assert.ok(!/Pi works best with csi-u/.test(everything), "tmux hint must say Aiden");
});

test("pi telemetry is removed, not just disabled", () => {
	const cliBundle = readFileSync(join(appDir, "cli.js"), "utf-8");
	const chunkFiles = readdirSync(join(appDir, "chunks"));
	const chunks = chunkFiles.map((name) => readFileSync(join(appDir, "chunks", name), "utf-8"));
	const everything = [cliBundle, ...chunks].join("\n");
	// The entry forces PI_TELEMETRY=0, which wins over settings and kills both
	// the pi.dev report-install ping and pi's attribution headers.
	assert.match(cliBundle, /PI_TELEMETRY["']?\]?\s*=\s*["']0["']/, "entry must force PI_TELEMETRY=0");
	// The settings default flips to off so /config reflects reality.
	// minifySyntax rewrites `?? false` / `?? true` as `??!1` / `??!0`
	assert.ok(everything.includes("enableInstallTelemetry??!1"), "install telemetry must default off");
	assert.ok(!everything.includes("enableInstallTelemetry??!0"), "stock default-on telemetry must not survive");
	assert.ok(!everything.includes("reportInstallTelemetry(VERSION)"), "ping call sites must be patched out");
	assert.ok(!everything.includes("pi.dev/api/report-install"), "the telemetry endpoint must not ship");
	// The startup wordmark: 5-row solid-block AIDEN banner (oh-my-pi style),
	// animated with a one-loop sheen sweep that settles into the static mark.
	assert.ok(
		everything.includes("███████ █████ ██████  ███████ ██   ██"),
		"the AIDEN block-letter wordmark must ship in the startup header",
	);
	assert.ok(!everything.includes("▄▀▀▄"), "superseded banner must not ship");
	// The one-loop sheen animation lives in the aiden-startup extension:
	assert.ok(everything.includes("__aidenStartupPlayed"), "startup flourish guard must ship");
	// One loop then settle: the interval flips settled, clears itself, and the
	// render loop then paints the static accent wordmark (minified forms).
	assert.ok(/settled=!0/.test(everything), "one loop then settle (settled flag)");
	assert.ok(everything.includes("timer&&clearInterval(timer)"), "one loop then settle (timer clear)");
	// Animation colors derive from the active theme accent, never hardcoded blues.
	assert.ok(!everything.includes("38;2;62;151;246"), "hardcoded Aiden-blue truecolor must not ship");
	// Minimal startup: the Aiden header stays (stock quietStartup default), but
	// the loaded-resources listing is patched off and no longer advertised.
	assert.ok(everything.includes("quietStartup??!1"), "header branding must keep the stock quietStartup default");
	assert.ok(!everything.includes("quietStartup??!0"), "flipped quietStartup default must be reverted");
	assert.match(
		everything.replace(/\s+/g, ""),
		/showListing=options\?\.force\|\|this\.options\.verbose[,;]/,
		"resources listing must be patched off by default",
	);
	assert.ok(
		!everything.includes("and loaded resources"),
		"header hint must not advertise the removed resources listing",
	);
});
