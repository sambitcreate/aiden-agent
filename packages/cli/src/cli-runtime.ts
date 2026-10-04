/**
 * Everything the CLI does beyond the static answers in src/cli.ts. Loaded with
 * a dynamic import so `aiden --version` and `aiden help` never evaluate pi,
 * the providers, or the Aiden cores.
 *
 * Code-splitting places this module in dist/app/chunks/, so paths that belong
 * beside the bundle entry (themes, the app package.json) come from `appDir`
 * rather than this module's own URL.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { main, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createAidenInlineExtensions } from "./extensions/index.ts";
import { desktopSkillInjectionPaths } from "./skill-paths.ts";
import { dispatchCommand } from "./commands.ts";
import { CLI_COMMAND_HELP } from "./command-help.ts";
import { shouldDefaultToFullscreenTui } from "./tui-default.ts";

/**
 * Extra Aiden theme presets shipped beside the bundle. pi only auto-loads
 * dark.json/light.json as built-ins, so the remaining presets are registered
 * through the public `--theme <path>` flag, which makes them selectable in
 * /theme, --use-theme, and first-run setup like any other theme.
 */
function bundledThemePaths(appDir: string): string[] {
	const themesDir = join(appDir, "themes");
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
function tuiSettingsPaths(appDir: string): string[] {
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

export async function runCli(argv: string[], appDir: string): Promise<void> {
	try {
		if (await dispatchCommand(getAgentDir(), process.cwd(), argv)) process.exit(0);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error)); process.exit(1);
	}
	if (argv.includes("--help")) process.stdout.write(CLI_COMMAND_HELP + "\n");
	for (const themePath of bundledThemePaths(appDir)) {
		argv.push("--theme", themePath);
	}
	for (const skillPath of desktopSkillPaths()) {
		argv.push("--skill", skillPath);
	}
	if (shouldDefaultToFullscreenTui(argv, tuiSettingsPaths(appDir))) {
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
