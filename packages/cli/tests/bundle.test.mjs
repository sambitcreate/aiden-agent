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

test("bundle entry is executable and lazy loaders are emitted beside the shared chunks", () => {
	accessSync(join(appDir, "cli.js"), constants.X_OK);
	for (const lazy of [
		"anthropic.js",
		"bedrock-converse-stream.js",
		"github-copilot.js",
		"image-resize-worker.js",
		"codemode-worker.js",
		"meta.js",
		"openai-chatgpt.js",
		"kimi-coding.js",
		"openai-codex.js",
		"openrouter.js",
		"radius.js",
		"xai.js",
	]) {
		// The resolving modules import these relative to their own chunk.
		assert.ok(existsSync(join(appDir, "chunks", lazy)), `missing lazy loader ${lazy}`);
	}
});

test("pi's built-in dark and light themes ship where its session export looks for them", () => {
	const piThemeDir = join(pkgDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "modes", "interactive", "theme");
	for (const name of ["dark", "light"]) {
		const bundled = JSON.parse(readFileSync(join(appDir, "src", "modes", "interactive", "theme", `${name}.json`), "utf-8"));
		assert.equal(bundled.name, name);
		assert.deepEqual(bundled, JSON.parse(readFileSync(join(piThemeDir, `${name}.json`), "utf-8")));
	}
	// Aiden has no terminal UI: no extra presets ship beside the bundle.
	assert.equal(existsSync(join(appDir, "themes")), false);
});

test("the speech worker ships beside the Silero VAD model it trims silence with", () => {
	assert.ok(existsSync(join(appDir, "speech-worker.js")));
	const vad = readFileSync(join(appDir, "speech", "silero_vad.onnx"));
	assert.deepEqual(vad, readFileSync(join(pkgDir, "..", "..", "resources", "speech", "silero_vad.onnx")));
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
test("the system prompt presents as Aiden, not Pi", () => {
	const cliBundle = readFileSync(join(appDir, "cli.js"), "utf-8");
	const chunkFiles = readdirSync(join(appDir, "chunks"));
	const chunks = chunkFiles.map((name) => readFileSync(join(appDir, "chunks", name), "utf-8"));
	const everything = [cliBundle, ...chunks].join("\n");
	assert.ok(everything.includes("operating inside Aiden, a coding agent harness"), "system prompt identity");
	assert.ok(!everything.includes("operating inside pi, a coding agent harness"), "pi's identity must not ship");
});

test("pi telemetry is removed, not just disabled", () => {
	const cliBundle = readFileSync(join(appDir, "cli.js"), "utf-8");
	const chunkFiles = readdirSync(join(appDir, "chunks"));
	const chunks = chunkFiles.map((name) => readFileSync(join(appDir, "chunks", name), "utf-8"));
	const everything = [cliBundle, ...chunks].join("\n");
	// The entry forces PI_TELEMETRY=0, which wins over settings and kills both
	// the pi.dev report-install ping and pi's attribution headers.
	assert.match(cliBundle, /PI_TELEMETRY["']?\]?\s*=\s*["']0["']/, "entry must force PI_TELEMETRY=0");
	// The settings default flips to off so pi's settings reflect reality (the
	// parity suite checks the real SettingsManager reads it as false).
	// minifySyntax rewrites `false` / `true` as `!1` / `!0`.
	assert.ok(everything.includes("enableInstallTelemetry:!1"), "install telemetry must default off");
	assert.ok(!everything.includes("enableInstallTelemetry:!0"), "stock default-on telemetry must not survive");
	assert.ok(!everything.includes("reportInstallTelemetry(VERSION)"), "ping call sites must be patched out");
	assert.ok(!everything.includes("pi.dev/api/report-install"), "the telemetry endpoint must not ship");
});

test("the bundled MCP docs the model reads describe Aiden's MCP configuration, not Pi's native one", () => {
	const mcp = readFileSync(join(appDir, "docs", "mcp.md"), "utf8");
	assert.match(mcp, /aiden-mcp\.json/);
	assert.match(mcp, /aiden mcp login <id>/);
	const cli = readFileSync(join(appDir, "docs", "cli.md"), "utf8");
	assert.doesNotMatch(cli, /pi mcp (add|login|list|remove|logout)|builtin:mcp/);
	assert.match(cli, /aiden mcp add <server\.json>/);
});
