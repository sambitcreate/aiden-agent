/**
 * Device-local CLI settings for Aiden-specific features, persisted at
 * <agentDir>/aiden.json. Shapes mirror the desktop's AppSettings subsets
 * (main/services/types.ts) so Phase 3 desktop interop reads the same fields.
 */

import { atomicJson, readJson, acquireLease } from "../state.ts";
import { join } from "node:path";

export interface AidenVoiceSettings {
	provider: "gemini" | "openai" | "off";
	/** Transcription model override (provider-specific). */
	model?: string;
	/** BCP-47 hint, e.g. "en-US". Undefined lets the provider auto-detect. */
	language?: string;
}

export interface AidenCliSettings {
	memoryEnabled?: boolean;
	voice?: AidenVoiceSettings;
}

export function aidenSettingsPath(agentDir: string): string {
	return join(agentDir, "aiden.json");
}

function normalizeSettings(value: unknown): AidenCliSettings {
	if (typeof value !== "object" || value === null) return {};
	const source = value as Record<string, unknown>;
	const settings: AidenCliSettings = {};
	// Strict-shape normalization, mirroring the desktop's portable config
	// handling: wrong-typed values are ignored rather than half-applied.
	if (typeof source.memoryEnabled === "boolean") {
		settings.memoryEnabled = source.memoryEnabled;
	}
	if (typeof source.voice === "object" && source.voice !== null) {
		const voice = source.voice as Record<string, unknown>;
		const provider = voice.provider;
		if (provider === "gemini" || provider === "openai" || provider === "off") {
			settings.voice = { provider };
			if (typeof voice.model === "string" && voice.model.trim()) {
				settings.voice.model = voice.model.trim();
			}
			if (typeof voice.language === "string" && voice.language.trim()) {
				settings.voice.language = voice.language.trim();
			}
		}
	}
	return settings;
}

export function readAidenSettings(agentDir: string): AidenCliSettings {
  return normalizeSettings(readJson(aidenSettingsPath(agentDir), {}));
}

export function writeAidenSettings(agentDir: string, settings: AidenCliSettings): void {
  const file = aidenSettingsPath(agentDir), release = acquireLease(file);
  try { atomicJson(file, { ...readJson<Record<string, unknown>>(file, {}), ...normalizeSettings(settings) }); }
  finally { release(); }
}
