#!/usr/bin/env node
/**
 * Patches the installed @earendil-works/pi-coding-agent dist so the bundled
 * CLI presents as Aiden, not Pi. Modeled on the desktop's
 * scripts/patch-pi-oauth-branding.mjs: verify the exact pin, apply targeted
 * replacements, and fail loudly when an anchor is missing so a pi upgrade
 * forces a conscious re-review instead of silently shipping Pi strings.
 *
 * Patched surfaces:
 *  - system-prompt: the agent identity sentence and the engine-docs guidance
 *    wording (daemon chats use Pi's system prompt). Doc paths are
 *    intentionally unchanged — they point at the vendored engine docs that
 *    ship with the bundle.
 *  - telemetry: pi's install ping call sites and endpoint are stripped and
 *    its settings default turned off, wherever that code still ships.
 *
 * Aiden has no interactive terminal UI, so pi's startup header, logo and
 * theme defaults are not patched.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(fileURLToPath(import.meta.url), "..", "..");
const piAgentDir = join(
	pkgDir,
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
);

const expectedPin = JSON.parse(readFileSync(join(pkgDir, "package-lock.json"), "utf-8")).packages?.[
	"node_modules/@earendil-works/pi-coding-agent"
]?.version;
const installedVersion = JSON.parse(readFileSync(join(piAgentDir, "package.json"), "utf-8")).version;
if (expectedPin && installedVersion !== expectedPin) {
	throw new Error(
		`patch-branding: installed pi-coding-agent ${installedVersion} != locked ${expectedPin}; re-run npm install`,
	);
}

const patches = [
	{
		file: join(piAgentDir, "dist", "modes", "interactive", "interactive-mode.js"),
		replacements: [
			{
				// Both changelog-triggered call sites of the pi.dev report-install
				// ping. The method stays (dead) but can never fire, even if the
				// settings toggle or PI_TELEMETRY env were somehow flipped on.
				from: "this.reportInstallTelemetry(VERSION);",
				to: "void 0; // telemetry removed (Aiden)",
			},

			{
				// The ping endpoint itself: strip it so no telemetry URL ships.
				from: "https://pi.dev/api/report-install?version=",
				to: "data:text/plain,telemetry-removed?version=",
			},
		],
	},
	{
		file: join(piAgentDir, "dist", "core", "system-prompt.js"),
		replacements: [
			{
				from: "You are an expert coding assistant operating inside pi, a coding agent harness.",
				to: "You are an expert coding assistant operating inside Aiden, a coding agent harness.",
			},
			{
				from: "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
				to: "Engine documentation (read only when the user asks about Aiden's engine itself, its SDK, extensions, themes, skills, or TUI):",
			},
			{
				from: "- When reading pi docs or examples, resolve",
				to: "- When reading engine docs or examples, resolve",
			},
			{
				from: "custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)",
				to: "custom providers (docs/custom-provider.md), adding models (docs/models.md), packages (docs/packages.md)",
			},
			{
				from: "- When working on pi topics, read the docs and examples, and follow",
				to: "- When working on engine topics, read the docs and examples, and follow",
			},
			{
				from: "- Always read pi .md files completely",
				to: "- Always read documentation .md files completely",
			},
		],
	},
	{
		// Install telemetry (pi.dev report-install ping + pi attribution
		// headers) must default off in Aiden; the entry also forces
		// PI_TELEMETRY=0 so settings cannot re-enable it. Since pi 1.2 the
		// settings manager and the settings schema both read this default.
		file: join(piAgentDir, "dist", "core", "settings-defaults.js"),
		replacements: [{
			from: "    enableInstallTelemetry: true,",
			to: "    enableInstallTelemetry: false,",
		}],
	},
];

let applied = 0;
for (const patch of patches) {
	let contents = readFileSync(patch.file, "utf-8");
	for (const { from, to, appliedMarker } of patch.replacements) {
		if (contents.includes(from)) {
			contents = contents.replaceAll(from, to);
			applied += 1;
		} else if (contents.includes(appliedMarker ?? to)) {
			// Already applied on a previous build (npm operations restore the
			// pristine dist, so this is the common re-run path, not an error).
			// appliedMarker covers replacements whose `to` text itself changes
			// between patch revisions (e.g. the banner rows).
			applied += 1;
		} else {
			throw new Error(
				`patch-branding: anchor not found in ${patch.file.replace(pkgDir + "/", "")}:\n  ${from}\npi was likely upgraded; review and update patch-branding.mjs`,
			);
		}
	}
	writeFileSync(patch.file, contents);
}

console.log(`patch-branding: applied ${applied} Aiden branding replacements`);
