// Kept light: `aiden apps connect` renders with this module without loading
// the MCP server or its SDK into the admin command.
import type { AidenMcpServerStatus } from "../../../main/services/aiden-mcp-server.js";
import type { AidenRemoteAgentAppProjection } from "../../../main/services/aiden-remote-state.js";

/**
 * The first port the server's `/mcp` endpoint tries (then the next seven).
 * The desktop uses 49400 (50400 in development), so a server and a desktop on
 * the same computer never take each other's port; this is the same +100 shift
 * the server's Remote port has over the desktop's. The bound port is saved in
 * `remote.json`, so a connected app keeps working across restarts.
 */
export const CLI_MCP_DEFAULT_PORT = 49_500;

export interface CliAppConnection {
  app: AidenRemoteAgentAppProjection;
  /** Shown once; only its digest is kept. */
  token: string;
  server: AidenMcpServerStatus;
}

/**
 * The commands that add Aiden to Claude Code and Codex. The token goes in an
 * environment variable both clients read at connect time, so neither stores
 * it in its own config file.
 */
export function aidenMcpClientSnippets(url: string, token: string): { environment: string; claude: string; codex: string } {
  return {
    environment: `export AIDEN_MCP_TOKEN=${token}`,
    claude: `claude mcp add --scope user --transport http aiden ${url} --header 'Authorization: Bearer \${AIDEN_MCP_TOKEN}'`,
    codex: `codex mcp add aiden --url ${url} --bearer-token-env-var AIDEN_MCP_TOKEN`,
  };
}

/** What `aiden apps connect` prints on a terminal. */
export function renderAppConnection(connection: CliAppConnection): string {
  const { app, token, server } = connection;
  const lines = [
    `Connected ${app.name} (${app.access === "supervised" ? "Supervised" : "Read"} access, id ${app.id}).`,
    "",
    "Its token is shown only this once. Keep it out of logs and chats:",
    `  ${token}`,
    "",
  ];
  if (server.running && server.url) {
    const snippets = aidenMcpClientSnippets(server.url, token);
    lines.push(
      `Aiden's MCP server is listening at ${server.url} (this computer only).`,
      "",
      "Set the token where Claude Code or Codex runs (for example in your shell profile):",
      `  ${snippets.environment}`,
      "",
      "Claude Code:",
      `  ${snippets.claude}`,
      "",
      "Codex:",
      `  ${snippets.codex}`,
      "",
    );
  } else {
    lines.push(
      server.problem === "port_in_use"
        ? `Aiden's MCP server could not start: port ${server.port ?? CLI_MCP_DEFAULT_PORT} is in use. Free it, then run \`aiden apps on\`.`
        : "Aiden's MCP server could not start. Check the server's log, then run `aiden apps on`.",
      "",
    );
  }
  lines.push(`Disconnect it any time with \`aiden apps revoke ${app.id}\`.`);
  return lines.join("\n");
}
