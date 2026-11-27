import { BOT_CAPABILITY_LIMITS } from "../../renderer/shared/bot-capabilities.js";
import { botCapabilityFactsFingerprint } from "./bot-capability-catalog-core.js";
import type { BotCapabilityIncarnationStore } from "./bot-capability-incarnation-store.js";
import { mcpAuthorityConnectionSnapshot } from "./mcp-credential-cleanup-core.js";
import type { McpServer } from "./types.js";
import { mcpServerOffersTools, mcpToolsOfferedToModel } from "../../renderer/shared/mcp-exposure.js";
import {
  normalizeSubagentMcpInventoryV2,
  type SubagentMcpRemoteTool,
} from "./subagents/subagent-mcp-read.js";
import type { SubagentMcpScopeV2 } from "./subagents/authority-v2.js";
import { botConnectorInventoryServer } from "./bot-connector-inventory-scope.js";
import { projectComposioServiceInventory } from "./composio-service-tool.js";

type BotMcpScopeTools = SubagentMcpScopeV2["tools"];

export const BOT_MCP_DISCOVERY_DEADLINE_MS = 10_000;
/** How long a verified scope is reused before the server is inspected again. */
export const BOT_MCP_SCOPE_TTL_MS = 60_000;
/** How long a verified scope survives a transient failure or timeout of the same connection. */
export const BOT_MCP_SCOPE_GRACE_MS = 5 * 60_000;
/** First wait before a failed connection is inspected again; doubles per failure. */
export const BOT_MCP_FAILURE_BACKOFF_MS = 30_000;
/** Longest wait between background retries of a connection that keeps failing. */
export const BOT_MCP_FAILURE_BACKOFF_MAX_MS = 5 * 60_000;

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

/**
 * The connection failed recently and is retried in the background. A Bot turn
 * does not wait for it; the failure was already reported once.
 */
export class BotMcpInspectionBackoffError extends Error {
  readonly name = "BotMcpInspectionBackoffError";

  constructor(readonly kind: BotMcpInspectionFailure) {
    super("Bot MCP server is unavailable; it is retried in the background.");
  }
}

interface FailureRecord {
  readonly connectionFingerprint: string;
  readonly generation: number;
  readonly kind: BotMcpInspectionFailure;
  readonly attempts: number;
  readonly retryAt: number;
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
  /**
   * Monotonic millisecond clock for cache ages and retry deadlines. Defaults to
   * `performance.now()` so a wall-clock correction cannot stretch a backoff.
   */
  now?: () => number;
  /**
   * Configuration fence. A cached scope is reused only while this value is
   * unchanged, so an MCP configuration or credential mutation forces a fresh
   * inspection even when the connection fingerprint happens to match.
   */
  generation?: () => number;
  /** First retry delay after a failure; doubles per consecutive failure. */
  failureBackoffMs?: number;
  /** Cap for the retry delay. */
  failureBackoffMaxMs?: number;
  /**
   * Failures of background inspections (stale refreshes and retries), which no
   * caller awaits. Each failed attempt is reported once. Never throws into the cache.
   */
  reportFailure?(report: BotMcpInspectionFailureReport): void;
}

export interface BotMcpScopeCache {
  /**
   * Verified tools for this exact connection. Within the TTL the cached tools
   * are returned; past it but within the grace window they are still returned
   * while one background inspection refreshes them. A connection that failed
   * recently rejects at once with {@link BotMcpInspectionBackoffError} and is
   * retried in the background on a backoff. Only a connection with neither
   * waits for an inspection.
   */
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
  const backoffMs = options.failureBackoffMs ?? BOT_MCP_FAILURE_BACKOFF_MS;
  const backoffMaxMs = options.failureBackoffMaxMs ?? BOT_MCP_FAILURE_BACKOFF_MAX_MS;
  const now = options.now ?? (() => performance.now());
  const generation = options.generation ?? (() => 0);
  const entries = new Map<string, ScopeCacheEntry>();
  const failures = new Map<string, FailureRecord>();
  const inflight = new Map<string, Promise<BotMcpScopeTools>>();

  const lastGood = (serverId: string, connectionFingerprint: string) => {
    const entry = entries.get(serverId);
    if (!entry || entry.connectionFingerprint !== connectionFingerprint) return undefined;
    return now() - entry.verifiedAt < graceMs ? entry.tools : undefined;
  };

  const recordFailure = (
    server: McpServer,
    connectionFingerprint: string,
    currentGeneration: number,
    error: unknown,
  ): FailureRecord => {
    const previous = failures.get(server.id);
    const attempts =
      previous && previous.connectionFingerprint === connectionFingerprint ? previous.attempts + 1 : 1;
    const delay = Math.min(backoffMaxMs, backoffMs * 2 ** Math.min(attempts - 1, 30));
    const record: FailureRecord = {
      connectionFingerprint,
      generation: currentGeneration,
      kind: error instanceof BotMcpInspectionTimeoutError ? "timed_out" : "failed",
      attempts,
      retryAt: now() + delay,
    };
    failures.set(server.id, record);
    return record;
  };

  const flight = (
    server: McpServer,
    connectionFingerprint: string,
    currentGeneration: number,
    connectorScope: string | undefined,
    inspect: (server: McpServer, signal: AbortSignal) => Promise<readonly SubagentMcpRemoteTool[]>,
  ): { pending: Promise<BotMcpScopeTools>; started: boolean } => {
    // An unattended watch must never inherit an in-progress foreground
    // inspection that may be creating a fresh authenticated transport.
    const key = JSON.stringify([server.id, connectionFingerprint, currentGeneration, connectorScope ?? null]);
    const existing = inflight.get(key);
    if (existing) return { pending: existing, started: false };
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new BotMcpInspectionTimeoutError()),
      inspectionDeadlineMs,
    );
    const pending = raceAbort(
      Promise.resolve().then(() => inspect(server, controller.signal)),
      controller.signal,
    )
      .then(
        (remote) => {
          const tools = projectScopeTools(projectComposioServiceInventory(server, remote));
          // A flight that outlived a configuration fence answers its own caller
          // but never overwrites (or clears) state from a newer generation.
          if (generation() !== currentGeneration) return tools;
          entries.set(server.id, {
            connectionFingerprint,
            generation: currentGeneration,
            verifiedAt: now(),
            tools,
          });
          const failure = failures.get(server.id);
          if (failure?.connectionFingerprint === connectionFingerprint) failures.delete(server.id);
          return tools;
        },
        (error: unknown) => {
          if (generation() === currentGeneration) {
            recordFailure(server, connectionFingerprint, currentGeneration, error);
          }
          throw error;
        },
      )
      .finally(() => {
        clearTimeout(timeout);
        controller.abort(new Error("Bot MCP server inspection completed."));
        inflight.delete(key);
      });
    inflight.set(key, pending);
    return { pending, started: true };
  };

  /** Start (or join) an inspection nobody awaits; report its failure once. */
  const refreshInBackground = (
    server: McpServer,
    connectionFingerprint: string,
    currentGeneration: number,
    connectorScope: string | undefined,
    inspect: (server: McpServer, signal: AbortSignal) => Promise<readonly SubagentMcpRemoteTool[]>,
  ) => {
    const { pending, started } = flight(server, connectionFingerprint, currentGeneration, connectorScope, inspect);
    pending.catch((error: unknown) => {
      if (!started) return;
      try {
        options.reportFailure?.({
          server,
          kind: error instanceof BotMcpInspectionTimeoutError ? "timed_out" : "failed",
          error,
          keptLastGood: Boolean(lastGood(server.id, connectionFingerprint)?.length),
        });
      } catch {
        // Diagnostics never change authority.
      }
    });
  };

  return {
    async inspect(server, connectionFingerprint, signal, inspect) {
      if (signal.aborted) throw abortReason(signal);
      const currentGeneration = generation();
      const entry = entries.get(server.id);
      const selected = botConnectorInventoryServer();
      const failure = failures.get(server.id);
      const failed = failure?.connectionFingerprint === connectionFingerprint ? failure : undefined;
      // A recent failure of this connection holds back retries until its backoff
      // ends; a configuration fence since then makes a retry due at once.
      const retryDue = !failed || failed.generation !== currentGeneration || now() >= failed.retryAt;
      if (
        entry &&
        entry.connectionFingerprint === connectionFingerprint &&
        entry.generation === currentGeneration
      ) {
        const age = now() - entry.verifiedAt;
        if (age < ttlMs) return entry.tools;
        // Stale but inside the grace window: answer now and refresh behind the turn.
        if (age < graceMs) {
          if (selected && selected !== server.id) throw new Error("Unattended watch admission cannot discover another connector.");
          if (retryDue) refreshInBackground(server, connectionFingerprint, currentGeneration, selected, inspect);
          return entry.tools;
        }
      }
      if (selected && selected !== server.id) throw new Error("Unattended watch admission cannot discover another connector.");
      if (failed) {
        if (retryDue) refreshInBackground(server, connectionFingerprint, currentGeneration, selected, inspect);
        throw new BotMcpInspectionBackoffError(failed.kind);
      }
      return raceAbort(
        flight(server, connectionFingerprint, currentGeneration, selected, inspect).pending,
        signal,
      );
    },
    lastGood,
    clear() {
      entries.clear();
      failures.clear();
    },
  };
}

/**
 * Bot-owned MCP discovery. It intentionally does not reuse the subagent
 * catalog cache or its 16-server/32-tool authority projection.
 *
 * Each server stands alone: one that fails or misses the deadline drops only
 * its own scope (or keeps its last verified scope for the same connection
 * during the grace window), never the scopes of servers that finished. With a
 * shared scope cache, a server that failed recently is skipped without waiting
 * and retried in the background, so one unreachable server cannot hold every
 * Bot turn to the deadline.
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
      // A server switched off for the model has no Bot scope at all.
      enabledServers = servers.filter((server) => server.enabled && mcpServerOffersTools(server));
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
            // Already reported when the attempt that started the backoff failed.
            if (error instanceof BotMcpInspectionBackoffError) return;
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
      // Hidden tools never reach a Bot's catalog, grants or children.
      tools = tools && mcpToolsOfferedToModel(server, tools, (tool) => tool.toolName);
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
