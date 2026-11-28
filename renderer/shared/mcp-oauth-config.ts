import { validateMcpExposureFields } from "./mcp-exposure.js";

/** Fixed loopback port every MCP OAuth sign-in redirects to (RFC 8252). */
export const MCP_OAUTH_LOOPBACK_PORT = 41390;
/** The redirect URI Aiden registers, and the one to register for a pre-registered client. */
export const MCP_OAUTH_REDIRECT_URI = `http://127.0.0.1:${MCP_OAUTH_LOOPBACK_PORT}/callback`;

const LOOPBACK_SERVICE_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isMcpLoopbackHost(hostname: string): boolean {
  return LOOPBACK_SERVICE_HOSTS.has(hostname);
}

export function isMcpLoopbackServiceUrl(serviceUrl: string | URL | undefined): boolean {
  if (!serviceUrl) return false;
  let url: URL;
  try { url = serviceUrl instanceof URL ? new URL(serviceUrl.href) : new URL(serviceUrl); } catch { return false; }
  return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && isMcpLoopbackHost(url.hostname);
}

function ipv4Octets(host: string): [number, number, number, number] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (!match) return undefined;
  const octets = match.slice(1).map(Number) as [number, number, number, number];
  return octets.every((part) => part >= 0 && part <= 255) ? octets : undefined;
}

function isDisallowedRemoteIpv4([a, b]: [number, number, number, number]): boolean {
  return a === 127 || a === 0 || (a === 169 && b === 254) || a >= 224;
}

function isDisallowedRemoteOAuthHost(hostname: string): boolean {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const bare = hostname.slice(1, -1).toLowerCase();
    if (bare.includes("%")) return true;
    const embeddedHex = /^(?:::ffff:|::|64:ff9b::|64:ff9b:1:(?:[0-9a-f]{1,4}:){0,2}:?)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(bare);
    if (embeddedHex) {
      const high = Number.parseInt(embeddedHex[1]!, 16);
      const low = Number.parseInt(embeddedHex[2]!, 16);
      return isDisallowedRemoteIpv4([high >> 8, high & 255, low >> 8, low & 255]);
    }
    const embeddedDotted = /^(?:::ffff:|::|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(bare);
    if (embeddedDotted) {
      const octets = ipv4Octets(embeddedDotted[1]!);
      if (octets) return isDisallowedRemoteIpv4(octets);
    }
    return bare === "::" || bare === "::1" || /^fe[89ab][0-9a-f]?:/u.test(bare) || bare.startsWith("ff");
  }
  const normalized = hostname.replace(/\.+$/u, "").toLowerCase();
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  const octets = ipv4Octets(normalized);
  return octets ? isDisallowedRemoteIpv4(octets) : false;
}

function parseCheckedOAuthUrl(value: unknown, options: { allowLoopback: boolean; label: string }): string {
  if (typeof value !== "string" || !value || value.length > 2048 || value.trim() !== value || [...value].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) {
    throw new Error(`${options.label} must be a URL of at most 2,048 characters.`);
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${options.label} is invalid.`); }
  if (url.username || url.password || url.hash) {
    throw new Error(`${options.label} requires HTTPS${options.allowLoopback ? " (or HTTP on loopback)" : ""}, without credentials or a fragment.`);
  }
  if (options.allowLoopback) {
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isMcpLoopbackHost(url.hostname))) {
      throw new Error(`${options.label} requires HTTPS (or HTTP on loopback), without credentials or a fragment.`);
    }
    return url.href;
  }
  if (url.protocol !== "https:" || isDisallowedRemoteOAuthHost(url.hostname)) {
    throw new Error(`${options.label} requires a non-loopback HTTPS URL without credentials or a fragment.`);
  }
  return url.href;
}

/** Validate an OAuth discovery, authorization, registration, or token URL for `serviceUrl`. */
export function parseMcpOAuthEndpointUrl(value: unknown, serviceUrl?: string | URL): string {
  return parseCheckedOAuthUrl(value, {
    allowLoopback: isMcpLoopbackServiceUrl(serviceUrl),
    label: "OAuth endpoint URL",
  });
}

/** Explicit OAuth authority override; ordinary discovery remains the default. */
export function parseMcpOAuthMetadataUrl(value: unknown, serviceUrl?: string | URL): string {
  const hasServiceUrl = serviceUrl !== undefined && (serviceUrl instanceof URL || serviceUrl.trim() !== "");
  return parseCheckedOAuthUrl(value, {
    allowLoopback: hasServiceUrl ? isMcpLoopbackServiceUrl(serviceUrl) : true,
    label: "OAuth metadata URL",
  });
}

export function mcpOAuthMetadataUrlForServer(server: { transport?: unknown; oauth?: unknown; authServerMetadataUrl?: unknown; presetId?: unknown; url?: unknown }): string | undefined {
  if (server.authServerMetadataUrl === undefined) return undefined;
  if (server.transport === "stdio" || server.oauth !== true) throw new Error("OAuth metadata overrides require a remote server with OAuth sign-in enabled.");
  if (server.presetId) throw new Error("OAuth metadata overrides require a custom MCP server.");
  return parseMcpOAuthMetadataUrl(server.authServerMetadataUrl, typeof server.url === "string" ? server.url : undefined);
}


const MAX_OAUTH_CLIENT_ID_CHARS = 256;
const MAX_OAUTH_CLIENT_SECRET_CHARS = 4096;

function hasControlCharacters(value: string): boolean {
  return [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

/**
 * A pre-registered OAuth client for a custom remote OAuth server. The secret
 * is optional (public clients) and requires a client ID.
 */
function validateMcpOAuthClient(server: { transport?: unknown; oauth?: unknown; presetId?: unknown; oauthClientId?: unknown; oauthClientSecret?: unknown }): void {
  if (server.oauthClientId === undefined && server.oauthClientSecret === undefined) return;
  if (server.transport === "stdio" || server.oauth !== true || server.presetId) {
    throw new Error("An OAuth client ID requires a custom remote server with OAuth sign-in enabled.");
  }
  const id = server.oauthClientId;
  if (typeof id !== "string" || !id || id.trim() !== id || id.length > MAX_OAUTH_CLIENT_ID_CHARS || hasControlCharacters(id)) {
    throw new Error(`OAuth client ID must contain 1–${MAX_OAUTH_CLIENT_ID_CHARS} characters without surrounding spaces or control characters.`);
  }
  const secret = server.oauthClientSecret;
  if (secret !== undefined && (typeof secret !== "string" || !secret || secret.length > MAX_OAUTH_CLIENT_SECRET_CHARS || hasControlCharacters(secret))) {
    throw new Error(`OAuth client secret must contain 1–${MAX_OAUTH_CLIENT_SECRET_CHARS} characters without control characters.`);
  }
}

export function validateMcpServerMetadata(server: { transport?: unknown; oauth?: unknown; authServerMetadataUrl?: unknown; oauthClientId?: unknown; oauthClientSecret?: unknown; description?: unknown; presetId?: unknown; authProvider?: unknown; url?: unknown; headers?: unknown; exposure?: unknown; hiddenTools?: unknown }): void {
  mcpOAuthMetadataUrlForServer(server);
  validateMcpExposureFields(server);
  if (server.authProvider !== undefined) {
    if (typeof server.authProvider !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(server.authProvider)) throw new Error("Select a valid built-in provider for MCP authentication.");
    if (server.transport !== "http" || server.oauth || server.presetId || server.authServerMetadataUrl !== undefined || server.oauthClientId !== undefined || server.oauthClientSecret !== undefined || (server.headers && Object.keys(server.headers).length > 0)) throw new Error("Provider authentication requires a custom HTTP server without OAuth or configured headers.");
    if (typeof server.url !== "string") throw new Error("Provider authentication requires an HTTPS MCP URL.");
    const url = new URL(parseMcpOAuthMetadataUrl(server.url));
    if (url.protocol !== "https:") throw new Error("Provider authentication requires an HTTPS MCP URL.");
  }
  if (server.description !== undefined && (typeof server.description !== "string" || server.description.length > 1024 || server.description.includes("\0"))) throw new Error("MCP description must contain at most 1,024 characters.");
  validateMcpOAuthClient(server);
}
