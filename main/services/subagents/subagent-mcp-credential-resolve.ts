// The credential boundary for a child agent's MCP reads, from a configured
// server record. Storage is injected so the redaction contract is testable
// outside Electron (see subagent-mcp-credential-production.ts).

import { mcpPresetKeyBinding } from "../mcp-credential-cleanup-core.js";
import {
  mcpAuthorizationBinding,
  sessionMatchesMcpBinding,
  type McpOAuthSession,
} from "../mcp-oauth-session.js";
import { assertMcpPresetServer } from "../mcp-presets.js";
import type { McpServer } from "../types.js";
import {
  createSubagentMcpCredentialBoundary,
  subagentMcpEndpointCredentials,
  type SubagentMcpCredentialBoundary,
} from "./subagent-mcp-credential-core.js";

export interface SubagentMcpCredentialSources {
  revisionKey: Uint8Array;
  /**
   * The configured record with stored header values filled in. The transport
   * sends those values, so they (not their config.json markers) are what a
   * child must never see echoed back.
   */
  resolveFieldSecrets(server: McpServer): Promise<McpServer>;
  /** `binding` is the credential snapshot of the configured (marker) record. */
  presetKey(server: McpServer, binding: string): Promise<string | null>;
  oauthSession(server: McpServer): Promise<McpOAuthSession>;
  oauthGeneration(serverId: string): number;
}

function assertCurrent(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("MCP read cancelled.");
  }
}

export async function resolveSubagentMcpCredentialBoundary(
  server: McpServer,
  signal: AbortSignal,
  sources: SubagentMcpCredentialSources,
): Promise<SubagentMcpCredentialBoundary> {
  assertCurrent(signal);
  if (server.authProvider) throw new Error("Provider-authenticated MCP is unavailable to child agents.");
  if (server.transport === "stdio") {
    throw new Error("Subagent MCP requires an isolated remote transport.");
  }
  const preset = assertMcpPresetServer(server);
  let presetApiKey: string | null = null;
  if (preset?.auth.kind === "apiKey") {
    presetApiKey = await sources.presetKey(server, mcpPresetKeyBinding(server));
    assertCurrent(signal);
  }
  let oauthSession: McpOAuthSession | undefined;
  if (server.oauth) {
    const session = await sources.oauthSession(server);
    assertCurrent(signal);
    oauthSession =
      server.url &&
      sessionMatchesMcpBinding(session, mcpAuthorizationBinding(server.url, server.authServerMetadataUrl, server.oauthClientName))
        ? session
        : {};
  }
  const resolved = await sources.resolveFieldSecrets(server);
  assertCurrent(signal);
  return createSubagentMcpCredentialBoundary({
    revisionKey: sources.revisionKey,
    configuredHeaders: resolved.headers,
    endpointCredentials: subagentMcpEndpointCredentials(server.url),
    presetApiKey,
    oauthSession,
    oauthGeneration: server.oauth ? sources.oauthGeneration(server.id) : undefined,
  });
}
