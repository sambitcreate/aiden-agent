/**
 * Aiden's MCP server as Settings sees it: whether it runs, and the outside
 * apps (Claude Code, Codex and others) that may use it.
 */

export type AidenMcpAccess = "read" | "supervised";

export type AidenMcpServerProblemView = "port_in_use" | "start_failed";

export interface AidenMcpServerStatusView {
  supported: boolean;
  enabled: boolean;
  running: boolean;
  port?: number;
  /** The loopback address apps connect to, such as `http://127.0.0.1:49400/mcp`. */
  url?: string;
  problem?: AidenMcpServerProblemView;
}

export interface AidenMcpAppView {
  id: string;
  name: string;
  access: AidenMcpAccess;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds; 0 until the app first connects. */
  lastSeenAt: number;
}

/** The answer to adding an app. The credential is shown once and never again. */
export interface AidenMcpIssuedAppView {
  credential: string;
  app: AidenMcpAppView;
}

export interface AidenMcpChatProvenanceView {
  name: string;
  startedAt: number;
}

export const AIDEN_MCP_ACCESS_LABELS: Readonly<Record<AidenMcpAccess, string>> = {
  read: "Read only",
  supervised: "Supervised",
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function parseAidenMcpServerStatus(value: unknown): AidenMcpServerStatusView {
  const status = record(value);
  const port = typeof status?.port === "number" && Number.isInteger(status.port) && status.port > 0 && status.port < 65_536
    ? status.port
    : undefined;
  const url = typeof status?.url === "string" && /^http:\/\/127\.0\.0\.1:\d+\//u.test(status.url) ? status.url : undefined;
  const problem = status?.problem === "port_in_use" || status?.problem === "start_failed" ? status.problem : undefined;
  return {
    supported: status?.supported === true,
    enabled: status?.enabled === true,
    running: status?.running === true,
    ...(port === undefined ? {} : { port }),
    ...(url === undefined ? {} : { url }),
    ...(problem === undefined ? {} : { problem }),
  };
}

export function parseAidenMcpApp(value: unknown): AidenMcpAppView | undefined {
  const app = record(value);
  const createdAt = timestamp(app?.createdAt);
  const lastSeenAt = timestamp(app?.lastSeenAt);
  if (
    !app ||
    typeof app.id !== "string" ||
    typeof app.name !== "string" ||
    (app.access !== "read" && app.access !== "supervised") ||
    createdAt === undefined ||
    lastSeenAt === undefined
  ) {
    return undefined;
  }
  return { id: app.id, name: app.name, access: app.access, createdAt, lastSeenAt };
}

export function parseAidenMcpApps(value: unknown): AidenMcpAppView[] {
  return Array.isArray(value) ? value.flatMap((item) => parseAidenMcpApp(item) ?? []) : [];
}

export function parseAidenMcpIssuedApp(value: unknown): AidenMcpIssuedAppView {
  const issued = record(value);
  const app = parseAidenMcpApp(issued?.app);
  if (!app || typeof issued?.credential !== "string" || issued.credential.length === 0) {
    throw new Error("Aiden couldn't add this app.");
  }
  return { credential: issued.credential, app };
}

export function parseAidenMcpChatProvenance(value: unknown): AidenMcpChatProvenanceView | null {
  const provenance = record(value);
  const startedAt = timestamp(provenance?.startedAt);
  if (!provenance || typeof provenance.name !== "string" || !provenance.name || startedAt === undefined) return null;
  return { name: provenance.name, startedAt };
}

/** The environment variable the setup snippets keep the token in. */
export const AIDEN_MCP_TOKEN_ENV = "AIDEN_MCP_TOKEN";

export interface AidenMcpClientSnippet {
  id: "claude" | "codex";
  client: string;
  /** Run once in the shell that starts the client, or add it to the shell profile. */
  exportLine: string;
  /** Registers Aiden with the client, reading the token from the environment. */
  command: string;
}

/**
 * Ready-to-paste setup for Claude Code and Codex. Both read the token from
 * `AIDEN_MCP_TOKEN` rather than storing it in their config.
 */
export function aidenMcpClientSnippets(url: string, credential: string): AidenMcpClientSnippet[] {
  const exportLine = `export ${AIDEN_MCP_TOKEN_ENV}='${credential.replace(/'/gu, "'\\''")}'`;
  return [
    {
      id: "claude",
      client: "Claude Code",
      exportLine,
      // Claude Code stores the header as written and expands ${VAR} each time it connects.
      command: `claude mcp add --transport http aiden ${url} --header 'Authorization: Bearer \${${AIDEN_MCP_TOKEN_ENV}}'`,
    },
    {
      id: "codex",
      client: "Codex",
      exportLine,
      command: `codex mcp add aiden --url ${url} --bearer-token-env-var ${AIDEN_MCP_TOKEN_ENV}`,
    },
  ];
}
