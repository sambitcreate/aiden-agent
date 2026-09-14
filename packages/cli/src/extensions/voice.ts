/**
 * Voice transcription in the terminal: /voice configures the transcription
 * provider (persisted to the shared Aiden settings shape), /dictate records
 * the microphone with a detected CLI recorder and inserts the transcript into
 * the editor. Cloud transcription uses the same providers as the desktop
 * (Gemini, OpenAI) with credentials from the standard environment variables.
 * On-device Parakeet remains a desktop capability — the CLI shows it as
 * unavailable rather than pretending.
 */

import { mkdtempSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { readAidenSettings, writeAidenSettings, type AidenVoiceSettings } from "./aiden-settings.ts";

const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";
const OPENAI_DEFAULT_MODEL = "gpt-4o-mini-transcribe";

interface Recorder {
	command: string;
	args(base: string): string[];
}

function detectRecorder(): Recorder | undefined {
	const which = (binary: string): boolean =>
		spawnSync("which", [binary], { encoding: "utf-8" }).status === 0;
	if (which("rec")) {
		return { command: "rec", args: (base) => ["-c", "1", "-r", "16000", base] };
	}
	if (which("ffmpeg")) {
		const format = process.platform === "darwin" ? "avfoundation" : "pulse";
		const input = process.platform === "darwin" ? ":0" : "default";
		return {
			command: "ffmpeg",
			args: (base) => ["-f", format, "-i", input, "-ac", "1", "-ar", "16000", "-y", base],
		};
	}
	return undefined;
}

async function recordWav(stopSignal: Promise<void>): Promise<Buffer> {
	const recorder = detectRecorder();
	if (!recorder) {
		throw new Error(
			"No audio recorder found. Install sox (`brew install sox` / `apt install sox`) or ffmpeg to dictate from the terminal.",
		);
	}
	const dir = await mkdtempSync(join(tmpdir(), "aiden-dictate-"));
	const wavPath = join(dir, "dictation.wav");
	const child = spawn(recorder.command, recorder.args(wavPath), { stdio: "ignore" });
	const kill = setTimeout(() => child.kill("SIGTERM"), 120_000);
	await stopSignal;
	child.kill("SIGTERM");
	clearTimeout(kill);
	await new Promise((resolve) => child.once("exit", resolve));
	try {
		return await readFile(wavPath);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function transcribeWithGemini(audio: Buffer, settings: AidenVoiceSettings, apiKey: string): Promise<string> {
	const model = settings.model ?? GEMINI_DEFAULT_MODEL;
	const response = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
		{
			method: "POST",
			headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
			body: JSON.stringify({
				contents: [{
					parts: [
						{ text: "Transcribe this audio verbatim. Respond with the transcript only." },
						{ inline_data: { mime_type: "audio/wav", data: audio.toString("base64") } },
					],
				}],
				...(settings.language ? { generationConfig: { speechConfig: { languageCode: settings.language } } } : {}),
			}),
		},
	);
	if (!response.ok) throw new Error(`Gemini transcription failed (${response.status}).`);
	const payload = (await response.json()) as {
		candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
	};
	const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
	if (!text) throw new Error("Gemini returned an empty transcript.");
	return text;
}

async function transcribeWithOpenAI(audio: Buffer, settings: AidenVoiceSettings, apiKey: string): Promise<string> {
	const form = new FormData();
	form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "dictation.wav");
	form.append("model", settings.model ?? OPENAI_DEFAULT_MODEL);
	if (settings.language) form.append("language", settings.language.split("-")[0]);
	const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
		method: "POST",
		headers: { authorization: `Bearer ${apiKey}` },
		body: form,
	});
	if (!response.ok) throw new Error(`OpenAI transcription failed (${response.status}).`);
	const payload = (await response.json()) as { text?: string };
	const text = payload.text?.trim();
	if (!text) throw new Error("OpenAI returned an empty transcript.");
	return text;
}

export function createVoiceInlineExtension(options: { agentDir: string }): { name: string; factory: ExtensionFactory } {
	return {
		name: "aiden-voice",
		factory: (pi) => {
			pi.registerCommand("voice", {
				description: "Show or change voice transcription settings",
				handler: async (args, ctx) => {
					const settings = readAidenSettings(options.agentDir);
					if (args.trim().length > 0) {
						const value = args.trim().toLowerCase();
						if (value !== "gemini" && value !== "openai" && value !== "off") {
							ctx.ui.notify("Usage: /voice gemini | /voice openai | /voice off", "warning");
							return;
						}
						writeAidenSettings(options.agentDir, {
							...settings,
							voice: { ...(settings.voice ?? {}), provider: value },
						});
						ctx.ui.notify(`Voice transcription: ${value}`, "info");
						return;
					}
					const geminiReady = Boolean(process.env.GEMINI_API_KEY);
					const openaiReady = Boolean(process.env.OPENAI_API_KEY);
					const current = settings.voice?.provider ?? "off";
					const choice = await ctx.ui.select(
						`Voice transcription (current: ${current}; on-device Parakeet is desktop-only)`,
						[
							`gemini — Gemini cloud transcription${geminiReady ? "" : " (needs GEMINI_API_KEY)"}`,
							`openai — OpenAI cloud transcription${openaiReady ? "" : " (needs OPENAI_API_KEY)"}`,
							"off",
						],
					);
					if (!choice) return;
					const provider = choice.startsWith("gemini") ? "gemini" : choice.startsWith("openai") ? "openai" : "off";
					writeAidenSettings(options.agentDir, { ...settings, voice: { ...(settings.voice ?? {}), provider } });
					ctx.ui.notify(`Voice transcription: ${provider}`, "info");
				},
			});

			pi.registerCommand("dictate", {
				description: "Record from the microphone and insert the transcript into the editor",
				handler: async (_args, ctx) => {
					const settings = readAidenSettings(options.agentDir).voice ?? { provider: "off" as const };
					if (ctx.mode !== "tui") {
						ctx.ui.notify("Dictation requires the interactive TUI.", "warning");
						return;
					}
					if (settings.provider === "off") {
						ctx.ui.notify("Voice transcription is off. Configure it with /voice.", "warning");
						return;
					}
					const apiKey = settings.provider === "gemini" ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY;
					if (!apiKey) {
						ctx.ui.notify(`Set ${settings.provider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY"} to dictate.`, "warning");
						return;
					}
					ctx.ui.setStatus("aiden-dictate", "recording — press Enter to stop");
					let resolveStop: () => void = () => {};
					const stopSignal = new Promise<void>((resolve) => {
						resolveStop = resolve;
					});
					const recording = recordWav(stopSignal);
					try {
						await ctx.ui.input("Recording…", "press Enter to stop and transcribe");
					} finally {
						resolveStop();
					}
					ctx.ui.setStatus("aiden-dictate", "transcribing");
					try {
						const audio = await recording;
						const transcript =
							settings.provider === "gemini"
								? await transcribeWithGemini(audio, settings, apiKey)
								: await transcribeWithOpenAI(audio, settings, apiKey);
						ctx.ui.pasteToEditor(`${transcript} `);
						ctx.ui.notify("Transcript inserted into the editor.", "info");
					} catch (error) {
						ctx.ui.notify(
							`Dictation failed: ${error instanceof Error ? error.message : String(error)} (id ${randomUUID().slice(0, 8)})`,
							"error",
						);
					} finally {
						ctx.ui.setStatus("aiden-dictate", undefined);
					}
				},
			});
		},
	};
}
