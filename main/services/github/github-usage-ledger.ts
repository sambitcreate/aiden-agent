// In-memory GitHub usage accounting per operation. Nothing here is sent
// anywhere; the snapshot feeds diagnostics and a periodic summary log line.

import type { GitHubRequestObservation } from "./github-api.js";

const SUMMARY_INTERVAL_MS = 10 * 60_000;

export interface GitHubOperationUsage {
  operation: string;
  kind: "rest" | "graphql";
  requests: number;
  points: number;
  notModified: number;
  rateLimited: number;
  pausedRefusals: number;
  budgetRefusals: number;
  failures: number;
}

export interface GitHubScopeUsage {
  host: string;
  remaining?: number;
  limit?: number;
  resetAt?: number;
  pausedUntil?: number;
}

export interface GitHubUsageSnapshot {
  since: number;
  totals: { requests: number; points: number; rateLimited: number; refusals: number };
  operations: GitHubOperationUsage[];
  scopes: GitHubScopeUsage[];
}

export class GitHubUsageLedger {
  private readonly now: () => number;
  private readonly log: ((line: string) => void) | undefined;
  private readonly operations = new Map<string, GitHubOperationUsage>();
  private readonly scopes = new Map<string, GitHubScopeUsage>();
  private readonly since: number;
  private lastSummaryAt: number;
  private requestsAtLastSummary = 0;

  constructor(options: { now?: () => number; log?: (line: string) => void } = {}) {
    this.now = options.now ?? Date.now;
    this.log = options.log;
    this.since = this.now();
    this.lastSummaryAt = this.since;
  }

  record(observation: GitHubRequestObservation, points: number): void {
    const usage = this.operation(observation.operation, observation.kind);
    usage.requests += 1;
    usage.points += points;
    if (observation.outcome === "not-modified") usage.notModified += 1;
    else if (observation.outcome === "rate-limited") usage.rateLimited += 1;
    else if (observation.outcome === "failed" || observation.outcome === "unauthorized") usage.failures += 1;
    this.maybeSummarize();
  }

  recordRefusal(operation: string, kind: "rest" | "graphql", reason: "paused" | "budget"): void {
    const usage = this.operation(operation, kind);
    if (reason === "paused") usage.pausedRefusals += 1;
    else usage.budgetRefusals += 1;
  }

  updateScope(scope: string, host: string, update: Omit<GitHubScopeUsage, "host">): void {
    const current = this.scopes.get(scope) ?? { host };
    this.scopes.set(scope, { ...current, ...update, host });
  }

  snapshot(): GitHubUsageSnapshot {
    const operations = [...this.operations.values()]
      .map((usage) => ({ ...usage }))
      .sort((a, b) => b.points - a.points || b.requests - a.requests);
    const now = this.now();
    return {
      since: this.since,
      totals: {
        requests: operations.reduce((sum, usage) => sum + usage.requests, 0),
        points: operations.reduce((sum, usage) => sum + usage.points, 0),
        rateLimited: operations.reduce((sum, usage) => sum + usage.rateLimited, 0),
        refusals: operations.reduce((sum, usage) => sum + usage.pausedRefusals + usage.budgetRefusals, 0),
      },
      operations,
      scopes: [...this.scopes.values()].map((scope) => {
        const { pausedUntil, resetAt, ...rest } = scope;
        return {
          ...rest,
          ...(resetAt !== undefined && resetAt > now ? { resetAt } : {}),
          ...(pausedUntil !== undefined && pausedUntil > now ? { pausedUntil } : {}),
        };
      }),
    };
  }

  private operation(operation: string, kind: "rest" | "graphql"): GitHubOperationUsage {
    const key = `${kind}:${operation}`;
    let usage = this.operations.get(key);
    if (!usage) {
      usage = { operation, kind, requests: 0, points: 0, notModified: 0, rateLimited: 0, pausedRefusals: 0, budgetRefusals: 0, failures: 0 };
      this.operations.set(key, usage);
    }
    return usage;
  }

  private maybeSummarize(): void {
    if (!this.log) return;
    const now = this.now();
    if (now - this.lastSummaryAt < SUMMARY_INTERVAL_MS) return;
    const snapshot = this.snapshot();
    const requests = snapshot.totals.requests - this.requestsAtLastSummary;
    this.lastSummaryAt = now;
    this.requestsAtLastSummary = snapshot.totals.requests;
    const top = snapshot.operations
      .slice(0, 3)
      .map((usage) => `${usage.operation}=${usage.requests}/${usage.points}pt`)
      .join(" ");
    const scopes = snapshot.scopes
      .map((scope) => `${scope.host}:${scope.remaining ?? "?"}/${scope.limit ?? "?"}${scope.pausedUntil ? " paused" : ""}`)
      .join(" ");
    this.log(`GitHub usage: ${requests} requests in the last 10 min; top ${top || "none"}; budget ${scopes || "unknown"}`);
  }
}
