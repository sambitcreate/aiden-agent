/**
 * Custom MCP servers keep env and header values in the encrypted secrets
 * store. The configured record (config.json, and what Settings receives)
 * holds this opaque marker in place of each value; the renderer sends the
 * marker back for a value it did not replace.
 */
export const MCP_FIELD_SECRET_PREFIX = "aiden-secret:v1:";
const MARKER = /^aiden-secret:v1:[a-f0-9]{32}$/u;

export function isMcpFieldSecretMarker(value: unknown): boolean {
  return typeof value === "string" && MARKER.test(value);
}
