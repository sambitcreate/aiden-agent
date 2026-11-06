export const COMPOSIO_SERVICE_TOOL_NAME = "composio";
export const COMPOSIO_SERVICE_SERVER_ID = "preset-composio";
export const COMPOSIO_CONNECT_URL = "https://connect.composio.dev/mcp";

/** Presentation identity only; the host also validates the complete preset and credential binding. */
export function isComposioServiceConnection(server: {
  id: string; presetId?: string; transport: string; url?: string; oauth?: boolean;
  authProvider?: string; authServerMetadataUrl?: string; oauthClientId?: string; oauthClientSecret?: string;
  headers?: Record<string, string>;
}): boolean {
  return server.id === COMPOSIO_SERVICE_SERVER_ID && server.presetId === "composio" && server.transport === "http"
    && server.url === COMPOSIO_CONNECT_URL && !server.oauth && server.authProvider === undefined
    && server.authServerMetadataUrl === undefined && server.oauthClientId === undefined && server.oauthClientSecret === undefined
    && Object.keys(server.headers ?? {}).every((name) => name.toLowerCase() === "x-consumer-api-key");
}

/** Old exclusions require the person's explicit single service allowance, never automatic widening. */
export function composioServiceRequiresReview(hiddenTools: readonly string[] | undefined): boolean {
  return (hiddenTools ?? []).some((name) => name !== COMPOSIO_SERVICE_TOOL_NAME);
}
