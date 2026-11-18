import { join } from "node:path";
import { AidenMcpHost } from "../../../main/services/aiden-mcp-server.js";
import { AidenMcpToolRunner, type AidenMcpServices } from "../../../main/services/aiden-mcp-tools.js";
import {
  AidenMcpProvenanceLog,
  emptyAidenMcpProvenanceDocument,
  parseAidenMcpProvenanceDocument,
} from "../../../main/services/aiden-mcp-provenance.js";
import type {
  AidenRemoteAgentAccess,
  AidenRemoteStateRegistry,
} from "../../../main/services/aiden-remote-state.js";
import { hostPlatformCapabilities } from "../../../main/services/host-platform-capabilities.js";
import { atomicJson, readJson } from "./state.ts";
import { CLI_MCP_DEFAULT_PORT, type CliAppConnection } from "./apps-display.ts";

export { CLI_MCP_DEFAULT_PORT, type CliAppConnection };

export const CLI_MCP_PROVENANCE_FILE = "aiden-mcp-chat-provenance.json";

export interface CliMcpHostOptions {
  agentDir: string;
  state: AidenRemoteStateRegistry;
  services(): Promise<AidenMcpServices>;
  /** The Remote runtime's revocation, shared with `aiden remote revoke`. */
  revokeDevice(deviceId: string): Promise<boolean>;
  appVersion: string;
  defaultPort?: number;
}

/** The server's MCP host, wired like the desktop's, with its files in the agent directory. */
export function createCliMcpHost(options: CliMcpHostOptions): AidenMcpHost {
  const provenanceFile = join(options.agentDir, CLI_MCP_PROVENANCE_FILE);
  const provenance = new AidenMcpProvenanceLog({
    load: async () => parseAidenMcpProvenanceDocument(readJson<unknown>(provenanceFile, emptyAidenMcpProvenanceDocument())),
    save: async (document) => atomicJson(provenanceFile, document),
  });
  const tools = new AidenMcpToolRunner({
    services: options.services,
    acquireAuthorization: (appId, tracksMutationDrain) => options.state.acquireDeviceAuthorization(appId, tracksMutationDrain),
    recordProvenance: (chatId, entry) => provenance.record(chatId, entry),
    appVersion: options.appVersion,
    hostName: async () => (await options.state.snapshot()).displayName,
  });
  return new AidenMcpHost({
    state: options.state,
    tools,
    supported: () => hostPlatformCapabilities().mcpServer,
    defaultPort: options.defaultPort ?? CLI_MCP_DEFAULT_PORT,
    revokeDevice: options.revokeDevice,
    appVersion: options.appVersion,
    // Category-only, as on the desktop: never a credential, app name, chat or path.
    log: (event, details) => {
      const problem = typeof details?.problem === "string" ? ` (${details.problem})` : "";
      if (event === "start-failed") process.stderr.write(`aiden: The MCP server could not start${problem}.\n`);
    },
  });
}

export const CLI_APPS_USAGE = "Usage: apps list | connect <name> [--access read|supervised] | revoke <app-id> | on | off";

/** Daemon side of `aiden apps`. Sends no analytics. */
export async function cliAppsCommand(host: AidenMcpHost, args: string[]): Promise<unknown> {
  const [action = "list", ...rest] = args;
  switch (action) {
    case "list":
      if (rest.length) throw new Error(CLI_APPS_USAGE);
      return { server: await host.status(), apps: await host.listApps() };
    case "connect": {
      const { name, access } = parseConnectArgs(rest);
      // The server stays off until an app is connected. Turning it on before
      // the token is issued means no failure here can lose a token.
      await host.setEnabled(true);
      const issued = await host.issueApp({ name, access });
      const connection: CliAppConnection = { app: issued.app, token: issued.credential, server: await host.status() };
      return connection;
    }
    case "revoke": {
      if (rest.length !== 1 || !rest[0]) throw new Error("Usage: apps revoke <app-id> (see `aiden apps list`)");
      const revoked = await host.revokeApp(rest[0]);
      if (!revoked) throw new Error("No connected app has that id. See `aiden apps list`.");
      return { revoked };
    }
    case "on":
    case "off":
      if (rest.length) throw new Error(CLI_APPS_USAGE);
      return host.setEnabled(action === "on");
    default:
      throw new Error(CLI_APPS_USAGE);
  }
}

function parseConnectArgs(args: string[]): { name: string; access: AidenRemoteAgentAccess } {
  const words: string[] = [];
  let access: AidenRemoteAgentAccess = "read";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--access" || arg.startsWith("--access=")) {
      const value = arg === "--access" ? args[++index] : arg.slice("--access=".length);
      if (value !== "read" && value !== "supervised") throw new Error("Access is read or supervised.");
      access = value;
    } else if (arg.startsWith("--")) {
      throw new Error(CLI_APPS_USAGE);
    } else {
      words.push(arg);
    }
  }
  const name = words.join(" ").trim();
  if (!name) throw new Error("Name the app, for example `aiden apps connect \"Claude Code\"`.");
  if ([...name].length > 80) throw new Error("An app name is at most 80 characters.");
  return { name, access };
}
