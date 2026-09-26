#!/usr/bin/env node
/**
 * Patches the installed @earendil-works/pi-coding-agent dist so the bundled
 * CLI presents as Aiden, not Pi. Modeled on the desktop's
 * scripts/patch-pi-oauth-branding.mjs: verify the exact pin, apply targeted
 * replacements, and fail loudly when an anchor is missing so a pi upgrade
 * forces a conscious re-review instead of silently shipping Pi strings.
 *
 * Patched surfaces:
 *  - interactive-mode: the startup header's Pi self-promotion line (removed)
 *    and the tmux csi-u hint wording.
 *  - system-prompt: the agent identity sentence and the engine-docs guidance
 *    wording. Doc paths are intentionally unchanged — they point at the
 *    vendored engine docs that ship with the bundle.
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
				// The startup header line the product asked to remove outright.
				from: "`Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.`",
				to: '""',
			},
			{
				from: "tmux extended-keys-format is xterm. Pi works best with csi-u.",
				to: "tmux extended-keys-format is xterm. Aiden works best with csi-u.",
			},
			{
				// Minimal startup: the loaded Context/Skills/Themes/Extensions
				// listing never renders (the Aiden header itself stays), while
				// load-error diagnostics still surface. --verbose or turning
				// quietStartup off in /config brings the listing back.
				from: "const showListing = options?.force || this.options.verbose || !this.settingsManager.getQuietStartup();",
				to: "const showListing = options?.force || this.options.verbose; // resources listing off by default (Aiden)",
			},
			{
				// The listing is off by default, so the header hint should not
				// advertise it.
				from: "to show full startup help and loaded resources.",
				to: "to show full startup help.",
			},
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
			},			{
				// The startup wordmark: 5-row solid-block AIDEN banner
				// (inspired by oh-my-pi's PI_LOGO). The one-loop sheen
				// animation is layered on top by the aiden-startup extension
				// via ctx.ui.setHeader. appliedMarker keeps repeat builds
				// idempotent.
				from: "const logo = theme.bold(theme.fg(\"accent\", APP_NAME)) + theme.fg(\"dim\", ` v${this.version}`);",
				appliedMarker: "__aidenWordmark",
				to: [
					"const __aidenWordmark = [",
					'"███████ █████ ██████  ███████ ██   ██",',
					'"██   ██   ██  ██   ██ ██      ███  ██",',
					'"███████   ██  ██   ██ ████    ██ █ ██",',
					'"██   ██   ██  ██   ██ ██      ██  ███",',
					'"██   ██ █████ ██████  ███████ ██   ██",',
					"].map((line) => theme.fg(\"accent\", line));",
					"const logo = `${__aidenWordmark.join(\"\\n\")}\\n${theme.fg(\"dim\", ` v${this.version}`)}`;",
				].join("\n"),
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
		file: join(piAgentDir, "dist", "core", "settings-manager.js"),
		replacements: [
			{
				// Install telemetry (pi.dev report-install ping + pi attribution
				// headers) must default off in Aiden; the entry also forces
				// PI_TELEMETRY=0 so settings cannot re-enable it.
				from: "return this.settings.enableInstallTelemetry ?? true;",
				to: "return this.settings.enableInstallTelemetry ?? false;",
			},
			{
				// Active revert of an earlier Aiden patch: the header (Aiden
				// logo + hints) must keep the stock quietStartup default —
				// flipping it silenced the whole header including branding.
				from: "return this.settings.quietStartup ?? true;",
				to: "return this.settings.quietStartup ?? false;",
			},

		],
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
