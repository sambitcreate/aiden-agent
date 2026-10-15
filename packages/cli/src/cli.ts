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
 *
 * This module imports only Node built-ins and two import-free helpers. It
 * answers the static requests (`--version`, `aiden help`) directly and loads
 * the runtime in src/cli-runtime.ts with a dynamic import otherwise, so those
 * answers do not pay for evaluating pi and the Aiden cores, and the SQLite
 * warning filter is in place before `node:sqlite` is linked.
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_COMMAND_HELP } from "./command-help.ts";
import { suppressSqliteExperimentalWarning } from "./sqlite-warning.ts";

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
 * The answer for requests that need nothing beyond the bundle's own files, or
 * undefined. `--version` matches pi's own answer (the version in the nearest
 * package.json, which is dist/app/package.json) unless PI_PACKAGE_DIR points
 * pi somewhere else, in which case pi answers.
 */
function staticAnswer(argv: string[], appDir: string): string | undefined {
	if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v") && !process.env.PI_PACKAGE_DIR) {
		const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf-8")) as { version?: string };
		return `${pkg.version || "0.0.0"}\n`;
	}
	if (argv[0] === "help") return CLI_COMMAND_HELP;
	return undefined;
}

const entry = fileURLToPath(import.meta.url);
const invokedAsCli = (() => {
	try {
		return process.argv[1] !== undefined && realpathSync(process.argv[1]) === entry;
	} catch {
		return false;
	}
})();

if (invokedAsCli) {
	suppressSqliteExperimentalWarning();
	const argv = process.argv.slice(2);
	const appDir = dirname(entry);
	process.env.AIDEN_CLI_ENTRY = entry;
	const answer = staticAnswer(argv, appDir);
	if (answer !== undefined) {
		process.stdout.write(answer);
	} else {
		const { runCli } = await import("./cli-runtime.ts");
		await runCli(argv, appDir);
	}
}
