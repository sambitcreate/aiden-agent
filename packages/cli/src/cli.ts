#!/usr/bin/env node
/**
 * Aiden Agent CLI entry.
 *
 * Thin launcher over the pi coding agent SDK. Bundling pi's code into this
 * package is what activates the rebrand: pi's config resolution walks up from
 * the bundle location to the nearest package.json (dist/app/package.json) and
 * reads its `piConfig`, so the CLI identifies as "aiden", stores state under
 * ~/.aiden/agent, honors AIDEN_CODING_AGENT_DIR, and uses .aiden/ for project
 * resources.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createAidenInlineExtensions } from "./extensions/index.ts";
import { desktopSkillInjectionPaths } from "./skill-paths.ts";
import { dispatchCommand, CLI_COMMAND_HELP } from "./commands.ts";
import { shouldDefaultToFullscreenTui } from "./tui-default.ts";

// Aiden CLI carries its own release cadence; pi.dev's version feed would
// compare Aiden's version numbers against pi's forever. Allow an explicit
// opt-in override, but default the upstream check off.
process.env.PI_SKIP_VERSION_CHECK = process.env.PI_SKIP_VERSION_CHECK ?? "1";
// Aiden ships without pi telemetry: PI_TELEMETRY gates both pi's anonymous
// report-install ping and pi's attribution headers (which identify requests
// as "pi"), and the env var wins over the settings toggle. Forced, not
// defaulted — removal, not a preference.
process.env.PI_TELEMETRY = "0";

/**
 * Extra Aiden theme presets shipped beside the bundle. pi only auto-loads
 * dark.json/light.json as built-ins, so the remaining presets are registered
 * through the public `--theme <path>` flag, which makes them selectable in
 * /theme, --use-theme, and first-run setup like any other theme.
 */
function bundledThemePaths(): string[] {
	const themesDir = join(dirname(fileURLToPath(import.meta.url)), "themes");
	if (!existsSync(themesDir)) {
		return [];
	}
	return readdirSync(themesDir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => join(themesDir, name))
		.sort();
}

/**
 * Mirrors pi's own resolution for where a tuiMode preference could be saved:
 * the rebranded agent dir (env override, else <home>/<configDir>/agent) and
 * the current project's settings.
 */
function tuiSettingsPaths(): string[] {
	const appDir = dirname(fileURLToPath(import.meta.url));
	let configDir = ".aiden";
	let appName = "aiden";
	try {
		const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf-8")) as {
			piConfig?: { name?: string; configDir?: string };
		};
		configDir = pkg.piConfig?.configDir ?? configDir;
		appName = pkg.piConfig?.name ?? appName;
	} catch {
		// Fall back to the committed defaults; the generated app package.json
		// always carries both.
	}
	const paths: string[] = [];
	const envAgentDir = process.env[`${appName.toUpperCase()}_CODING_AGENT_DIR`];
	if (envAgentDir) {
		paths.push(join(envAgentDir, "settings.json"));
	} else {
		paths.push(join(homedir(), configDir, "agent", "settings.json"));
	}
	paths.push(join(process.cwd(), configDir, "settings.json"));
	return paths;
}

/**
 * Desktop-shared Agent Skills injection (see src/skill-paths.ts for the
 * priority/dedup rules that keep pi's native discovery conflict-free).
 */
function desktopSkillPaths(): string[] {
	return desktopSkillInjectionPaths(homedir(), process.cwd());
}

const invokedAsCli = (() => {
	try {
		return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
})();

if (invokedAsCli) {
	const argv = process.argv.slice(2);
	process.env.AIDEN_CLI_ENTRY = fileURLToPath(import.meta.url);
	try {
		if (await dispatchCommand(getAgentDir(), process.cwd(), argv)) process.exit(0);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error)); process.exit(1);
	}
	if (argv.includes("--help")) process.stdout.write(CLI_COMMAND_HELP + "\n");
	for (const themePath of bundledThemePaths()) {
		argv.push("--theme", themePath);
	}
	for (const skillPath of desktopSkillPaths()) {
		argv.push("--skill", skillPath);
	}
	if (shouldDefaultToFullscreenTui(argv, tuiSettingsPaths())) {
		argv.push("--tui-mode", "fullscreen");
	}
	try {
		const extensionFactories = await createAidenInlineExtensions();
		await main(argv, { extensionFactories });
	} catch (error) {
		console.error(error instanceof Error ? (error.stack ?? error.message) : error);
		process.exitCode = 1;
	}
}
