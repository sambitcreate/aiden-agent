import { randomBytes } from "node:crypto";
import { mcpOAuthStore } from "../mcp-oauth-store.js";
import { mcpOAuthCredentialGeneration } from "../mcp-oauth.js";
import { presetSecretId } from "../mcp-presets.js";
import { secrets } from "../secrets.js";
import type { McpServer } from "../types.js";
import { resolveStoredMcpFieldSecrets } from "../mcp-field-secrets.js";
import type { SubagentMcpCredentialBoundary } from "./subagent-mcp-credential-core.js";
import { resolveSubagentMcpCredentialBoundary } from "./subagent-mcp-credential-resolve.js";

// A restart intentionally changes every live credential revision. Active child
// authority is process-owned, so restart invalidation is safer than persisting a
// key that could turn revisions into offline credential-verification oracles.
const PROCESS_CREDENTIAL_REVISION_KEY = randomBytes(32);

/** Resolve raw credential material only inside Electron main and return a closure-based boundary. */
export function resolveProductionSubagentMcpCredentialBoundary(
  server: McpServer,
  signal: AbortSignal,
): Promise<SubagentMcpCredentialBoundary> {
  return resolveSubagentMcpCredentialBoundary(server, signal, {
    revisionKey: PROCESS_CREDENTIAL_REVISION_KEY,
    resolveFieldSecrets: resolveStoredMcpFieldSecrets,
    presetKey: (configured, binding) => secrets.getOrBindLegacyProviderKey(presetSecretId(configured.id), binding),
    oauthSession: (configured) => mcpOAuthStore.get(configured.id, () => !signal.aborted),
    oauthGeneration: mcpOAuthCredentialGeneration,
  });
}
