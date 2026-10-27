import { validateMcpServerMetadata } from "../../renderer/shared/mcp-oauth-config.js";
// Built-in connectors from Aiden's catalog (`renderer/shared/connector-catalog.ts`)
// as first-class presets: the user connects with an API key (encrypted via
// secrets.ts), a browser OAuth sign-in, or, for a server on this device, no
// credential at all. A connector served by a Mac app (iMCP) runs the stdio
// command inside the installed app's bundle, and nothing else.
//
// This module is intentionally free of Electron imports so it can be
// unit-tested under plain tsx.

import os from "node:os";
import path from "node:path";
import {
  CONNECTOR_CATALOG,
  isConnectorAvailable,
  type ConnectorMacApp,
  type HttpConnectorCatalogEntry,
  type MacAppMcpPreset,
  type McpPreset as SharedMcpPreset,
  type McpPresetAuth as SharedMcpPresetAuth,
} from "../../renderer/shared/connector-catalog.js";
import { DEFAULT_MCP_OAUTH_CLIENT_NAME } from "./mcp-oauth-client-metadata.js";
import type { McpServer } from "./types.js";

export type McpPresetAuth = SharedMcpPresetAuth;

/** A Streamable HTTP preset, or (`transport: "stdio"`) one served by a Mac app. */
export type McpPreset = SharedMcpPreset;
export type { MacAppMcpPreset };

export const MCP_PRESETS: readonly McpPreset[] = CONNECTOR_CATALOG.map((entry): McpPreset =>
  entry.macApp ? { ...entry, transport: "stdio" } : { ...entry, transport: "http" },
);

/** The host a Mac app preset is checked against; tests pass their own. */
export interface McpPresetHost {
  platform: NodeJS.Platform;
  homedir: string;
}

const CURRENT_HOST = (): McpPresetHost => ({ platform: process.platform, homedir: os.homedir() });

/**
 * Every command a Mac app preset may run: its server inside the app in
 * /Applications, then in ~/Applications. Nothing outside those bundles.
 */
export function macAppServerCommands(app: ConnectorMacApp, homedir: string): string[] {
  return [
    path.posix.join("/Applications", app.bundleName),
    path.posix.join(homedir, "Applications", app.bundleName),
  ].map((bundle) => path.posix.join(bundle, app.serverPath));
}

/**
 * The one origin a preset's connection (and credential) may reach: the
 * catalog's HTTPS origin, or for a local preset its exact loopback HTTP origin.
 */
function presetOrigin(preset: Pick<HttpConnectorCatalogEntry, "url" | "local">): string {
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
  Object.fromEntries(
    MCP_PRESETS.flatMap((preset) => (preset.transport === "http" ? [[preset.id, presetOrigin(preset)]] : [])),
  ),
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
 * session/read-only endpoints, but a preset never leaves its catalog origin,
 * and a Mac app preset never runs anything but its app's own server.
 * A preset marked unavailable is refused outright.
 */
export function assertMcpPresetServer(
  server: McpServer,
  host: McpPresetHost = CURRENT_HOST(),
): McpPreset | undefined {
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
  if (declaredPreset.transport === "stdio") return assertMacAppPresetServer(server, declaredPreset, host);
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

/**
 * A Mac app preset runs exactly its app's server, with no arguments,
 * environment, address or credential, and only on a Mac.
 */
function assertMacAppPresetServer(server: McpServer, preset: MacAppMcpPreset, host: McpPresetHost): MacAppMcpPreset {
  if (host.platform !== "darwin") throw new Error(`${preset.name} works only on a Mac.`);
  if (
    server.transport !== "stdio" ||
    server.url !== undefined ||
    server.oauth ||
    (server.headers && Object.keys(server.headers).length > 0)
  ) {
    throw new Error(`${preset.name} must run its own app on this Mac.`);
  }
  if ((server.args?.length ?? 0) > 0 || (server.env && Object.keys(server.env).length > 0)) {
    throw new Error(`${preset.name} takes no arguments or environment.`);
  }
  if (!server.command || !macAppServerCommands(preset.macApp, host.homedir).includes(server.command)) {
    throw new Error(`${preset.name} only runs the server inside ${preset.macApp.bundleName} in your Applications folder.`);
  }
  return preset;
}

/**
 * Build the McpServer record for a preset connection. `location` is an HTTP
 * preset's address (blank: the catalog default) or, for a Mac app preset,
 * the installed app's server command.
 */
export function serverFromPreset(preset: McpPreset, location?: string, host?: McpPresetHost): McpServer {
  const base = { id: presetServerId(preset.id), name: preset.name, presetId: preset.id, enabled: true };
  const server: McpServer = preset.transport === "stdio"
    ? { ...base, transport: "stdio", command: location?.trim() ?? "", args: [] }
    : {
        ...base,
        transport: preset.transport,
        url: location?.trim() || preset.url,
        oauth: preset.auth.kind === "oauth" ? true : undefined,
      };
  assertMcpPresetServer(server, host);
  return server;
}
