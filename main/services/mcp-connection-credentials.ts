// Turns a configured MCP server record into the connection-ready copy a
// transport is built from: local launch approval first, then (for a Mac app
// connector) whether its app is open, then stored env and header values, then
// a preset's API key. Shared by live connections and Settings draft tests;
// the storage is injected.

import { mcpPresetKeyBinding } from "./mcp-credential-cleanup-core.js";
import { mcpFieldSecretMarkers } from "./mcp-field-secrets-core.js";
import { mcpApiKeyHeaderValue } from "./mcp-oauth-client-metadata.js";
import { assertMcpPresetServer, type MacAppMcpPreset } from "./mcp-presets.js";
import { McpStdioApprovalRequiredError } from "./mcp-stdio-approvals.js";
import type { McpServer } from "./types.js";

export interface McpConnectionCredentialDependencies {
  /** Omitted only for a user-typed Settings draft, which runs because the person asked. */
  isLaunchApproved?(server: McpServer): Promise<boolean>;
  /**
   * Whether a Mac app connector's app is running. Its server only answers
   * while the app is open, so a closed app is reported at once instead of
   * waiting out the connection deadline.
   */
  isMacAppOpen?(preset: MacAppMcpPreset): Promise<boolean>;
  resolveFieldSecrets(server: McpServer): Promise<McpServer>;
  /**
   * The preset key bound to `binding`, the credential snapshot of the
   * configured record exactly as stored (markers, not values), which is what
   * saving the key bound it to.
   */
  presetKey(server: McpServer, binding: string): Promise<string | null>;
  isCurrent(): boolean;
  missingKey(presetName: string): string;
}

function assertCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) throw new Error("The renderer document is no longer active.");
}

export async function resolveMcpConnectionCredentials(
  configured: McpServer,
  deps: McpConnectionCredentialDependencies,
): Promise<McpServer> {
  assertCurrent(deps.isCurrent);
  const preset = assertMcpPresetServer(configured);
  // A local command runs only once this exact launch was approved on this device.
  if (deps.isLaunchApproved && configured.transport === "stdio" && !(await deps.isLaunchApproved(configured))) {
    throw new McpStdioApprovalRequiredError(configured.name || configured.id);
  }
  if (preset?.transport === "stdio" && deps.isMacAppOpen && !(await deps.isMacAppOpen(preset))) {
    throw new Error(`${preset.name} isn’t open. Open ${preset.name}, then try again.`);
  }
  assertCurrent(deps.isCurrent);
  // Env and header values live in the secrets store; config.json holds markers.
  let server = configured;
  if (mcpFieldSecretMarkers(configured).length > 0) {
    server = await deps.resolveFieldSecrets(configured);
    assertCurrent(deps.isCurrent);
  }
  if (!preset || preset.auth.kind !== "apiKey") return server;
  const key = await deps.presetKey(configured, mcpPresetKeyBinding(configured));
  assertCurrent(deps.isCurrent);
  if (!key) throw new Error(deps.missingKey(preset.name));
  return {
    ...server,
    headers: {
      ...server.headers,
      [preset.auth.headerName]: mcpApiKeyHeaderValue(key, preset.auth.headerValuePrefix),
    },
  };
}
