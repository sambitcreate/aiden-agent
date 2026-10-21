import { validateMcpServerMetadata } from "../../renderer/shared/mcp-oauth-config.js";
// Built-in connectors from Aiden's catalog (`renderer/shared/connector-catalog.ts`)
// as first-class presets: the user connects with an API key (encrypted via
// secrets.ts), a browser OAuth sign-in, or, for a server on this device, no
// credential at all.
//
// This module is intentionally free of Electron imports so it can be
// unit-tested under plain tsx.

import {
  CONNECTOR_CATALOG,
  isConnectorAvailable,
  type ConnectorCatalogEntry,
  type McpPresetAuth as SharedMcpPresetAuth,
} from "../../renderer/shared/connector-catalog.js";
import { DEFAULT_MCP_OAUTH_CLIENT_NAME } from "./mcp-oauth-client-metadata.js";
import type { McpServer } from "./types.js";

export type McpPresetAuth = SharedMcpPresetAuth;

export interface McpPreset extends ConnectorCatalogEntry {
  /** Every preset is Streamable HTTP. */
  transport: "http";
}

export const MCP_PRESETS: readonly McpPreset[] = CONNECTOR_CATALOG.map((entry) => ({
  ...entry,
  transport: "http" as const,
}));

/**
 * The one origin a preset's connection (and credential) may reach: the
 * catalog's HTTPS origin, or for a local preset its exact loopback HTTP origin.
 */
function presetOrigin(preset: Pick<ConnectorCatalogEntry, "url" | "local">): string {
  const parsed = new URL(preset.url);
  if (preset.local) {
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
      throw new Error(`${preset.url} must be a loopback HTTP address.`);
    }
    return parsed.origin;
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${preset.url} must use HTTPS.`);
  }
  return parsed.origin;
}

const MCP_PRESET_ALLOWED_ORIGINS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(MCP_PRESETS.map((preset) => [preset.id, presetOrigin(preset)])),
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

/**
 * DCR `client_name` for this server. Aiden registers as itself everywhere;
 * this stays the single source every OAuth registration reads.
 */
export function mcpOAuthClientNameForServer(
  _server: Pick<McpServer, "id" | "presetId">,
): string {
  return DEFAULT_MCP_OAUTH_CLIENT_NAME;
}

export function getMcpPresetForServerId(serverId: string): McpPreset | undefined {
  return MCP_PRESETS.find((preset) => presetServerId(preset.id) === serverId);
}

/**
 * Validate the renderer-authored identity and endpoint before main resolves a
 * preset credential or connects. Paths may vary for provider-owned
 * session/read-only endpoints, but a preset never leaves its catalog origin.
 * A preset marked unavailable is refused outright.
 */
export function assertMcpPresetServer(server: McpServer): McpPreset | undefined {
  validateMcpServerMetadata(server);
  const idPreset = getMcpPresetForServerId(server.id);
  const declaredPreset = server.presetId ? getMcpPreset(server.presetId) : undefined;
  if (!idPreset && !server.presetId) return undefined;
  if (server.authProvider !== undefined || server.authServerMetadataUrl !== undefined || server.oauthClientId !== undefined || server.oauthClientSecret !== undefined) throw new Error("OAuth overrides require a custom MCP server.");
  if (!idPreset || !declaredPreset || idPreset.id !== declaredPreset.id) {
    throw new Error("This MCP preset has an invalid identity.");
  }
  if (!isConnectorAvailable(declaredPreset)) {
    throw new Error(declaredPreset.availability!.reason);
  }
  if (server.transport !== declaredPreset.transport || !server.url) {
    throw new Error(`${declaredPreset.name} must use its own HTTP connection.`);
  }
  if ((declaredPreset.auth.kind === "oauth") !== Boolean(server.oauth)) {
    throw new Error(`${declaredPreset.name} has an invalid authentication mode.`);
  }
  if (declaredPreset.auth.kind === "none" && server.headers && Object.keys(server.headers).length > 0) {
    throw new Error(`${declaredPreset.name} does not take headers.`);
  }

  let url: URL;
  try {
    url = new URL(server.url);
  } catch {
    throw new Error(`${declaredPreset.name} needs a valid server address.`);
  }
  if (
    Boolean(url.username || url.password) ||
    url.origin !== MCP_PRESET_ALLOWED_ORIGINS[declaredPreset.id]
  ) {
    throw new Error(
      declaredPreset.local
        ? `${declaredPreset.name} only connects to ${MCP_PRESET_ALLOWED_ORIGINS[declaredPreset.id]} on this device.`
        : `${declaredPreset.name} credentials can only be sent to its official secure server.`,
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
