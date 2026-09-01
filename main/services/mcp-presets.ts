// Built-in MCP provider catalog. Connectable plugins from the shared Codex
// Plugin Directory (plus Aiden's Composio connector) become first-class
// presets: the user connects with an API key (encrypted via secrets.ts) or a
// browser OAuth sign-in.
//
// This module is intentionally free of Electron imports so it can be
// unit-tested under plain tsx.

import {
  isConnectablePlugin,
  PLUGIN_CATALOG,
  type McpPresetAuth as SharedMcpPresetAuth,
  type PluginCatalogEntry,
} from "../../renderer/shared/plugin-catalog.js";
import type { McpServer } from "./types.js";

export type McpPresetAuth = SharedMcpPresetAuth;

export interface McpPreset {
  id: string;
  name: string;
  /** Short card description shown in settings. */
  tagline: string;
  /** Attribution line, e.g. "By Composio". */
  vendor: string;
  category: string;
  /** All first-pass presets are streamable HTTP. */
  transport: "http";
  /** Default server address; the user may edit it during setup. */
  url: string;
  auth: McpPresetAuth;
  docsUrl: string;
}

export function mcpPresetFromPlugin(plugin: PluginCatalogEntry): McpPreset | undefined {
  if (!isConnectablePlugin(plugin) || !plugin.url || !plugin.auth) return undefined;
  return {
    id: plugin.id,
    name: plugin.name,
    tagline: plugin.tagline,
    vendor: plugin.vendor,
    category: plugin.category,
    transport: "http",
    url: plugin.url,
    auth: plugin.auth,
    docsUrl: plugin.docsUrl,
  };
}

export const MCP_PRESETS: McpPreset[] = PLUGIN_CATALOG.flatMap((plugin) => {
  const preset = mcpPresetFromPlugin(plugin);
  return preset ? [preset] : [];
});

function httpsOrigin(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(`${url} must use HTTPS.`);
  }
  return parsed.origin;
}

const MCP_PRESET_ALLOWED_ORIGINS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(MCP_PRESETS.map((preset) => [preset.id, [httpsOrigin(preset.url)]])),
);

/** Deterministic server id for a preset, so re-setup maps to the same record and secret. */
export function presetServerId(presetId: string): string {
  return `preset-${presetId}`;
}

/** Keychain secret id holding a preset's API key (see secrets.ts). */
export function presetSecretId(serverId: string): string {
  return `mcp:${serverId}`;
}

export function getMcpPreset(presetId: string): McpPreset | undefined {
  return MCP_PRESETS.find((preset) => preset.id === presetId);
}

export function getMcpPresetForServerId(serverId: string): McpPreset | undefined {
  return MCP_PRESETS.find((preset) => presetServerId(preset.id) === serverId);
}

/**
 * API-key preset requests must not automatically follow redirects: unlike the
 * standard Authorization header, provider-specific key headers are not
 * guaranteed to be stripped when a redirect crosses origins.
 */
export function createNoRedirectFetch(fetchImpl: typeof fetch = globalThis.fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    fetchImpl(input, { ...init, redirect: "error" })) as typeof fetch;
}

/**
 * Validate the renderer-authored identity and endpoint before main resolves a
 * preset credential. Paths may vary for provider-owned session/read-only
 * endpoints, but credentials never cross the catalog's exact HTTPS origins.
 */
export function assertMcpPresetServer(server: McpServer): McpPreset | undefined {
  const idPreset = getMcpPresetForServerId(server.id);
  const declaredPreset = server.presetId ? getMcpPreset(server.presetId) : undefined;
  if (!idPreset && !server.presetId) return undefined;
  if (!idPreset || !declaredPreset || idPreset.id !== declaredPreset.id) {
    throw new Error("This MCP preset has an invalid identity.");
  }
  if (server.transport !== declaredPreset.transport || !server.url) {
    throw new Error(`${declaredPreset.name} must use its secure HTTP connection.`);
  }
  if ((declaredPreset.auth.kind === "oauth") !== Boolean(server.oauth)) {
    throw new Error(`${declaredPreset.name} has an invalid authentication mode.`);
  }

  let url: URL;
  try {
    url = new URL(server.url);
  } catch {
    throw new Error(`${declaredPreset.name} needs a valid server address.`);
  }
  const allowedOrigins = MCP_PRESET_ALLOWED_ORIGINS[declaredPreset.id] ?? [];
  if (
    url.protocol !== "https:" ||
    Boolean(url.username || url.password) ||
    !allowedOrigins.includes(url.origin)
  ) {
    throw new Error(
      `${declaredPreset.name} credentials can only be sent to its official secure server.`,
    );
  }
  return declaredPreset;
}

/** Build the McpServer record for a preset connection. */
export function serverFromPreset(preset: McpPreset, url?: string): McpServer {
  const server: McpServer = {
    id: presetServerId(preset.id),
    name: preset.name,
    transport: preset.transport,
    url: url?.trim() || preset.url,
    oauth: preset.auth.kind === "oauth" ? true : undefined,
    presetId: preset.id,
    enabled: true,
  };
  assertMcpPresetServer(server);
  return server;
}
