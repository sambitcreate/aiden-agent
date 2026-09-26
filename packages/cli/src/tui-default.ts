/**
 * Aiden's opinionated TUI default: pi's fullscreen (alt-screen) renderer.
 * Pure module (no extension imports) so the entry stays importable by Node's
 * TypeScript-stripping test harness.
 *
 * An explicit --tui-mode flag or any saved tuiMode preference wins over this
 * default, so per-run overrides and /config changes behave exactly as they do
 * in stock pi.
 */

import { readFileSync } from "node:fs";

export function shouldDefaultToFullscreenTui(
	argv: readonly string[],
	settingsPaths: readonly string[],
): boolean {
	if (argv.includes("--tui-mode")) {
		return false;
	}
	for (const settingsPath of settingsPaths) {
		try {
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { tuiMode?: unknown };
			if (typeof settings.tuiMode === "string") {
				return false;
			}
		} catch {
			// Absent or unreadable settings fall through to the Aiden default.
		}
	}
	return true;
}
