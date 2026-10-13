// Main-owned approvals for local (stdio) MCP servers. A stdio server runs its
// command only when its exact launch fingerprint (command, arguments, env
// names and value hashes) was approved on this device: by saving it from the
// Settings editor or by choosing Approve. A server added or changed by editing
// config.json by hand stays unapproved and never runs. The file lives in
// Aiden's application-support folder, never in the portable config.

import * as fs from "node:fs/promises";
import { mcpStdioLaunchFingerprint } from "./mcp-field-secrets-core.js";
import { writeJsonAtomic } from "./durable-fs.js";
import type { McpServer } from "./types.js";

const MAX_APPROVALS = 256;
const FINGERPRINT = /^[a-f0-9]{64}$/u;

export class McpStdioApprovalRequiredError extends Error {
  readonly code = "mcp-stdio-approval-required";
  constructor(serverName: string) {
    super(`“${serverName}” was added outside Aiden. Approve it in Settings → Plugins before it can run.`);
  }
}

function parse(text: string): Map<string, string> {
  const value: unknown = JSON.parse(text);
  const approved = (value as { approved?: unknown } | null)?.approved;
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1 || !approved || typeof approved !== "object" || Array.isArray(approved)) {
    throw new Error("Invalid MCP stdio approvals.");
  }
  return new Map(Object.entries(approved).filter((entry): entry is [string, string] => typeof entry[1] === "string" && FINGERPRINT.test(entry[1])));
}

export interface McpStdioApprovalStore {
  /** Non-stdio servers need no approval. */
  isApproved(server: McpServer): Promise<boolean>;
  approve(server: McpServer): Promise<void>;
  /** Approve `server` only if it still has the fingerprint the user was shown. */
  approveShown(server: McpServer, shownFingerprint: string): Promise<boolean>;
  forget(serverId: string): Promise<void>;
}

export function createMcpStdioApprovalStore(file: () => Promise<string>): McpStdioApprovalStore {
  let tail: Promise<unknown> = Promise.resolve();
  const serialized = <R>(operation: () => Promise<R>): Promise<R> => {
    const result = tail.then(operation, operation);
    tail = result.catch(() => undefined);
    return result;
  };
  const read = async (): Promise<Map<string, string>> => {
    try {
      return parse(await fs.readFile(await file(), "utf8"));
    } catch {
      // Missing or unreadable approvals approve nothing (fail closed).
      return new Map();
    }
  };
  const write = async (approved: Map<string, string>) => {
    const entries = [...approved].slice(-MAX_APPROVALS);
    await writeJsonAtomic(await file(), { version: 1, approved: Object.fromEntries(entries) }, { mode: 0o600, space: 2 });
  };
  return {
    async isApproved(server) {
      if (server.transport !== "stdio") return true;
      await tail;
      return (await read()).get(server.id) === mcpStdioLaunchFingerprint(server);
    },
    approve(server) {
      return serialized(async () => {
        if (server.transport !== "stdio") return;
        const approved = await read();
        const fingerprint = mcpStdioLaunchFingerprint(server);
        if (approved.get(server.id) === fingerprint) return;
        approved.delete(server.id);
        approved.set(server.id, fingerprint);
        await write(approved);
      });
    },
    async approveShown(server, shownFingerprint) {
      if (server.transport !== "stdio" || mcpStdioLaunchFingerprint(server) !== shownFingerprint) return false;
      await this.approve(server);
      return true;
    },
    forget(serverId) {
      return serialized(async () => {
        const approved = await read();
        if (!approved.delete(serverId)) return;
        await write(approved);
      });
    },
  };
}
