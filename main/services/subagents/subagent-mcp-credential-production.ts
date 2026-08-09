import { randomBytes } from "node:crypto";
import { mcpCredentialConnectionSnapshot } from "../mcp-credential-cleanup-core.js";
import { mcpOAuthStore } from "../mcp-oauth-store.js";
import { mcpOAuthCredentialGeneration } from "../mcp-oauth.js";
import {
  mcpAuthorizationBinding,
  sessionMatchesMcpBinding,
  type McpOAuthSession,
} from "../mcp-oauth-session.js";
import { assertMcpPresetServer, presetSecretId } from "../mcp-presets.js";
import { secrets } from "../secrets.js";
import type { McpServer } from "../types.js";
import {
  createSubagentMcpCredentialBoundary,
  subagentMcpEndpointCredentials,
  type SubagentMcpCredentialBoundary,
} from "./subagent-mcp-credential-core.js";

// A restart intentionally changes every live credential revision. Active child
// authority is process-owned, so restart invalidation is safer than persisting a
// key that could turn revisions into offline credential-verification oracles.
const PROCESS_CREDENTIAL_REVISION_KEY = randomBytes(32);

function assertCurrent(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("MCP read cancelled.");
  }
}

/** Resolve raw credential material only inside Electron main and return a closure-based boundary. */
export async function resolveProductionSubagentMcpCredentialBoundary(
  server: McpServer,
  signal: AbortSignal,
): Promise<SubagentMcpCredentialBoundary> {
  assertCurrent(signal);
  if (server.transport === "stdio") {
    throw new Error("Subagent MCP requires an isolated remote transport.");
  }
  const preset = assertMcpPresetServer(server);
  let presetApiKey: string | null = null;
  if (preset?.auth.kind === "apiKey") {
    presetApiKey = await secrets.getOrBindLegacyProviderKey(
      presetSecretId(server.id),
      JSON.stringify(mcpCredentialConnectionSnapshot(server)),
    );
    assertCurrent(signal);
  }
  let oauthSession: McpOAuthSession | undefined;
  if (server.oauth) {
    const session = await mcpOAuthStore.get(server.id, () => !signal.aborted);
    assertCurrent(signal);
    oauthSession =
      server.url &&
      sessionMatchesMcpBinding(session, mcpAuthorizationBinding(server.url))
        ? session
        : {};
  }
  return createSubagentMcpCredentialBoundary({
    revisionKey: PROCESS_CREDENTIAL_REVISION_KEY,
    configuredHeaders: server.headers,
    endpointCredentials: subagentMcpEndpointCredentials(server.url),
    presetApiKey,
    oauthSession,
    oauthGeneration: server.oauth
      ? mcpOAuthCredentialGeneration(server.id)
      : undefined,
  });
}
