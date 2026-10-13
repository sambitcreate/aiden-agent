// Live per-server MCP status for Settings. Fed by the connection cache
// lifecycle, discovery results and failures, and the OAuth provider's view of
// sign-in health. Main pushes each change to the renderer (`mcp:statusChanged`);
// nothing polls. Payloads stay small: no tool names, no raw errors past a cap.

import type { McpLiveStatus, McpToolSummary } from "../../renderer/shared/mcp-status.js";

export type { McpLiveState, McpLiveStatus, McpToolSummary } from "../../renderer/shared/mcp-status.js";

/** Bounds of the per-server tool list kept for Settings (never pushed). */
export const MCP_TOOL_SUMMARY_LIMITS = Object.freeze({ count: 512, nameChars: 256, titleChars: 128 });

function toolSummaries(tools: readonly { name: string; title?: string }[]): McpToolSummary[] {
  return tools.slice(0, MCP_TOOL_SUMMARY_LIMITS.count).flatMap(({ name, title }) => {
    if (typeof name !== "string" || !name || name.length > MCP_TOOL_SUMMARY_LIMITS.nameChars) return [];
    const shown = typeof title === "string" ? title.replace(/\s+/gu, " ").trim().slice(0, MCP_TOOL_SUMMARY_LIMITS.titleChars) : "";
    return [{ name, ...(shown ? { title: shown } : {}) }];
  });
}

/** Why stored OAuth tokens can no longer be used without a fresh sign-in. */
export type McpAuthFailure = "needs-sign-in" | "invalid-grant";

const MAX_ERROR_CHARS = 280;

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.replace(/\s+/gu, " ").trim() || "Connection failed.";
  return line.length > MAX_ERROR_CHARS ? `${line.slice(0, MAX_ERROR_CHARS - 1)}…` : line;
}

function same(left: McpLiveStatus | undefined, right: McpLiveStatus): boolean {
  return (
    left !== undefined &&
    left.state === right.state &&
    left.error === right.error &&
    left.toolCount === right.toolCount &&
    left.resources === right.resources &&
    left.needsSignIn === right.needsSignIn
  );
}

export class McpLiveStatusRegistry {
  private readonly statuses = new Map<string, McpLiveStatus>();
  private readonly authFailures = new Map<string, McpAuthFailure>();
  private readonly toolLists = new Map<string, McpToolSummary[]>();
  private readonly listeners = new Set<(status: McpLiveStatus) => void>();

  subscribe(listener: (status: McpLiveStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): McpLiveStatus[] {
    return [...this.statuses.values()].map((status) => ({ ...status }));
  }

  get(serverId: string): McpLiveStatus | undefined {
    const status = this.statuses.get(serverId);
    return status && { ...status };
  }

  connecting(serverId: string): void {
    const previous = this.statuses.get(serverId);
    this.publish({
      serverId,
      state: "connecting",
      // Keep the last known inventory visible while reconnecting.
      ...(previous?.toolCount === undefined ? {} : { toolCount: previous.toolCount }),
      ...(previous?.resources ? { resources: true } : {}),
    });
  }

  connected(serverId: string): void {
    const previous = this.statuses.get(serverId);
    this.publish({
      serverId,
      state: "connected",
      ...(previous?.toolCount === undefined ? {} : { toolCount: previous.toolCount }),
      ...(previous?.resources ? { resources: true } : {}),
    });
  }

  inventory(serverId: string, inventory: { toolCount: number; resources: boolean; tools?: readonly { name: string; title?: string }[] }): void {
    if (inventory.tools) this.toolLists.set(serverId, toolSummaries(inventory.tools));
    this.publish({
      serverId,
      state: "connected",
      toolCount: inventory.toolCount,
      ...(inventory.resources ? { resources: true } : {}),
    });
  }

  failed(serverId: string, error: unknown): void {
    this.publish({ serverId, state: "failed", error: errorText(error) });
  }

  /** The connection ended without an error (idle close, disconnect, transport loss). */
  closed(serverId: string): void {
    const previous = this.statuses.get(serverId);
    if (!previous || previous.state === "closed" || previous.state === "failed") return;
    this.publish({
      serverId,
      state: "closed",
      ...(previous.toolCount === undefined ? {} : { toolCount: previous.toolCount }),
      ...(previous.resources ? { resources: true } : {}),
    });
  }

  /** The server was removed: drop everything and tell the renderer once. */
  forget(serverId: string): void {
    this.toolLists.delete(serverId);
    const had = this.statuses.delete(serverId);
    const hadAuth = this.authFailures.delete(serverId);
    if (had || hadAuth) this.emit({ serverId, state: "closed", removed: true });
  }

  authFailure(serverId: string, reason: McpAuthFailure): void {
    if (this.authFailures.get(serverId) === reason) return;
    this.authFailures.set(serverId, reason);
    this.republish(serverId);
  }

  /**
   * A background connection reached the authorization redirect. Only a server
   * that had a stored sign-in lost it; one never signed in (for example a
   * prewarm before the first Authorize) is not "expired" and stays unflagged.
   */
  backgroundSignInRequired(serverId: string, options: { hadStoredSignIn: boolean }): void {
    if (options.hadStoredSignIn) this.authFailure(serverId, "needs-sign-in");
  }

  clearAuthFailure(serverId: string): void {
    if (!this.authFailures.delete(serverId)) return;
    this.republish(serverId);
  }

  /** The full remote tool list from the last discovery (hidden tools included), for Settings. */
  tools(serverId: string): McpToolSummary[] | undefined {
    return this.toolLists.get(serverId)?.map((tool) => ({ ...tool }));
  }

  needsSignIn(serverId: string): boolean {
    return this.authFailures.has(serverId);
  }

  private republish(serverId: string): void {
    const current = this.statuses.get(serverId) ?? { serverId, state: "closed" as const };
    const { needsSignIn: _previous, ...rest } = current;
    this.publish(rest);
  }

  private publish(status: McpLiveStatus): void {
    const next: McpLiveStatus = this.authFailures.has(status.serverId)
      ? { ...status, needsSignIn: true }
      : status;
    if (same(this.statuses.get(status.serverId), next)) return;
    this.statuses.set(status.serverId, next);
    this.emit(next);
  }

  private emit(status: McpLiveStatus): void {
    for (const listener of this.listeners) {
      try {
        listener({ ...status });
      } catch {
        // A broken subscriber must never break connection bookkeeping.
      }
    }
  }
}

export const mcpLiveStatus = new McpLiveStatusRegistry();

/** Connection-cache observer for the desktop manager's long-lived clients. */
export function recordMcpConnectionLifecycle(
  serverId: string,
  event: { type: "connecting" } | { type: "connected" } | { type: "failed"; error: unknown } | { type: "closed" },
  registry: McpLiveStatusRegistry = mcpLiveStatus,
): void {
  if (event.type === "connecting") registry.connecting(serverId);
  else if (event.type === "connected") registry.connected(serverId);
  else if (event.type === "failed") registry.failed(serverId, event.error);
  else registry.closed(serverId);
}
