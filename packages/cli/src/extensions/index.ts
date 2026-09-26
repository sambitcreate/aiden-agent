/**
 * Assembles the Aiden inline extensions for one CLI session: the shared
 * context capture plus the Aiden feature ports (ask-user-question, advisor,
 * btw, todo, memory, web search, display image) and the CLI-specific /usage,
 * /voice, and /dictate commands.
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createContextCapture } from "../pi-bridge/adapt-aiden-extension.ts";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { createAskUserQuestionInlineExtension } from "./ask-user-question.ts";
import { createTodoInlineExtension } from "./todo.ts";
import { createMemoryInlineExtension } from "./memory.ts";
import { createWebSearchInlineExtension } from "./web-search.ts";
import { createDisplayImageInlineExtension } from "./display-image.ts";
import { createAdvisorInlineExtension } from "./advisor.ts";
import { createBtwInlineExtension } from "./btw.ts";
import { createUsageInlineExtension } from "./usage.ts";
import { createVoiceInlineExtension } from "./voice.ts";

import { createSessionParityExtension } from "./session-parity.ts";
import { createProviderParityExtension } from "../providers.ts";

import { createSubagentsExtension } from "./subagents.ts";
import { createOnboardingExtension } from "./onboarding.ts";
import { createWorkflowCommands } from "./workflow-commands.ts";

import { createArtifactsExtension } from "./artifacts.ts";

import { createMcpExtension } from "../mcp.ts";

import { createScheduleExtension } from "./schedule-tool.ts";

const WORDMARK = [
	"███████ █████ ██████  ███████ ██   ██",
	"██   ██   ██  ██   ██ ██      ███  ██",
	"███████   ██  ██   ██ ████    ██ █ ██",
	"██   ██   ██  ██   ██ ██      ██  ███",
	"██   ██ █████ ██████  ███████ ██   ██",
];

// Animation colors derive from the ACTIVE THEME accent (parsed from
// theme.fg's ANSI prefix), so they follow the user's chosen palette instead
// of hardcoded blues. When the terminal only offers 256/16-color modes the
// gradient modes degrade gracefully to flat accent + muted variants.
const GLYPHS = "█▓▒░▄▀▌▐";
const FRAME_MS = 25;

interface StartupMode {
	name: string;
	loopMs: number;
	draw(
		rows: readonly string[],
		t: number,
		tick: number,
		theme: { fg: (color: string, text: string) => string },
		accentAnsi: string,
		accentRgb: [number, number, number] | null,
	): string[];
}

function __rgbMix(
	c1: [number, number, number],
	c2: [number, number, number],
	t: number,
): string {
	const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
	const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
	const b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
	return `\x1b[38;2;${r};${g};${b}m`;
}

const MODES: StartupMode[] = [
	{
		name: "sheen",
		loopMs: 900,
		draw(rows, t, _tick, theme, accentAnsi) {
			const centre = -4 + t * 46;
			return rows.map((row, y) => {
				const at = centre + y * 2;
				let line = "";
				for (let x = 0; x < row.length; x++) {
					line += Math.abs(x - at) <= 2
						? "\x1b[1m\x1b[97m" + row[x] + "\x1b[0m"
						: accentAnsi + row[x] + "\x1b[0m";
				}
				return line;
			});
		},
	},
	{
		name: "wave",
		loopMs: 1600,
		draw(rows, t, _tick, theme, accentAnsi, accentRgb) {
			if (!accentRgb) {
				return rows.map((row) => theme.fg("accent", row));
			}
			const deep: [number, number, number] = [
				Math.round(accentRgb[0] * 0.35),
				Math.round(accentRgb[1] * 0.45),
				Math.round(accentRgb[2] * 0.55),
			];
			const pale: [number, number, number] = [
				Math.round(accentRgb[0] + (255 - accentRgb[0]) * 0.45),
				Math.round(accentRgb[1] + (255 - accentRgb[1]) * 0.35),
				Math.round(accentRgb[2] + (255 - accentRgb[2]) * 0.25),
			];
			return rows.map((row, y) => {
				let line = "";
				for (let x = 0; x < row.length; x++) {
					const base = (x / Math.max(1, row.length - 1) + y / Math.max(1, rows.length - 1)) / 2;
					const v = 0.5 + 0.5 * Math.sin((base + t) * Math.PI * 2);
					line += (v < 0.5 ? __rgbMix(deep, accentRgb, v * 2) : __rgbMix(accentRgb, pale, (v - 0.5) * 2)) + row[x] + "\x1b[0m";
				}
				return line;
			});
		},
	},
	{
		name: "typewriter",
		loopMs: 2300,
		draw(rows, t, _tick, theme, accentAnsi, accentRgb) {
			const reveal = Math.min(1, t / 0.65);
			const cutoff = reveal * 46;
			const dimAnsi = accentRgb
				? __rgbMix(
					[24, 27, 33],
					accentRgb,
					0.18,
				)
				: "\x1b[90m";
			return rows.map((row) => {
				let line = "";
				for (let x = 0; x < row.length; x++) {
					if (x > cutoff) line += dimAnsi + row[x] + "\x1b[0m";
					else if (x > cutoff - 3) line += "\x1b[1m\x1b[97m" + row[x] + "\x1b[0m";
					else line += accentAnsi + row[x] + "\x1b[0m";
				}
				return line;
			});
		},
	},
	{
		name: "glitch",
		loopMs: 2400,
		draw(rows, t, tick, theme, accentAnsi, accentRgb) {
			const resolved = Math.min(1, t / 0.8) * 48;
			return rows.map((row) => {
				let line = "";
				for (let x = 0; x < row.length; x++) {
					if (x < resolved) { line += accentAnsi + row[x] + "\x1b[0m"; continue; }
					const h = Math.sin((x + 1) * 12.9898 + tick * 3.7) * 43758.5453;
					const r = h - Math.floor(h);
					if (r < 0.55) {
						line += (accentRgb ? __rgbMix([24, 27, 33], accentRgb, 0.55) : accentAnsi) + row[x] + "\x1b[0m";
					} else {
						line += theme.fg("accent", GLYPHS[Math.floor(r * GLYPHS.length) % GLYPHS.length]);
					}
				}
				return line;
			});
		},
	},
	{
		name: "sparkle",
		loopMs: 1800,
		draw(rows, _t, tick, theme, accentAnsi) {
			const lit = new Set<string>();
			for (let k = 0; k < 8; k++) {
				const h = Math.sin((k + 1) * 127.1 + tick * 311.7) * 43758.5453;
				const r1 = h - Math.floor(h);
				const h2 = Math.sin((k + 1) * 269.5 + tick * 183.3) * 43758.5453;
				const r2 = h2 - Math.floor(h2);
				lit.add(`${Math.floor(r1 * 38)},${Math.floor(r2 * rows.length)}`);
			}
			return rows.map((row, y) => {
				let line = "";
				for (let x = 0; x < row.length; x++) {
					line += lit.has(`${x},${y}`)
						? "\x1b[1m\x1b[97m" + row[x] + "\x1b[0m"
						: accentAnsi + row[x] + "\x1b[0m";
				}
				return line;
			});
		},
	},
	{
		name: "pulse",
		loopMs: 1500,
		draw(rows, t, _tick, theme, accentAnsi, accentRgb) {
			if (!accentRgb) {
				return rows.map((row) => theme.fg("accent", row));
			}
			const pale: [number, number, number] = [
				Math.round(accentRgb[0] + (255 - accentRgb[0]) * 0.45),
				Math.round(accentRgb[1] + (255 - accentRgb[1]) * 0.35),
				Math.round(accentRgb[2] + (255 - accentRgb[2]) * 0.25),
			];
			return rows.map((row, y) => {
				let line = "";
				for (let x = 0; x < row.length; x++) {
					const v = 0.5 + 0.5 * Math.sin(x * 0.32 - t * Math.PI * 2 + y * 0.5);
					line += (v < 0.5 ? __rgbMix([24, 27, 33], accentRgb, v * 2) : __rgbMix(accentRgb, pale, (v - 0.5) * 2)) + row[x] + "\x1b[0m";
				}
				return line;
			});
		},
	},
];

/**
 * Startup flourish for the TUI: the AIDEN wordmark plays exactly one loop of a
 * randomly picked animation (sheen sweep, color wave, typewriter, decode
 * glitch, sparkle, or pulse) and then settles into the static accent wordmark.
 * One loop, by design: once it settles the header never animates again,
 * keeping the session calm. All colors derive from the ACTIVE theme accent.
 * Built on pi's public ctx.ui.setHeader.
 */
function createStartupInlineExtension(): InlineExtension {
	return {
		name: "aiden-startup",
		factory: (pi) => {
			pi.on("session_start", async (_event, ctx) => {
				if (ctx.mode !== "tui" || !ctx.hasUI) return;
				const global = globalThis as { __aidenStartupPlayed?: boolean };
				if (global.__aidenStartupPlayed) return;
				global.__aidenStartupPlayed = true;

				ctx.ui.setHeader((tui, theme) => {
					const mode = MODES[Math.floor(Math.random() * MODES.length)];
					// theme.fg("accent", "") returns "<accentAnsi><reset-only-fg>";
					// parsing it keeps every animation on the active palette.
					const accentProbe = theme.fg("accent", "");
					const accentAnsi = accentProbe.slice(0, accentProbe.length - 2);
					// eslint-disable-next-line no-control-regex -- the probe IS an ANSI escape
					const rgbMatch = accentAnsi.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m$/);
					const accentRgb = rgbMatch
						? ([Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])] as [number, number, number])
						: null;
					let tick = 0;
					let settled = false;
					let timer: ReturnType<typeof setInterval> | undefined;

					const component = {
						invalidate(): void {},
						dispose(): void {
							if (timer) clearInterval(timer);
						},
						render(_width: number): string[] {
							const lines = settled
								? WORDMARK.map((row) => theme.fg("accent", row))
								: mode.draw(WORDMARK, Math.min(1, tick * FRAME_MS / mode.loopMs), tick, theme as unknown as { fg: (color: string, text: string) => string }, accentAnsi, accentRgb);
							lines.push(theme.fg("dim", ` v${VERSION}  ·  agent`));
							return lines;
						},
					};

					timer = setInterval(() => {
						tick += 1;
						if (tick * FRAME_MS >= mode.loopMs + 400) {
							settled = true;
							if (timer) clearInterval(timer);
							timer = undefined;
						}
						tui.requestRender();
					}, FRAME_MS);

					tui.requestRender();
					return component;
				});
			});
		},
	};
}

export async function createAidenInlineExtensions(): Promise<InlineExtension[]> {
	// pi's rebrand resolution: AIDEN_CODING_AGENT_DIR env, else ~/.aiden/agent.
	const agentDir = getAgentDir();
	const workspaceRoot = process.cwd();

	const capture = createContextCapture();
	const captureExtension: InlineExtension = {
		name: "aiden-context-capture",
		factory: (pi) => capture.register(pi),
	};

	// Every Aiden extension is isolated: a failure in one disables that feature
	// (with a stderr note) instead of bricking the CLI.
	const candidates: Array<{ name: string; build: () => InlineExtension | Promise<InlineExtension | undefined> }> = [
		{ name: "aiden-ask-user-question", build: () => createAskUserQuestionInlineExtension({ latestContext: capture.latest }) },
		{ name: "aiden-advisor", build: () => createAdvisorInlineExtension({ latestContext: capture.latest, agentDir }) },
		{ name: "aiden-btw", build: () => createBtwInlineExtension({ latestContext: capture.latest }) },
		{ name: "aiden-startup", build: () => createStartupInlineExtension() },
		{ name: "aiden-todo", build: () => createTodoInlineExtension({ latestContext: capture.latest }) },
		{ name: "aiden-display-image", build: () => createDisplayImageInlineExtension({ agentDir, workspaceRoot }) },
		{ name: "aiden-usage", build: () => createUsageInlineExtension(agentDir) },
		{ name: "aiden-voice", build: () => createVoiceInlineExtension({ agentDir }) },
		{
			name: "aiden-memory",
			build: async () => await createMemoryInlineExtension({ agentDir, workspaceRoot }),
		},
		{
			name: "aiden-web-search",
			build: async () => await createWebSearchInlineExtension({ agentDir }),
		},
	];

	const extensions: InlineExtension[] = [captureExtension, createProviderParityExtension(agentDir), createSessionParityExtension(agentDir)];
	if (process.env.AIDEN_CHILD === "1") return extensions;
	extensions.push(createSubagentsExtension(agentDir), createOnboardingExtension(agentDir), createWorkflowCommands(agentDir), createArtifactsExtension(agentDir), createMcpExtension(agentDir), createScheduleExtension(agentDir));
	for (const candidate of candidates) {
		try {
			const extension = await candidate.build();
			if (extension) extensions.push(extension);
		} catch (error) {
			// Feature isolation mirrors the desktop's fail-closed surface gates.
			process.stderr.write(
				`aiden: ${candidate.name.replace("aiden-", "")} features disabled (${error instanceof Error ? error.message : String(error)})\n`,
			);
		}
	}
	return extensions;
}
