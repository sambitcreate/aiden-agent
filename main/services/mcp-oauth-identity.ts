// Which OAuth client Aiden is for one MCP server, and the session binding
// derived from it. Electron-free: shared by the desktop provider, status
// reads, child agents and Bots.

import { mcpOAuthMetadataUrlForServer } from "../../renderer/shared/mcp-oauth-config.js";
import { DEFAULT_MCP_OAUTH_CLIENT_NAME } from "./mcp-oauth-client-metadata.js";
import { mcpAuthorizationBinding } from "./mcp-oauth-session.js";
import { mcpOAuthClientNameForServer } from "./mcp-presets.js";
import type { McpServer } from "./types.js";

export type McpOAuthClientIdentity =
  /** A client registered with the provider by hand (custom servers without dynamic registration). */
  | { kind: "pre-registered"; clientId: string; clientSecret?: string }
  /** Dynamic registration (or a Client ID Metadata Document) under this client name. */
  | { kind: "dynamic"; clientName: string };

type IdentityFields = Pick<McpServer, "id" | "presetId" | "oauthClientId" | "oauthClientSecret">;

export function mcpOAuthClientIdentity(server: IdentityFields): McpOAuthClientIdentity {
  if (server.oauthClientId) {
    return {
      kind: "pre-registered",
      clientId: server.oauthClientId,
      ...(server.oauthClientSecret ? { clientSecret: server.oauthClientSecret } : {}),
    };
  }
  return { kind: "dynamic", clientName: mcpOAuthClientNameForServer(server) };
}

/**
 * The identity part of a session binding. The default dynamic client adds
 * nothing, so sessions of servers that never changed identity keep their
 * binding. A secret is never part of it: the client stays the same client
 * when its secret is rotated.
 */
export function mcpOAuthClientIdentityKey(identity: McpOAuthClientIdentity): string | undefined {
  if (identity.kind === "pre-registered") return `client_id:${identity.clientId}`;
  return identity.clientName === DEFAULT_MCP_OAUTH_CLIENT_NAME ? undefined : `client_name:${identity.clientName}`;
}

/** The binding a server's stored OAuth session must carry to be used. */
export function mcpOAuthBindingForServer(
  server: IdentityFields & Pick<McpServer, "url" | "transport" | "oauth" | "authServerMetadataUrl">,
): string {
  if (!server.url) throw new Error("This MCP server needs a URL.");
  return mcpAuthorizationBinding(
    server.url,
    mcpOAuthMetadataUrlForServer(server),
    mcpOAuthClientIdentityKey(mcpOAuthClientIdentity(server)),
  );
}
