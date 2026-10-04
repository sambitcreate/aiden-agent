// Pure MCP tool-discovery policy shared by the desktop MCP manager: per-client
// tool-list caching, request deadlines, and parallel per-server collection.
// Kept free of Electron, config and credential imports so it can be exercised
// against real in-memory MCP SDK servers.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ErrorCode,
  McpError,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
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

export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

type ToolListingClient = Pick<
  Client,
  "getServerCapabilities" | "listTools" | "setNotificationHandler"
>;

/**
 * Caches `tools/list` per connected client. A reconnect creates a new client,
 * so the cache is naturally scoped to one connection generation; a
 * `notifications/tools/list_changed` from the server drops that client's entry.
 */
export class McpToolListCache {
  private readonly lists = new WeakMap<object, Promise<readonly McpToolDescriptor[]>>();

  /** Register before `connect` so a change announced during setup is not missed. */
  attach(client: ToolListingClient): void {
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.invalidate(client);
    });
  }

  invalidate(client: object): void {
    this.lists.delete(client);
  }

  /** Concurrent callers share one in-flight request; failures are not cached. */
  list(
    client: ToolListingClient,
    timeoutMs: number,
  ): Promise<readonly McpToolDescriptor[]> {
    if (!client.getServerCapabilities()?.tools) return Promise.resolve([]);
    const cached = this.lists.get(client);
    if (cached) return cached;
    const request = client
      .listTools(undefined, mcpRequestDeadline(timeoutMs))
      .then(({ tools }) =>
        Object.freeze(
          tools.map(({ name, description, inputSchema }) =>
            Object.freeze({
              name,
              ...(description === undefined ? {} : { description }),
              ...(inputSchema === undefined ? {} : { inputSchema }),
            }),
          ),
        ),
      );
    this.lists.set(client, request);
    request.catch(() => {
      if (this.lists.get(client) === request) this.lists.delete(client);
    });
    return request;
  }
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

export interface McpServerDiscoveryResult<I> {
  readonly tools: readonly AgentTool[];
  readonly instructions?: I;
}

/**
 * Merge per-server discovery in configuration order. A server's tools and
 * instructions are accepted together, only after its tool names prove unique
 * against servers already accepted. Strict callers fail closed on the first
 * unavailable server; others report it and continue without its tools.
 */
export function mergeMcpServerDiscovery<S extends { readonly name: string }, I>(
  servers: readonly S[],
  settled: readonly PromiseSettledResult<McpServerDiscoveryResult<I>>[],
  options: {
    strict?: boolean;
    onServerInstructions?: (instructions: I) => void;
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
      if (result.value.instructions) options.onServerInstructions?.(result.value.instructions);
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
