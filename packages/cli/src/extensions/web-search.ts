/**
 * Web Search in the terminal: reuses Aiden's WebSearchService core
 * (main/services/web-search.ts) with device-local CLI settings. Routing
 * defaults to the desktop's fresh-install shape (anonymous Exa); additional
 * providers activate when their API key is present in the environment
 * (e.g. EXA_API_KEY, BRAVE_API_KEY).
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { WebSearchService } from "../../../../main/services/web-search.js";
import { normalizeWebSearchSettings, defaultWebSearchSettings } from "../../../../main/services/web-search-provider-registry-core.js";
import type { AppSettings } from "../../../../main/services/types.js";
import { aidenExtensionToInlineFactory } from "../pi-bridge/adapt-aiden-extension.ts";
import { readJson } from "../state.ts";
import { join } from "node:path";
import { readAidenSettings } from "./aiden-settings.ts";

export async function createWebSearchInlineExtension(options: {
	agentDir: string;
}): Promise<{ name: string; factory: ExtensionFactory } | undefined> {
	const service = createCliWebSearch(options.agentDir);
	const tool = await service.toolForGeneration();
	if (!tool) return undefined;
	return aidenExtensionToInlineFactory("aiden-web-search", {
		id: "aiden.web-search",
		tools: [tool],
	});
}

export function createCliWebSearch(agentDir: string) {
	return new WebSearchService({
		getSettings: async (): Promise<AppSettings> => {
			const settings = readAidenSettings(agentDir);
			const override = (settings as { webSearch?: AppSettings["webSearch"] }).webSearch;
			return { webSearch: normalizeWebSearchSettings(readJson(join(agentDir, "web-search.json"), override ?? defaultWebSearchSettings())) };
		},
		getCredential: async (providerId) => {
			const envName = `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
			return process.env[envName] ?? null;
		},
	});
}
