/**
 * The environment variable an app's setup commands read its Aiden MCP token
 * from. Each app gets its own, named after the app and a slice of its id, so
 * two apps set up in one shell profile never overwrite each other's token.
 * Settings and `aiden apps connect` both print this name.
 */
export function aidenMcpTokenEnvName(app: { id: string; name: string }): string {
  const words = app.name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "_")
    .slice(0, 24)
    .replace(/^_+|_+$/gu, "");
  const suffix = app.id
    .replace(/^device_/u, "")
    .replace(/[^A-Za-z0-9]/gu, "")
    .slice(0, 6)
    .toUpperCase();
  return ["AIDEN_MCP_TOKEN", words, suffix].filter(Boolean).join("_");
}
