// Built-in MCP provider catalog. Presets are first-class, preconfigured MCP
// servers the user connects with just an API key (encrypted via secrets.ts)
// or a browser OAuth sign-in. Adding a new provider is a data-only change:
// one more entry in MCP_PRESETS (plus an icon mapping in the renderer).
//
// This module is intentionally free of Electron imports so it can be
// unit-tested under plain tsx.

import type { McpServer } from "./types.js";

export type McpPresetAuth =
  | { kind: "apiKey"; headerName: string; keyLabel: string; keyHelpUrl: string }
  | { kind: "oauth" };

export interface McpPreset {
  id: string;
  name: string;
  /** Short card description shown in settings. */
  tagline: string;
  /** Attribution line, e.g. "By Composio". */
  vendor: string;
  /** All first-pass presets are streamable HTTP. */
  transport: "http";
  /** Default server address; the user may edit it during setup. */
  url: string;
  auth: McpPresetAuth;
  docsUrl: string;
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: "composio",
    name: "Composio",
    tagline: "One key unlocks 500+ app integrations — GitHub, Gmail, Slack, and more.",
    vendor: "By Composio",
    transport: "http",
    url: "https://connect.composio.dev/mcp",
    auth: {
      kind: "apiKey",
      headerName: "x-consumer-api-key",
      keyLabel: "Composio API key",
      keyHelpUrl: "https://dashboard.composio.dev",
    },
    docsUrl: "https://docs.composio.dev",
  },
  {
    id: "notion",
    name: "Notion",
    tagline: "Search, read, and update pages and databases in your workspace.",
    vendor: "By Notion",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    auth: { kind: "oauth" },
    docsUrl: "https://developers.notion.com/docs/get-started-with-mcp",
  },
  {
    id: "linear",
    name: "Linear",
    tagline: "Find, create, and update issues, projects, and comments.",
    vendor: "By Linear",
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    auth: { kind: "oauth" },
    docsUrl: "https://linear.app/docs/mcp",
  },
];

const MCP_PRESET_ALLOWED_ORIGINS: Readonly<Record<string, readonly string[]>> = {
  composio: ["https://connect.composio.dev"],
  notion: ["https://mcp.notion.com"],
  linear: ["https://mcp.linear.app"],
};

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
