/**
 * Everything the CLI does beyond the static answers in src/cli.ts. Loaded with
 * a dynamic import so `aiden --version` and `aiden help` never evaluate pi,
 * the providers, or the Aiden cores.
 *
 * Aiden's CLI is a headless server and its administration commands. Pi's
 * interactive terminal UI, print mode and JSON/RPC modes are not reachable: a
 * flag, removed command or bare prompt gets one line saying so, and any other
 * unknown word gets an unknown-command line.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CLI_COMMANDS, dispatchCommand } from "./commands.ts";
import { exitAfterFlush } from "./exit-after-flush.ts";
import { migrateCliAzureConfig } from "./azure-config-migration.ts";
import { migrateAidenMcpConfigOnce } from "./mcp.ts";

/** The one line printed when the CLI starts in a folder that was deleted. */
export const DELETED_WORKING_DIRECTORY_MESSAGE =
	"aiden: The current folder no longer exists. Change to an existing folder and try again.";

/** The one line printed for a flag, mode, command or bare prompt of the removed interactive CLI. */
export const REMOVED_INTERACTIVE_CLI_MESSAGE =
	"aiden: the interactive CLI was removed; run `aiden serve` or `aiden help`.";

/** Commands of the removed interactive CLI. */
const REMOVED_COMMANDS = new Set(["chat", "reset", "selfcheck", "theme"]);

function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i += 1) {
		const current = [i];
		for (let j = 1; j <= b.length; j += 1) {
			current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		previous = current;
	}
	return previous[b.length]!;
}

/**
 * The line for a first word `dispatchCommand` does not handle. Flags, the
 * removed interactive commands and bare prompts (anything with whitespace,
 * like `aiden "fix the test"`) get the retirement line; another word gets an
 * unknown-command line, with a suggestion when one command is a close match.
 */
export function unknownCommandMessage(word: string | undefined): string {
	if (word === undefined || word.startsWith("-") || /\s/u.test(word) || REMOVED_COMMANDS.has(word)) return REMOVED_INTERACTIVE_CLI_MESSAGE;
	const distances = CLI_COMMANDS.map((command) => ({ command, distance: editDistance(word.toLowerCase(), command) }));
	const best = Math.min(...distances.map(({ distance }) => distance));
	const closest = distances.filter(({ distance }) => distance === best);
	const suggestion = best <= (word.length <= 4 ? 1 : 2) && closest.length === 1 ? ` Did you mean \`aiden ${closest[0]!.command}\`?` : "";
	return `aiden: unknown command "${word}".${suggestion} Run \`aiden help\`.`;
}

/** The current folder, or undefined when it was deleted after the shell entered it. */
function currentDirectory(): string | undefined {
	try {
		return process.cwd();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
}

export async function runCli(argv: string[], _appDir: string): Promise<void> {
	// Everything below reads the current folder (settings, migrations), so a
	// deleted one gets one plain line instead of `uv_cwd`.
	if (currentDirectory() === undefined) {
		console.error(DELETED_WORKING_DIRECTORY_MESSAGE);
		await exitAfterFlush(1);
	}
	// Unknown words fail before any migration touches the agent directory.
	if (!CLI_COMMANDS.includes(argv[0] ?? "")) {
		console.error(unknownCommandMessage(argv[0]));
		await exitAfterFlush(1);
	}
	try {
		migrateCliAzureConfig(getAgentDir());
		try {
			migrateAidenMcpConfigOnce(getAgentDir());
		} catch (error) {
			// A pending legacy migration must not keep `aiden` from starting;
			// `aiden mcp` commands retry it and report the same error.
			process.stderr.write(`aiden: MCP migration deferred (${error instanceof Error ? error.message : String(error)})\n`);
		}
		if (await dispatchCommand(getAgentDir(), process.cwd(), argv)) await exitAfterFlush(Number(process.exitCode ?? 0));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		await exitAfterFlush(1);
	}
	console.error(unknownCommandMessage(argv[0]));
	await exitAfterFlush(1);
}
