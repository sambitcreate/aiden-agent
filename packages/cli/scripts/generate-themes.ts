/**
 * Generates Aiden theme presets in pi's terminal theme format.
 *
 * Imports the desktop app's appearance module directly so every color is
 * computed by the same contrast-corrected math the Electron renderer uses
 * (resolveThemeTokens), rather than hand-transcribed hex values that drift.
 *
 * Output (committed under packages/cli/themes/):
 *   builtin/dark.json, builtin/light.json  — Aiden palettes replacing pi's
 *     stock built-ins, so terminal background auto-detection lands on Aiden.
 *   slate|berry|moss-{dark,light}.json     — the remaining presets, shipped
 *     beside the bundle and registered via the --theme flag by src/cli.ts.
 * pi's original dark/light themes are preserved as pi-dark/pi-light by the
 * build script (copied from the installed package with renamed identities).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	
	getPresetVariant,
	
	THEME_PRESETS,
	
} from "../../../renderer/shared/appearance.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
// Optional output override (used by the theme fidelity test to regenerate into
// a scratch directory and compare against the committed files).
const themesDir = resolve(process.argv[2] ?? join(scriptDir, "..", "themes"));
const builtinDir = join(themesDir, "builtin");

import { buildTheme } from "../src/theme.ts";

mkdirSync(builtinDir, { recursive: true });

const presetIds = THEME_PRESETS.map((preset) => preset.id);
for (const presetId of presetIds) {
	for (const scheme of ["dark", "light"] as const) {
		const theme = buildTheme(presetId, scheme, getPresetVariant(presetId, scheme));
		if (presetId === "aiden") {
			// Aiden's palette replaces pi's stock built-ins; the loader keys these
			// by filename, and the JSON name must match the key it is loaded under.
			theme.name = scheme;
			writeFileSync(join(builtinDir, `${scheme}.json`), `${JSON.stringify(theme, null, "\t")}\n`);
		} else {
			const name = `${presetId}-${scheme}`;
			theme.name = name;
			writeFileSync(join(themesDir, `${name}.json`), `${JSON.stringify(theme, null, "\t")}\n`);
		}
	}
}

console.log(`Generated Aiden themes in ${themesDir} (${presetIds.length} presets x 2 schemes)`);
