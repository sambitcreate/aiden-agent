// Pure MCP tool-discovery policy shared by the desktop MCP manager: request
// deadlines, parallel per-server collection, deferred admission and the
// recent-failure cache.
// Kept free of Electron, config and credential imports so it can be exercised
// against real in-memory MCP SDK servers.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { assertUniqueMcpAgentToolNames } from "./mcp-tool-identity.js";

export interface McpDiscoveryDeadlines {
  /** Transport start plus `initialize`. */
  readonly connectMs: number;
  /** One `tools/list` round trip. */
  readonly listMs: number;
}

export const MCP_DISCOVERY_DEADLINES: McpDiscoveryDeadlines = Object.freeze({
  connectMs: 10_000,
  listMs: 5_000,
});

/**
 * Budget for one server's whole discovery step, including admission and
 * credential resolution, which the per-request SDK timeouts do not cover.
 */
export function mcpServerDiscoveryBudgetMs(
  deadlines: McpDiscoveryDeadlines = MCP_DISCOVERY_DEADLINES,
): number {
  return deadlines.connectMs + deadlines.listMs + 2_000;
}

/** Per-request SDK bound. `maxTotalTimeout` also caps progress-reset requests. */
export function mcpRequestDeadline(ms: number, signal?: AbortSignal): RequestOptions {
  return { ...(signal ? { signal } : {}), timeout: ms, maxTotalTimeout: ms };
}

/** Tool calls keep the SDK's default per-request bound, now with an explicit total. */
export const MCP_TOOL_CALL_TIMEOUT_MS = 60_000;

export class McpDeadlineError extends Error {
  override readonly name = "TimeoutError";
  constructor(label: string, ms: number) {
    super(`${label} did not respond within ${Math.round(ms / 1000)} s.`);
  }
}

/**
 * SDK request timeouts surface as `McpError(RequestTimeout)`; present them as
 * a `TimeoutError` so diagnostics classify the skipped server as timed out.
 */
export function asMcpDeadlineError(error: unknown): unknown {
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
    return Object.assign(new McpDeadlineError("The MCP request", 0), {
      message: error.message,
      cause: error,
    });
  }
  return error;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("MCP discovery cancelled.");
}

/**
 * Settle with `operation`, or reject once `ms` elapse or `signal` aborts. The
 * operation keeps running; its eventual rejection is observed so a late
 * failure is never reported as unhandled.
 */
export function raceDeadline<T>(
  operation: Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  operation.catch(() => undefined);
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const settle = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      settle();
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      settle();
      reject(new McpDeadlineError(label, ms));
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        settle();
        resolve(value);
      },
      (error: unknown) => {
        settle();
        reject(error);
      },
    );
  });
}

/**
 * Run each server's discovery concurrently, each under its own budget, and
 * return results in input order. A slow or hung server only loses its own
 * tools for this turn; it never delays the others past the budget.
 */
export function settleMcpServerDiscovery<S extends { readonly name: string }, R>(
  servers: readonly S[],
  discover: (server: S) => Promise<R>,
  budgetMs: number,
  signal?: AbortSignal,
): Promise<PromiseSettledResult<R>[]> {
  return Promise.allSettled(
    servers.map((server) =>
      raceDeadline(
        Promise.resolve().then(() => discover(server)),
        budgetMs,
        `MCP server "${server.name}"`,
        signal,
      ),
    ),
  );
}

export interface McpServerDiscoveryResult {
  readonly tools: readonly AgentTool[];
}

/**
 * Merge per-server discovery in configuration order. A server's tools are
 * accepted only after their names prove unique against servers already
 * accepted. Strict callers fail closed on the first
 * unavailable server; others report it and continue without its tools.
 */
export function mergeMcpServerDiscovery<S extends { readonly name: string }>(
  servers: readonly S[],
  settled: readonly PromiseSettledResult<McpServerDiscoveryResult>[],
  options: {
    strict?: boolean;
    onUnavailable?: (server: S, error: unknown) => void;
  } = {},
): AgentTool[] {
  const all: AgentTool[] = [];
  for (const [index, result] of settled.entries()) {
    const server = servers[index];
    try {
      if (result.status === "rejected") throw result.reason;
      assertUniqueMcpAgentToolNames([...all, ...result.value.tools]);
      all.push(...result.value.tools);
    } catch (error) {
      if (options.strict) {
        throw new Error(
          `MCP server "${server.name}" is unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      options.onUnavailable?.(server, asMcpDeadlineError(error));
    }
  }
  if (options.strict && servers.length > 0 && all.length === 0) {
    throw new Error("The approved MCP servers did not provide any tools.");
  }
  return all;
}

/**
 * How long a turn with deferred discovery (codemode / tool_search) waits for
 * servers before starting. Warm and cached servers answer well inside it.
 */
export const MCP_DEFERRED_ADMISSION_WINDOW_MS = 1_500;

/** Tools from servers that finished discovery after their turn started. */
export interface McpLateDiscovery {
  /** Accepted late tools, in completion order. Never shrinks during a turn. */
  tools(): readonly AgentTool[];
  /** Number of servers still discovering. */
  pending(): number;
  /**
   * Resolve once no server is still discovering. Each server is bounded by its
   * own discovery budget; `signal` stops only this caller's wait.
   */
  settled(signal?: AbortSignal): Promise<void>;
}

/** A late inventory that never changes: nothing was deferred. */
export const NO_LATE_MCP_DISCOVERY: McpLateDiscovery = Object.freeze({
  tools: () => [],
  pending: () => 0,
  settled: async (signal?: AbortSignal) => { signal?.throwIfAborted(); },
});

function waitFor(pending: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  const settled = pending.then(() => undefined, () => undefined);
  if (!signal) return settled;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void settled.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

/**
 * Deferred admission for turns whose MCP tools are reached through codemode or
 * tool_search rather than declared to the provider. Servers that finish within
 * `windowMs` are merged exactly like {@link mergeMcpServerDiscovery}; the rest
 * keep discovering under their own budget and, once done, join `late` if their
 * tool names stay unique. Late servers never change the turn's base prompt or
 * declared tools while they arrive.
 */
export async function admitMcpServerDiscovery<S extends { readonly name: string }>(
  servers: readonly S[],
  discover: (server: S) => Promise<McpServerDiscoveryResult>,
  options: {
    budgetMs: number;
    windowMs: number;
    signal?: AbortSignal;
    onUnavailable?: (server: S, error: unknown) => void;
    /** Servers admitted only once they finish (within their own budget), never late. */
    awaitServer?: (server: S) => boolean;
  },
): Promise<{ tools: AgentTool[]; late: McpLateDiscovery }> {
  const results: (PromiseSettledResult<McpServerDiscoveryResult> | undefined)[] = servers.map(() => undefined);
  let admitted = false;
  const accepted: AgentTool[] = [];
  const late: AgentTool[] = [];
  let pending = 0;
  const acceptLate = (server: S, result: PromiseSettledResult<McpServerDiscoveryResult>) => {
    try {
      if (result.status === "rejected") throw result.reason;
      assertUniqueMcpAgentToolNames([...accepted, ...late, ...result.value.tools]);
      late.push(...result.value.tools);
    } catch (error) {
      options.onUnavailable?.(server, asMcpDeadlineError(error));
    }
  };
  const racing = servers.map((server, index) =>
    raceDeadline(
      Promise.resolve().then(() => discover(server)),
      options.budgetMs,
      `MCP server "${server.name}"`,
      options.signal,
    ).then(
      (value) => ({ status: "fulfilled", value }) as const,
      (reason: unknown) => ({ status: "rejected", reason }) as const,
    ).then((result) => {
      results[index] = result;
      if (admitted) {
        pending -= 1;
        acceptLate(server, result);
      }
    }),
  );
  const all = Promise.all(racing);
  const awaited = Promise.all(racing.filter((_, index) => options.awaitServer?.(servers[index]!) === true));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const window = new Promise<void>((resolve) => { timer = setTimeout(resolve, options.windowMs); });
  await Promise.race([all, Promise.all([window, awaited])]);
  clearTimeout(timer);
  admitted = true;
  const readyIndexes = results.flatMap((result, index) => (result ? [index] : []));
  pending = servers.length - readyIndexes.length;
  accepted.push(...mergeMcpServerDiscovery(
    readyIndexes.map((index) => servers[index]!),
    readyIndexes.map((index) => results[index]!),
    { onUnavailable: options.onUnavailable },
  ));
  return {
    tools: accepted,
    late: pending === 0 ? NO_LATE_MCP_DISCOVERY : {
      tools: () => [...late],
      pending: () => pending,
      settled: (signal) => waitFor(all, signal),
    },
  };
}

/** How long a server that just failed discovery is skipped. */
export const MCP_RECENT_FAILURE_MS = 45_000;

/**
 * Negative cache for discovery. A failure is remembered for one connection
 * generation only, so a reconnect, save or reset (which supersede it) retries
 * at once; explicit `clear` covers servers that never connected.
 */
export class McpRecentFailures {
  private readonly failures = new Map<string, { generation: number; until: number; error: unknown }>();

  constructor(
    private readonly ttlMs: number = MCP_RECENT_FAILURE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  record(id: string, generation: number, error: unknown): void {
    this.failures.set(id, { generation, until: this.now() + this.ttlMs, error });
  }

  /** The failure to report instead of retrying, while it is still fresh. */
  recent(id: string, generation: number): { error: unknown; retryInMs: number } | undefined {
    const failure = this.failures.get(id);
    if (!failure) return undefined;
    const retryInMs = failure.until - this.now();
    if (failure.generation !== generation || retryInMs <= 0) {
      this.failures.delete(id);
      return undefined;
    }
    return { error: failure.error, retryInMs };
  }

  clear(id: string): void {
    this.failures.delete(id);
  }

  clearAll(): void {
    this.failures.clear();
  }
}

/**
 * Per-server memo for built agent tools: the stored value is returned while
 * every dependency is the identical object (client, inventory) or equal
 * primitive (server identity), and the value's own `isCurrent` still holds
 * (its configuration lease). Anything else rebuilds.
 */
export class McpBuiltToolsMemo<T> {
  private readonly entries = new Map<string, { dependencies: readonly unknown[]; isCurrent: () => boolean; value: T }>();

  get(id: string, dependencies: readonly unknown[]): T | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const same = entry.dependencies.length === dependencies.length &&
      entry.dependencies.every((dependency, index) => Object.is(dependency, dependencies[index]));
    if (same && entry.isCurrent()) return entry.value;
    this.entries.delete(id);
    return undefined;
  }

  /** The current value for `id` without checking dependencies; never connects or builds. */
  peek(id: string): T | undefined {
    const entry = this.entries.get(id);
    return entry?.isCurrent() ? entry.value : undefined;
  }

  set(id: string, dependencies: readonly unknown[], isCurrent: () => boolean, value: T): void {
    this.entries.set(id, { dependencies: [...dependencies], isCurrent, value });
  }

  delete(id: string): void {
    this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Background discovery bookkeeping: at most one prewarm per server at a time,
 * none after shutdown, and failures handed to `onFailure` (diagnostics)
 * instead of escaping.
 */
export class McpPrewarmer {
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly isShutDown: () => boolean) {}

  /** Start `discover` unless one is already running; resolves when it settles. */
  start(id: string, discover: () => Promise<unknown>, onFailure: (error: unknown) => void): Promise<void> {
    const existing = this.running.get(id);
    if (existing) return existing;
    if (this.isShutDown()) return Promise.resolve();
    const run = Promise.resolve()
      .then(discover)
      .then(() => undefined, (error: unknown) => {
        try { onFailure(error); } catch { /* diagnostics never fail a prewarm */ }
      })
      .finally(() => { if (this.running.get(id) === run) this.running.delete(id); });
    this.running.set(id, run);
    return run;
  }
}

/**
 * Bound a whole connection attempt (transport start, OAuth refresh and
 * `initialize`) by `ms`, which the SDK's initialize timeout alone does not
 * cover. On timeout or abort the client is closed, and closed again once the
 * raw attempt settles so a transport still starting cannot linger.
 */
export async function connectMcpWithinDeadline(
  connecting: Promise<unknown>,
  close: () => Promise<void>,
  options: { ms?: number; signal?: AbortSignal; label?: string } = {},
): Promise<void> {
  const ms = options.ms ?? MCP_DISCOVERY_DEADLINES.connectMs;
  try {
    await raceDeadline(connecting, ms, options.label ?? "The MCP connection", options.signal);
  } catch (error) {
    const closeQuietly = () => close().catch(() => undefined);
    void closeQuietly();
    void connecting.then(closeQuietly, closeQuietly);
    throw error;
  }
}

/**
 * Activity bookkeeping for idle expiry. A connection with a call in flight is
 * never idle; otherwise it is idle once `idleMs` pass without activity.
 */
export class McpConnectionActivity {
  private readonly lastActive = new Map<string, number>();
  private readonly inFlight = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  touch(id: string): void {
    this.lastActive.set(id, this.now());
  }

  /** Mark a call as started; the returned function ends it exactly once. */
  begin(id: string): () => void {
    this.inFlight.set(id, (this.inFlight.get(id) ?? 0) + 1);
    this.touch(id);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const remaining = (this.inFlight.get(id) ?? 1) - 1;
      if (remaining > 0) this.inFlight.set(id, remaining);
      else this.inFlight.delete(id);
      this.touch(id);
    };
  }

  idle(ids: Iterable<string>, idleMs: number): string[] {
    const now = this.now();
    return [...ids].filter(
      (id) =>
        !this.inFlight.has(id) && now - (this.lastActive.get(id) ?? now) >= idleMs,
    );
  }

  forget(id: string): void {
    this.lastActive.delete(id);
    // In-flight counts belong to calls still running; their `end` re-touches.
  }
}
