// GraphQL point budget per (host, credential). Readings come only from the
// `rateLimit` object GitHub returns inside each read query; REST /rate_limit
// disagrees with it and is never used as a seed.

const BACKGROUND_RESERVE_FRACTION = 0.1;
const RATE_LIMIT_SELECTION = "rateLimit { cost limit remaining resetAt }";

export interface GraphQlRateLimitReading {
  cost: number;
  limit: number;
  remaining: number;
  /** Epoch ms. */
  resetAt: number;
}

export interface BudgetTicket {
  scope: string;
  operation: string;
  reserved: number;
}

interface ScopeBudget {
  reading?: GraphQlRateLimitReading;
  reserved: number;
  lastCost: Map<string, number>;
}

export type BudgetCheck =
  | { ok: true; ticket: BudgetTicket }
  | { ok: false; retryAt: number };

export function isGraphQlMutation(query: string): boolean {
  return /^\s*(?:#[^\n]*\n\s*)*mutation\b/u.test(query);
}

/**
 * Append the rateLimit selection to the operation's root selection set.
 * Mutations, and queries that already ask for it, are returned unchanged.
 */
export function withRateLimitSelection(query: string): string {
  if (isGraphQlMutation(query) || /\brateLimit\s*[{(]/u.test(query)) return query;
  let depth = 0;
  let definitionStart = 0;
  let operationOpen = -1;
  for (let index = 0; index < query.length; index += 1) {
    const char = query[index];
    if (char === "{") {
      if (depth === 0) {
        const header = query.slice(definitionStart, index).trim();
        if (!header.startsWith("fragment")) operationOpen = index;
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        if (operationOpen >= 0) {
          return `${query.slice(0, index)} ${RATE_LIMIT_SELECTION} ${query.slice(index)}`;
        }
        definitionStart = index + 1;
      }
    }
  }
  return query;
}

export function readGraphQlRateLimit(body: unknown): GraphQlRateLimitReading | undefined {
  const data = (body as { data?: { rateLimit?: Record<string, unknown> } } | undefined)?.data;
  const raw = data?.rateLimit;
  if (!raw || typeof raw !== "object") return undefined;
  const { cost, limit, remaining, resetAt } = raw;
  const reset = typeof resetAt === "string" ? Date.parse(resetAt) : NaN;
  if (
    typeof cost !== "number" ||
    typeof limit !== "number" ||
    typeof remaining !== "number" ||
    !Number.isFinite(reset)
  ) {
    return undefined;
  }
  return { cost, limit, remaining, resetAt: reset };
}

export class GitHubGraphQlBudget {
  private readonly now: () => number;
  private readonly scopes = new Map<string, ScopeBudget>();

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Reserve the operation's last observed cost (at least one point) before
   * sending. Background reads stop at a 10% reserve; interactive reads may
   * spend it down to zero.
   */
  reserve(scope: string, operation: string, interactive: boolean): BudgetCheck {
    const budget = this.budget(scope);
    const cost = Math.max(1, budget.lastCost.get(operation) ?? 1);
    const reading = budget.reading;
    if (reading && reading.resetAt > this.now()) {
      const floor = interactive ? 0 : Math.ceil(reading.limit * BACKGROUND_RESERVE_FRACTION);
      if (reading.remaining - budget.reserved - cost < floor) {
        return { ok: false, retryAt: reading.resetAt };
      }
    }
    budget.reserved += cost;
    return { ok: true, ticket: { scope, operation, reserved: cost } };
  }

  /** Settle a reservation with GitHub's reading from the response, if any. */
  record(ticket: BudgetTicket, reading: GraphQlRateLimitReading | undefined): void {
    const budget = this.budget(ticket.scope);
    budget.reserved = Math.max(0, budget.reserved - ticket.reserved);
    if (!reading) return;
    budget.lastCost.set(ticket.operation, Math.max(1, reading.cost));
    const current = budget.reading;
    if (!current || reading.resetAt > current.resetAt) {
      budget.reading = reading;
    } else if (reading.resetAt === current.resetAt && reading.remaining < current.remaining) {
      budget.reading = reading;
    }
  }

  /** GitHub refused the query outright: treat the window as spent until reset. */
  exhaust(scope: string, resetAt: number | undefined): void {
    if (resetAt === undefined) return;
    const budget = this.budget(scope);
    const limit = budget.reading?.limit ?? 5_000;
    budget.reading = { cost: budget.reading?.cost ?? 1, limit, remaining: 0, resetAt };
  }

  snapshot(scope: string): GraphQlRateLimitReading | undefined {
    const reading = this.scopes.get(scope)?.reading;
    return reading && reading.resetAt > this.now() ? { ...reading } : undefined;
  }

  private budget(scope: string): ScopeBudget {
    let budget = this.scopes.get(scope);
    if (!budget) {
      budget = { reserved: 0, lastCost: new Map() };
      this.scopes.set(scope, budget);
    }
    return budget;
  }
}
