/**
 * Aiden's opinionated tool default: pi's `codemode` tool next to the default
 * tools, as on the desktop. Pure module (no extension imports) so the entry
 * stays importable by Node's TypeScript-stripping test harness.
 *
 * Any explicit tool selection wins over this default: a tool flag on the
 * command line, extensions switched off, or a saved `defaultTools` setting
 * that names codemode (`+codemode`, `-codemode`) or replaces the defaults
 * (plain names, or an empty list).
 */

import { readFileSync } from "node:fs";

const TOOL_SELECTION_FLAGS = new Set([
	"--tools", "-t", "--no-tools", "-nt", "--no-builtin-tools", "-nbt", "--no-extensions", "-ne",
]);

function choosesCodemode(defaultTools: unknown): boolean {
	if (!Array.isArray(defaultTools)) return false;
	// An empty list replaces the defaults with no tools, as a plain list does.
	return defaultTools.length === 0 || defaultTools.some((entry) =>
		typeof entry === "string" && (!/^[+-]/u.test(entry) || entry.slice(1) === "codemode"));
}

export function shouldDefaultToCodemode(
	argv: readonly string[],
	settingsPaths: readonly string[],
): boolean {
	if (argv.some((arg) => TOOL_SELECTION_FLAGS.has(arg))) {
		return false;
	}
	for (const settingsPath of settingsPaths) {
		try {
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { defaultTools?: unknown };
			if (choosesCodemode(settings.defaultTools)) {
				return false;
			}
		} catch {
			// Absent or unreadable settings fall through to the Aiden default.
		}
	}
	return true;
}
