import { BOT_CAPABILITY_LIMITS } from "../../renderer/shared/bot-capabilities.js";
import { botCapabilityFactsFingerprint } from "./bot-capability-catalog-core.js";
import type { BotCapabilityIncarnationStore } from "./bot-capability-incarnation-store.js";
import { mcpAuthorityConnectionSnapshot } from "./mcp-credential-cleanup-core.js";
import type { McpServer } from "./types.js";
import {
  normalizeSubagentMcpInventoryV2,
  type SubagentMcpRemoteTool,
} from "./subagents/subagent-mcp-read.js";
import type { SubagentMcpScopeV2 } from "./subagents/authority-v2.js";

type BotMcpScopeTools = SubagentMcpScopeV2["tools"];

export const BOT_MCP_DISCOVERY_DEADLINE_MS = 10_000;
/** How long a verified scope is reused before the server is inspected again. */
export const BOT_MCP_SCOPE_TTL_MS = 60_000;
/** How long a verified scope survives a transient failure or timeout of the same connection. */
export const BOT_MCP_SCOPE_GRACE_MS = 5 * 60_000;

export type BotMcpInspectionFailure = "timed_out" | "failed";

export interface BotMcpInspectionFailureReport {
  readonly server: McpServer;
  readonly kind: BotMcpInspectionFailure;
  readonly error: unknown;
  /** True when the server's last verified scope was kept for its grace window. */
  readonly keptLastGood: boolean;
}

export interface BotMcpInventoryDependencies {
  listServers(): Promise<readonly McpServer[]>;
  credentialSignature(server: McpServer, signal: AbortSignal): Promise<string>;
  inspectTools(server: McpServer, signal: AbortSignal): Promise<readonly SubagentMcpRemoteTool[]>;
  incarnations: Pick<BotCapabilityIncarnationStore, "reconcileNamespace">;
  deadlineMs?: number;
  /** Shared scope cache; without one every call inspects every server afresh. */
  scopeCache?: BotMcpScopeCache;
  /** Per-server inspection failures, for diagnostics. Never throws into discovery. */
  reportFailure?(report: BotMcpInspectionFailureReport): void;
}

export interface BotMcpConnectionIdentity {
  readonly serverId: string;
  readonly connectionFingerprint: string;
}

type BotMcpConnectionIdentityDependencies = Pick<
  BotMcpInventoryDependencies,
  "listServers" | "credentialSignature" | "incarnations"
>;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Bot MCP inventory discovery was cancelled.");
}

/**
 * Resolve the durable, rollback-resistant connection identities used by Bot
 * grants. Child MCP inventories retain their process-owned fingerprints, so a
 * caller must positively join them through this fresh identity snapshot rather
 * than comparing two intentionally different credential domains.
 */
export async function resolveBotMcpConnectionIdentities(
  signal: AbortSignal,
  dependencies: BotMcpConnectionIdentityDependencies,
): Promise<readonly BotMcpConnectionIdentity[]> {
  if (signal.aborted) throw abortReason(signal);
  const servers = [...(await dependencies.listServers())]
    .filter((server) => !server.authProvider)
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, BOT_CAPABILITY_LIMITS.connections);
  if (signal.aborted) throw abortReason(signal);
  const signatures = await Promise.all(
    servers.map((server) => dependencies.credentialSignature(server, signal)),
  );
  if (signal.aborted) throw abortReason(signal);
  const incarnations = await dependencies.incarnations.reconcileNamespace(
    "mcp",
    servers.map((server, index) => ({
      sourceId: server.id,
      credentialSignature: signatures[index]!,
    })),
  );
  if (signal.aborted) throw abortReason(signal);
  const incarnationById = new Map(
    incarnations.map((value) => [value.sourceId, value] as const),
  );
  return servers.map((server) => {
    const incarnation = incarnationById.get(server.id);
    if (!incarnation) throw new Error("Bot MCP incarnation was not resolved.");
    return {
      serverId: server.id,
      connectionFingerprint: botCapabilityFactsFingerprint({
        // Display name, description, and the enabled flag are not authority:
        // renaming a connection keeps its grants; enablement is checked where used.
        authority: mcpAuthorityConnectionSnapshot(server),
        resourceIncarnation: incarnation.resourceIncarnation,
        credentialIncarnation: incarnation.credentialIncarnation,
      }),
    };
  });
}

export class BotMcpInspectionTimeoutError extends Error {
  readonly name = "TimeoutError";

  constructor() {
    super("Bot MCP server inspection deadline elapsed.");
  }
}

interface ScopeCacheEntry {
  readonly connectionFingerprint: string;
  readonly generation: number;
  readonly verifiedAt: number;
  readonly tools: BotMcpScopeTools;
}

export interface BotMcpScopeCacheOptions {
  ttlMs?: number;
  graceMs?: number;
  /** Upper bound for one shared inspection, independent of any caller's deadline. */
  inspectionDeadlineMs?: number;
  now?: () => number;
  /**
   * Configuration fence. A cached scope is reused only while this value is
   * unchanged, so an MCP configuration or credential mutation forces a fresh
   * inspection even when the connection fingerprint happens to match.
   */
  generation?: () => number;
}

export interface BotMcpScopeCache {
  /** Verified tools for this exact connection: cached within the TTL, otherwise one shared inspection. */
  inspect(
    server: McpServer,
    connectionFingerprint: string,
    signal: AbortSignal,
    inspect: (server: McpServer, signal: AbortSignal) => Promise<readonly SubagentMcpRemoteTool[]>,
  ): Promise<BotMcpScopeTools>;
  /** The last verified tools for this exact connection, while inside the grace window. */
  lastGood(serverId: string, connectionFingerprint: string): BotMcpScopeTools | undefined;
  clear(): void;
}

function projectScopeTools(tools: readonly SubagentMcpRemoteTool[]): BotMcpScopeTools {
  return normalizeSubagentMcpInventoryV2(tools).map((tool) =>
    tool.effect === "read"
      ? { toolName: tool.toolName, schemaHash: tool.schemaHash, effect: tool.effect }
      : {
          toolName: tool.toolName,
          schemaHash: tool.schemaHash,
          effect: tool.effect,
          effectProfile: { ...tool.effectProfile },
        },
  );
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Bot tool calls admit and revalidate against a fresh catalog snapshot. Without
 * this cache each snapshot opened a new MCP client per server (spawning stdio
 * servers) two or three times per tool call. Entries are keyed by server id and
 * the durable connection fingerprint (configuration authority plus resource and
 * credential incarnations), so any authority change misses the cache.
 */
export function createBotMcpScopeCache(options: BotMcpScopeCacheOptions = {}): BotMcpScopeCache {
  const ttlMs = options.ttlMs ?? BOT_MCP_SCOPE_TTL_MS;
  const graceMs = options.graceMs ?? BOT_MCP_SCOPE_GRACE_MS;
  const inspectionDeadlineMs = options.inspectionDeadlineMs ?? BOT_MCP_DISCOVERY_DEADLINE_MS;
  const now = options.now ?? Date.now;
  const generation = options.generation ?? (() => 0);
  const entries = new Map<string, ScopeCacheEntry>();
  const inflight = new Map<string, Promise<BotMcpScopeTools>>();

  const flight = (
    server: McpServer,
    connectionFingerprint: string,
    currentGeneration: number,
    inspect: (server: McpServer, signal: AbortSignal) => Promise<readonly SubagentMcpRemoteTool[]>,
  ): Promise<BotMcpScopeTools> => {
    const key = JSON.stringify([server.id, connectionFingerprint, currentGeneration]);
    const existing = inflight.get(key);
    if (existing) return existing;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new BotMcpInspectionTimeoutError()),
      inspectionDeadlineMs,
    );
    const pending = raceAbort(
      Promise.resolve().then(() => inspect(server, controller.signal)),
      controller.signal,
    )
      .then((remote) => {
        const tools = projectScopeTools(remote);
        entries.set(server.id, {
          connectionFingerprint,
          generation: currentGeneration,
          verifiedAt: now(),
          tools,
        });
        return tools;
      })
      .finally(() => {
        clearTimeout(timeout);
        controller.abort(new Error("Bot MCP server inspection completed."));
        inflight.delete(key);
      });
    inflight.set(key, pending);
    return pending;
  };

  return {
    async inspect(server, connectionFingerprint, signal, inspect) {
      if (signal.aborted) throw abortReason(signal);
      const currentGeneration = generation();
      const entry = entries.get(server.id);
      if (
        entry &&
        entry.connectionFingerprint === connectionFingerprint &&
        entry.generation === currentGeneration &&
        now() - entry.verifiedAt < ttlMs
      ) {
        return entry.tools;
      }
      return raceAbort(flight(server, connectionFingerprint, currentGeneration, inspect), signal);
    },
    lastGood(serverId, connectionFingerprint) {
      const entry = entries.get(serverId);
      if (!entry || entry.connectionFingerprint !== connectionFingerprint) return undefined;
      return now() - entry.verifiedAt < graceMs ? entry.tools : undefined;
    },
    clear() {
      entries.clear();
    },
  };
}

/**
 * Bot-owned MCP discovery. It intentionally does not reuse the subagent
 * catalog cache or its 16-server/32-tool authority projection.
 *
 * Each server stands alone: one that fails or misses the deadline drops only
 * its own scope (or keeps its last verified scope for the same connection
 * during the grace window), never the scopes of servers that finished.
 */
export async function resolveBotMcpInventory(
  parentSignal: AbortSignal,
  dependencies: BotMcpInventoryDependencies,
): Promise<readonly SubagentMcpScopeV2[]> {
  if (parentSignal.aborted) throw abortReason(parentSignal);
  const deadlineMs = dependencies.deadlineMs ?? BOT_MCP_DISCOVERY_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000) {
    throw new Error("Bot MCP discovery deadline is invalid.");
  }
  const cache =
    dependencies.scopeCache ??
    createBotMcpScopeCache({ ttlMs: 0, graceMs: 0, inspectionDeadlineMs: deadlineMs });
  const controller = new AbortController();
  const relay = () => controller.abort(abortReason(parentSignal));
  parentSignal.addEventListener("abort", relay, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error("Bot MCP inventory discovery deadline elapsed.")),
    deadlineMs,
  );
  let resolveCancelled!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });
  controller.signal.addEventListener("abort", resolveCancelled, { once: true });
  const report = (value: BotMcpInspectionFailureReport) => {
    try {
      dependencies.reportFailure?.(value);
    } catch {
      // Diagnostics never change authority.
    }
  };
  let enabledServers: McpServer[] | undefined;
  let identityById: Map<string, BotMcpConnectionIdentity> | undefined;
  const verified = new Map<string, BotMcpScopeTools>();
  const failed = new Set<string>();
  try {
    const work = (async () => {
      const servers = [...(await dependencies.listServers())]
        .filter((server) => !server.authProvider)
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, BOT_CAPABILITY_LIMITS.connections);
      const identities = await resolveBotMcpConnectionIdentities(controller.signal, {
        listServers: async () => servers,
        credentialSignature: dependencies.credentialSignature,
        incarnations: dependencies.incarnations,
      });
      identityById = new Map(identities.map((value) => [value.serverId, value] as const));
      enabledServers = servers.filter(({ enabled }) => enabled);
      await Promise.all(
        enabledServers.map(async (server) => {
          const identity = identityById!.get(server.id);
          if (!identity) throw new Error("Bot MCP connection identity was not resolved.");
          try {
            const tools = await cache.inspect(
              server,
              identity.connectionFingerprint,
              controller.signal,
              dependencies.inspectTools,
            );
            if (!controller.signal.aborted) verified.set(server.id, tools);
          } catch (error) {
            // A deadline abort is reported once below, with the other stragglers.
            if (controller.signal.aborted) return;
            failed.add(server.id);
            const kept = cache.lastGood(server.id, identity.connectionFingerprint);
            report({
              server,
              kind: error instanceof BotMcpInspectionTimeoutError ? "timed_out" : "failed",
              error,
              keptLastGood: Boolean(kept?.length),
            });
          }
        }),
      );
    })();
    // A straggler that rejects after the deadline must not surface as unhandled.
    work.catch(() => undefined);
    await Promise.race([work, cancelled]);
    if (parentSignal.aborted) throw abortReason(parentSignal);
    // Discovery ended before connection identities existed: nothing can be bound.
    if (!enabledServers || !identityById) return [];
    const scopes: SubagentMcpScopeV2[] = [];
    for (const server of enabledServers) {
      const identity = identityById.get(server.id);
      if (!identity) continue;
      let tools = verified.get(server.id);
      if (!tools) {
        tools = cache.lastGood(server.id, identity.connectionFingerprint);
        if (!failed.has(server.id)) {
          report({
            server,
            kind: "timed_out",
            error: abortReason(controller.signal),
            keptLastGood: Boolean(tools?.length),
          });
        }
      }
      if (!tools || tools.length === 0) continue;
      scopes.push({
        serverId: server.id,
        connectionFingerprint: identity.connectionFingerprint,
        tools,
      });
    }
    return scopes.sort((left, right) => left.serverId.localeCompare(right.serverId));
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", relay);
    controller.signal.removeEventListener("abort", resolveCancelled);
    controller.abort(new Error("Bot MCP inventory discovery completed."));
  }
}
