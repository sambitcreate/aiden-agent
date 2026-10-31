/**
 * Everything the CLI does beyond the static answers in src/cli.ts. Loaded with
 * a dynamic import so `aiden --version` and `aiden help` never evaluate pi,
 * the providers, or the Aiden cores.
 *
 * Aiden's CLI is a headless server and its administration commands. Pi's
 * interactive terminal UI, print mode and JSON/RPC modes are not reachable:
 * anything `dispatchCommand` does not recognize gets one line saying so.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dispatchCommand } from "./commands.ts";
import { exitAfterFlush } from "./exit-after-flush.ts";
import { migrateCliAzureConfig } from "./azure-config-migration.ts";
import { migrateAidenMcpConfigOnce } from "./mcp.ts";

/** The one line printed when the CLI starts in a folder that was deleted. */
export const DELETED_WORKING_DIRECTORY_MESSAGE =
	"aiden: The current folder no longer exists. Change to an existing folder and try again.";

/** The one line printed for a flag or mode of the removed interactive CLI, or any other unknown command. */
export const REMOVED_INTERACTIVE_CLI_MESSAGE =
	"aiden: the interactive CLI was removed; run `aiden serve` or `aiden help`.";

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
	try {
		migrateCliAzureConfig(getAgentDir());
		try {
			migrateAidenMcpConfigOnce(getAgentDir());
		} catch (error) {
			// A pending legacy migration must not keep `aiden` from starting;
			// `aiden mcp` commands retry it and report the same error.
			process.stderr.write(`aiden: MCP migration deferred (${error instanceof Error ? error.message : String(error)})\n`);
		}
		if (await dispatchCommand(getAgentDir(), process.cwd(), argv)) await exitAfterFlush(0);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		await exitAfterFlush(1);
	}
	console.error(REMOVED_INTERACTIVE_CLI_MESSAGE);
	await exitAfterFlush(1);
}
