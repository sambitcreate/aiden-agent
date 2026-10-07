// The single policy every GitHub request passes through: a per-scope pause
// after rate limits, the GraphQL point budget, and usage accounting.

import type {
  GitHubAdmission,
  GitHubAdmissionRequest,
  GitHubRequestGate,
  GitHubRequestObservation,
} from "./github-api.js";
import {
  GitHubGraphQlBudget,
  isGraphQlMutation,
  readGraphQlRateLimit,
  withRateLimitSelection,
  type BudgetTicket,
} from "./github-graphql-budget.js";
import { GitHubRateLimitGovernor, type RateLimitLease } from "./github-rate-limit.js";
import { GitHubUsageLedger } from "./github-usage-ledger.js";

interface GateTicket {
  lease: RateLimitLease;
  budget?: BudgetTicket;
}

const PAUSED_MESSAGE = "GitHub's API rate limit was reached; Aiden paused GitHub reads until it resets.";

export class GitHubRateLimitGate implements GitHubRequestGate {
  readonly governor: GitHubRateLimitGovernor;
  readonly budget: GitHubGraphQlBudget;
  readonly ledger: GitHubUsageLedger;

  constructor(
    options: {
      now?: () => number;
      log?: (line: string) => void;
      governor?: GitHubRateLimitGovernor;
      budget?: GitHubGraphQlBudget;
      ledger?: GitHubUsageLedger;
    } = {},
  ) {
    this.governor = options.governor ?? new GitHubRateLimitGovernor({ now: options.now });
    this.budget = options.budget ?? new GitHubGraphQlBudget({ now: options.now });
    this.ledger = options.ledger ?? new GitHubUsageLedger({ now: options.now, log: options.log });
  }

  prepareQuery(query: string): string {
    return withRateLimitSelection(query);
  }

  admit(request: GitHubAdmissionRequest): GitHubAdmission {
    const interactive = request.interactive === true;
    const check = this.governor.check(request.scope, { interactive });
    if (!check.ok) {
      this.ledger.recordRefusal(request.operation, request.kind, "paused");
      return { ok: false, result: { kind: "rate-limited", retryAt: check.retryAt, message: PAUSED_MESSAGE, sent: false } };
    }
    const ticket: GateTicket = { lease: check.lease };
    if (request.kind === "graphql" && request.query !== undefined && !isGraphQlMutation(request.query)) {
      const reserved = this.budget.reserve(request.scope, request.operation, interactive);
      if (!reserved.ok) {
        this.ledger.recordRefusal(request.operation, request.kind, "budget");
        return {
          ok: false,
          result: {
            kind: "rate-limited",
            retryAt: reserved.retryAt,
            message: "GitHub's GraphQL budget is nearly spent; Aiden is saving the rest for actions you take.",
            sent: false,
          },
        };
      }
      ticket.budget = reserved.ticket;
    }
    return { ok: true, ticket };
  }

  cancel(rawTicket: unknown): void {
    const ticket = rawTicket as GateTicket | undefined;
    if (ticket?.budget) this.budget.record(ticket.budget, undefined);
  }

  settle(observation: GitHubRequestObservation, rawTicket: unknown, body: unknown): void {
    const ticket = rawTicket as GateTicket | undefined;
    const reading = observation.kind === "graphql" ? readGraphQlRateLimit(body) : undefined;
    if (ticket?.budget) this.budget.record(ticket.budget, reading);
    let pausedUntil: number | undefined;
    if (observation.outcome === "rate-limited") {
      pausedUntil = this.governor.recordRateLimit(observation.scope, observation.retryAt);
      if (observation.kind === "graphql") this.budget.exhaust(observation.scope, observation.retryAt);
    } else if (ticket && observation.status !== undefined && observation.status < 500) {
      this.governor.recordSuccess(ticket.lease);
    }
    this.ledger.record(observation, reading?.cost ?? 0);
    const remaining = reading?.remaining ?? (observation.kind === "graphql" ? observation.headers?.remaining : undefined);
    const limit = reading?.limit ?? (observation.kind === "graphql" ? observation.headers?.limit : undefined);
    const resetAt = reading?.resetAt ?? (observation.kind === "graphql" ? observation.headers?.resetAt : undefined);
    this.ledger.updateScope(observation.scope, observation.host, {
      ...(remaining !== undefined ? { remaining } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(resetAt !== undefined ? { resetAt } : {}),
      ...(pausedUntil !== undefined ? { pausedUntil } : {}),
    });
  }
}
