import type { McpServer } from "../types.js";
import {
  MAX_SUBAGENT_MCP_SCOPES,
  MAX_SUBAGENT_MCP_TOOLS_PER_SCOPE,
  type SubagentMcpScopeV2,
} from "./authority-v2.js";
import {
  inspectSubagentMcpServer,
  subagentMcpConnectionFingerprint,
  type InspectedSubagentMcpServer,
  type SubagentMcpReadHost,
} from "./subagent-mcp-read.js";

export const SUBAGENT_MCP_DISCOVERY_DEADLINE_MS = 3_000;
export const SUBAGENT_MCP_INVENTORY_CACHE_TTL_MS = 5 * 60_000;
export const SUBAGENT_MCP_FAILURE_BACKOFF_INITIAL_MS = 30_000;
const MAX_CACHE_ENTRIES = 32;

interface CacheEntry {
  fingerprint: string;
  expiresAt: number;
  inspected?: InspectedSubagentMcpServer;
  failures: number;
}

export class SubagentMcpInventoryCache {
  private readonly entries = new Map<string, CacheEntry>();

  get(serverId: string, fingerprint: string, now: number) {
    const entry = this.entries.get(serverId);
    if (!entry || entry.fingerprint !== fingerprint) {
      if (entry) this.entries.delete(serverId);
      return undefined;
    }
    if (entry.expiresAt <= now) {
      // Retain expired failure metadata so the next failed attempt advances
      // exponential backoff. Successful entries can be discarded normally.
      if (entry.inspected) this.entries.delete(serverId);
      return undefined;
    }
    this.entries.delete(serverId);
    this.entries.set(serverId, entry);
    return entry.inspected ?? null;
  }

  set(
    inspected: InspectedSubagentMcpServer,
    now: number,
    ttlMs = SUBAGENT_MCP_INVENTORY_CACHE_TTL_MS,
  ): void {
    this.entries.delete(inspected.serverId);
    while (this.entries.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(inspected.serverId, {
      fingerprint: inspected.connectionFingerprint,
      expiresAt: now + ttlMs,
      inspected,
      failures: 0,
    });
  }

  setFailure(serverId: string, fingerprint: string, now: number): void {
    const previous = this.entries.get(serverId);
    const failures = previous?.fingerprint === fingerprint ? previous.failures + 1 : 1;
    const backoff = Math.min(
      SUBAGENT_MCP_INVENTORY_CACHE_TTL_MS,
      SUBAGENT_MCP_FAILURE_BACKOFF_INITIAL_MS * 2 ** (failures - 1),
    );
    this.entries.delete(serverId);
    while (this.entries.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(serverId, {
      fingerprint,
      expiresAt: now + backoff,
      failures,
    });
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface SubagentMcpInventoryCoreDependencies {
  listServers(): Promise<readonly McpServer[]>;
  withClient: SubagentMcpReadHost["withClient"];
  resolveCredentialRevision(server: McpServer, signal: AbortSignal): Promise<string>;
  cache: SubagentMcpInventoryCache;
  now?: () => number;
  discoveryDeadlineMs?: number;
  bypassCache?: boolean;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("MCP inventory discovery cancelled.");
}

function projectInventory(inspected: readonly InspectedSubagentMcpServer[]): SubagentMcpScopeV2[] {
  return inspected
    .slice()
    .sort((left, right) => left.serverId.localeCompare(right.serverId))
    .slice(0, MAX_SUBAGENT_MCP_SCOPES)
    .flatMap((server) => {
      const tools = server.tools
        .slice()
        .sort((left, right) => left.toolName.localeCompare(right.toolName))
        .slice(0, MAX_SUBAGENT_MCP_TOOLS_PER_SCOPE)
        .map((tool) => structuredClone(tool));
      return tools.length === 0
        ? []
        : [
            {
              serverId: server.serverId,
              connectionFingerprint: server.connectionFingerprint,
              tools,
            },
          ];
    });
}

/** Bounded discovery with exact credential-aware caching and partial timeout success. */
export async function resolveBoundedSubagentMcpInventory(
  parentSignal: AbortSignal,
  dependencies: SubagentMcpInventoryCoreDependencies,
): Promise<SubagentMcpScopeV2[]> {
  if (parentSignal.aborted) throw abortReason(parentSignal);
  const now = dependencies.now ?? Date.now;
  const deadlineMs = dependencies.discoveryDeadlineMs ?? SUBAGENT_MCP_DISCOVERY_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000) {
    throw new Error("Invalid subagent MCP discovery deadline.");
  }
  const controller = new AbortController();
  let resolveAborted!: () => void;
  const aborted = new Promise<"aborted">((resolve) => {
    resolveAborted = () => resolve("aborted");
  });
  const relay = () => {
    controller.abort(abortReason(parentSignal));
    resolveAborted();
  };
  parentSignal.addEventListener("abort", relay, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timeout = setTimeout(() => resolve("deadline"), deadlineMs);
    // This timer is the only guaranteed settlement path when configuration
    // loading or an MCP connection never resolves. Keeping it referenced is
    // necessary for callers (and Node's test runner) to receive the bounded
    // empty result instead of being left with a pending promise as the event
    // loop drains.
  });
  const completed: InspectedSubagentMcpServer[] = [];
  try {
    const listed = await Promise.race([
      dependencies.listServers().then(
        (servers) => ({ kind: "servers" as const, servers }),
        () => ({ kind: "servers" as const, servers: [] as readonly McpServer[] }),
      ),
      deadline.then((kind) => ({ kind })),
      aborted.then((kind) => ({ kind })),
    ]);
    if (listed.kind === "aborted") throw abortReason(parentSignal);
    if (listed.kind === "deadline") {
      controller.abort(new Error("MCP inventory discovery deadline elapsed."));
      return [];
    }
    const servers = listed.servers
      .filter((server) => server.enabled && server.transport !== "stdio")
      .slice(0, MAX_SUBAGENT_MCP_SCOPES);
    const tasks = servers.map(async (server) => {
      let fingerprint: string | undefined;
      try {
        const credentialRevision = await dependencies.resolveCredentialRevision(
          server,
          controller.signal,
        );
        fingerprint = subagentMcpConnectionFingerprint(server, credentialRevision);
        const cached = dependencies.bypassCache
          ? undefined
          : dependencies.cache.get(server.id, fingerprint, now());
        if (cached === null) return;
        if (cached) {
          completed.push(cached);
          return;
        }
        const inspected = await inspectSubagentMcpServer({
          server,
          withClient: dependencies.withClient,
          signal: controller.signal,
        });
        if (controller.signal.aborted) throw abortReason(controller.signal);
        if (inspected.connectionFingerprint !== fingerprint) {
          throw new Error("MCP credential revision changed during discovery.");
        }
        dependencies.cache.set(inspected, now());
        completed.push(inspected);
      } catch (error) {
        if (fingerprint && !parentSignal.aborted) {
          dependencies.cache.setFailure(server.id, fingerprint, now());
        }
        throw error;
      }
    });
    const settled = Promise.allSettled(tasks);
    const outcome = await Promise.race([settled.then(() => "settled" as const), deadline, aborted]);
    if (outcome === "aborted") throw abortReason(parentSignal);
    controller.abort(new Error("MCP inventory discovery deadline elapsed."));
    return projectInventory(completed);
  } finally {
    if (timeout) clearTimeout(timeout);
    parentSignal.removeEventListener("abort", relay);
  }
}
