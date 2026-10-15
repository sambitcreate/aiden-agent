// Per (host, credential) pause after GitHub reports a rate limit. While a
// scope is paused, every request is refused locally and never sent: retrying
// before GitHub's reset only prolongs a secondary limit.

const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;

export interface RateLimitLease {
  scope: string;
  generation: number;
}

interface ScopeState {
  pausedUntil: number;
  generation: number;
  strikes: number;
}

export type RateLimitCheck =
  | { ok: true; lease: RateLimitLease }
  | { ok: false; retryAt: number };

export class GitHubRateLimitGovernor {
  private readonly now: () => number;
  private readonly scopes = new Map<string, ScopeState>();

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  check(scope: string): RateLimitCheck {
    const state = this.state(scope);
    if (state.pausedUntil > this.now()) return { ok: false, retryAt: state.pausedUntil };
    return { ok: true, lease: { scope, generation: state.generation } };
  }

  /**
   * Pause the scope. GitHub's retry time wins; without one the pause backs off
   * from one minute, doubling per consecutive hit up to fifteen minutes.
   */
  recordRateLimit(scope: string, retryAt?: number): number {
    const state = this.state(scope);
    const now = this.now();
    state.strikes += 1;
    state.generation += 1;
    const until =
      retryAt !== undefined && retryAt > now
        ? retryAt
        : now + Math.min(BASE_BACKOFF_MS * 2 ** (state.strikes - 1), MAX_BACKOFF_MS);
    state.pausedUntil = Math.max(state.pausedUntil, until);
    return state.pausedUntil;
  }

  /** A success clears the backoff only if no newer rate limit was recorded. */
  recordSuccess(lease: RateLimitLease): void {
    const state = this.scopes.get(lease.scope);
    if (!state || lease.generation !== state.generation) return;
    state.strikes = 0;
    state.pausedUntil = 0;
  }

  pausedUntil(scope: string): number | undefined {
    const until = this.scopes.get(scope)?.pausedUntil ?? 0;
    return until > this.now() ? until : undefined;
  }

  activePauses(): Array<{ scope: string; until: number }> {
    const now = this.now();
    return [...this.scopes.entries()]
      .filter(([, state]) => state.pausedUntil > now)
      .map(([scope, state]) => ({ scope, until: state.pausedUntil }));
  }

  private state(scope: string): ScopeState {
    let state = this.scopes.get(scope);
    if (!state) {
      state = { pausedUntil: 0, generation: 0, strikes: 0 };
      this.scopes.set(scope, state);
    }
    return state;
  }
}
