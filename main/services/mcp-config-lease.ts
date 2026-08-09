import {
  mcpRuntimeConnectionSnapshot,
  sameMcpRuntimeConnection,
} from "./mcp-credential-cleanup-core.js";
import type { McpServer } from "./types.js";

const MAX_SERVER_ID_CHARS = 256;
const INVALIDATED = "MCP server configuration changed.";

export interface McpConfigurationLease {
  readonly serverId: string;
  readonly epoch: number;
  readonly signal: AbortSignal;
  /** Synchronous fence for the instruction immediately before raw dispatch. */
  assertCurrent(): void;
}

function validServerId(serverId: string): boolean {
  return (
    typeof serverId === "string" &&
    serverId.length > 0 &&
    serverId.length <= MAX_SERVER_ID_CHARS &&
    !serverId.includes("\0")
  );
}

/**
 * Main-owned per-server epoch. Invalidation aborts every holder of the old
 * epoch synchronously; acquiring the next epoch never revives an old lease.
 */
export class McpConfigurationLeaseRegistry {
  private readonly entries = new Map<string, { epoch: number; controller: AbortController }>();

  private entry(serverId: string) {
    if (!validServerId(serverId)) {
      throw new Error("Invalid MCP server configuration lease identity.");
    }
    let entry = this.entries.get(serverId);
    if (!entry) {
      entry = { epoch: 1, controller: new AbortController() };
      this.entries.set(serverId, entry);
    }
    return entry;
  }

  acquire(serverId: string): McpConfigurationLease {
    const entry = this.entry(serverId);
    const epoch = entry.epoch;
    const controller = entry.controller;
    return Object.freeze({
      serverId,
      epoch,
      signal: controller.signal,
      assertCurrent: () => {
        const current = this.entries.get(serverId);
        if (
          controller.signal.aborted ||
          !current ||
          current.epoch !== epoch ||
          current.controller !== controller
        ) {
          throw new Error(INVALIDATED);
        }
      },
    });
  }

  invalidate(serverId: string): void {
    const entry = this.entry(serverId);
    if (entry.epoch >= Number.MAX_SAFE_INTEGER) {
      throw new Error("MCP server configuration epoch was exhausted.");
    }
    this.entries.set(serverId, {
      epoch: entry.epoch + 1,
      controller: new AbortController(),
    });
    entry.controller.abort(new Error(INVALIDATED));
  }
}

export const mcpConfigurationLeases = new McpConfigurationLeaseRegistry();

/** Fence leases on both sides of a successful credential/config publication. */
export async function withMcpConfigurationPublication<T>(
  serverId: string,
  publish: () => Promise<T>,
  registry: McpConfigurationLeaseRegistry = mcpConfigurationLeases,
): Promise<T> {
  registry.invalidate(serverId);
  const result = await publish();
  registry.invalidate(serverId);
  return result;
}

/** Invalidate only servers whose runtime authority changed. */
export function invalidateChangedMcpConfigurationLeases(
  previous: readonly McpServer[],
  current: readonly McpServer[],
  registry: McpConfigurationLeaseRegistry = mcpConfigurationLeases,
): void {
  const before = new Map(previous.map((server) => [server.id, server]));
  const after = new Map(current.map((server) => [server.id, server]));
  for (const serverId of new Set([...before.keys(), ...after.keys()])) {
    const left = before.get(serverId);
    const right = after.get(serverId);
    if (
      !sameMcpRuntimeConnection(
        left ? mcpRuntimeConnectionSnapshot(left) : null,
        right ? mcpRuntimeConnectionSnapshot(right) : null,
      )
    ) {
      registry.invalidate(serverId);
    }
  }
}
