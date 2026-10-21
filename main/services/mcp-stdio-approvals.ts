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
// The configured launch plus editor saves whose publication is not confirmed yet.
const MAX_PER_SERVER = 4;
const FINGERPRINT = /^[a-f0-9]{64}$/u;

export class McpStdioApprovalRequiredError extends Error {
  readonly code = "mcp-stdio-approval-required";
  constructor(serverName: string) {
    super(`“${serverName}” was added outside Aiden. Approve it in Settings → Connectors before it can run.`);
  }
}

/** Server id → approved launch fingerprints, oldest first. */
type Approvals = Map<string, string[]>;

function parse(text: string): Approvals {
  const value: unknown = JSON.parse(text);
  const approved = (value as { approved?: unknown } | null)?.approved;
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1 || !approved || typeof approved !== "object" || Array.isArray(approved)) {
    throw new Error("Invalid MCP stdio approvals.");
  }
  const result: Approvals = new Map();
  for (const [id, entry] of Object.entries(approved)) {
    const fingerprints = (Array.isArray(entry) ? entry : [entry])
      .filter((fingerprint): fingerprint is string => typeof fingerprint === "string" && FINGERPRINT.test(fingerprint));
    if (fingerprints.length > 0) result.set(id, fingerprints.slice(-MAX_PER_SERVER));
  }
  return result;
}

export interface McpStdioApprovalStore {
  /** Non-stdio servers need no approval. */
  isApproved(server: McpServer): Promise<boolean>;
  /** Approve exactly this launch, replacing the server's other approvals. */
  approve(server: McpServer): Promise<void>;
  /**
   * Approve this launch alongside the server's current approvals: an editor
   * save before publication, so a failed or cancelled publication leaves the
   * still-configured launch approved.
   */
  approveAlongside(server: McpServer): Promise<void>;
  /**
   * Keep only the approval of `configured` (the authoritative record), and
   * only if it was already approved; drop everything for a removed or remote
   * server. Never approves anything new.
   */
  retainOnly(serverId: string, configured: McpServer | undefined): Promise<void>;
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
  const read = async (): Promise<Approvals> => {
    try {
      return parse(await fs.readFile(await file(), "utf8"));
    } catch {
      // Missing or unreadable approvals approve nothing (fail closed).
      return new Map();
    }
  };
  const write = async (approved: Approvals) => {
    const entries = [...approved].slice(-MAX_APPROVALS);
    await writeJsonAtomic(await file(), { version: 1, approved: Object.fromEntries(entries) }, { mode: 0o600, space: 2 });
  };
  const sameList = (left: readonly string[] | undefined, right: readonly string[]) =>
    left !== undefined && left.length === right.length && left.every((value, index) => value === right[index]);
  return {
    async isApproved(server) {
      if (server.transport !== "stdio") return true;
      await tail;
      return (await read()).get(server.id)?.includes(mcpStdioLaunchFingerprint(server)) === true;
    },
    approve(server) {
      return serialized(async () => {
        if (server.transport !== "stdio") return;
        const approved = await read();
        const next = [mcpStdioLaunchFingerprint(server)];
        if (sameList(approved.get(server.id), next)) return;
        approved.delete(server.id);
        approved.set(server.id, next);
        await write(approved);
      });
    },
    approveAlongside(server) {
      return serialized(async () => {
        if (server.transport !== "stdio") return;
        const approved = await read();
        const fingerprint = mcpStdioLaunchFingerprint(server);
        const existing = approved.get(server.id) ?? [];
        if (existing.includes(fingerprint)) return;
        approved.delete(server.id);
        approved.set(server.id, [...existing, fingerprint].slice(-MAX_PER_SERVER));
        await write(approved);
      });
    },
    retainOnly(serverId, configured) {
      return serialized(async () => {
        const approved = await read();
        const existing = approved.get(serverId);
        if (!existing) return;
        const keep = configured?.id === serverId && configured.transport === "stdio"
          ? mcpStdioLaunchFingerprint(configured)
          : undefined;
        if (keep !== undefined && existing.includes(keep)) {
          if (sameList(existing, [keep])) return;
          approved.set(serverId, [keep]);
        } else {
          approved.delete(serverId);
        }
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

/**
 * Publish a saved record together with its launch approval. Before
 * publication the approval is only added, so the configured launch stays
 * approved; once the record is published, approvals are pruned to its launch.
 * A failed publication prunes nothing: the write may have reached disk
 * before failing, and the in-memory config can still be the old one, so
 * pruning here could drop the approval of the launch that is now configured.
 * The next successful save prunes to its published launch.
 */
export async function publishWithLaunchApproval(
  approvals: McpStdioApprovalStore,
  staged: McpServer,
  approve: boolean,
  publish: () => Promise<McpServer>,
): Promise<McpServer> {
  if (approve) await approvals.approveAlongside(staged);
  const saved = await publish();
  await approvals.retainOnly(staged.id, saved);
  return saved;
}
