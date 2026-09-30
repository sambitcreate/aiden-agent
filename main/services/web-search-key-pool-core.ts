/**
 * Main-only Web Search API-key pool: rotation, failover, and cooldowns.
 *
 * The pool is pure: no Electron, no secret store, and no clock unless one is
 * injected. Keys pass through `runWithWebSearchKeyPool` only as opaque values
 * handed to the caller's request function. They are never stored in tracker
 * state, errors, or renderer projections.
 */

import { WebSearchError, webSearchError } from "./web-search-core.js";
import type { WebSearchProviderId } from "./web-search-provider-registry-core.js";
import {
  MAX_WEB_SEARCH_KEY_POOL_ENTRIES,
  WEB_SEARCH_KEY_POOL_PRIMARY_ENTRY_ID,
  isWebSearchKeyPoolEntryId,
  isWebSearchKeyPoolProviderId,
  isWebSearchKeyPoolStrategy,
  normalizeWebSearchKeyPoolLabel,
  type WebSearchKeyPoolCooldownReason,
  type WebSearchKeyPoolEntryMetadata,
  type WebSearchKeyPoolProviderId,
  type WebSearchKeyPoolRendererState,
  type WebSearchKeyPoolStrategy,
} from "../../renderer/shared/web-search-key-pool.js";

export * from "../../renderer/shared/web-search-key-pool.js";

// ── Durable index document ─────────────────────────────────────────────

/** Non-secret pool index. It is stored encrypted beside the keys it orders. */
export interface WebSearchKeyPoolDocument {
  readonly version: 1;
  readonly strategy: WebSearchKeyPoolStrategy;
  readonly entries: readonly WebSearchKeyPoolEntryMetadata[];
}

export const EMPTY_WEB_SEARCH_KEY_POOL_DOCUMENT: WebSearchKeyPoolDocument = Object.freeze({
  version: 1,
  strategy: "ordered",
  entries: Object.freeze([]),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a stored index strictly. Anything malformed, duplicated, oversized,
 * or future-versioned is rejected as a whole so an unreadable index never
 * silently reorders or drops keys; callers treat `undefined` as "no index".
 */
export function parseWebSearchKeyPoolDocument(
  raw: string | null | undefined,
): WebSearchKeyPoolDocument | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64 * 1_024) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.version !== 1 || !isWebSearchKeyPoolStrategy(value.strategy)) {
    return undefined;
  }
  if (!Array.isArray(value.entries) || value.entries.length > MAX_WEB_SEARCH_KEY_POOL_ENTRIES) {
    return undefined;
  }
  const seen = new Set<string>();
  const entries: WebSearchKeyPoolEntryMetadata[] = [];
  for (const [index, candidate] of value.entries.entries()) {
    if (!isRecord(candidate) || !isWebSearchKeyPoolEntryId(candidate.id)) return undefined;
    if (seen.has(candidate.id)) return undefined;
    const addedAt = candidate.addedAt;
    if (typeof addedAt !== "number" || !Number.isSafeInteger(addedAt) || addedAt < 0) {
      return undefined;
    }
    seen.add(candidate.id);
    entries.push({
      id: candidate.id,
      label: normalizeWebSearchKeyPoolLabel(candidate.label, `Key ${index + 1}`),
      addedAt,
    });
  }
  return { version: 1, strategy: value.strategy, entries };
}

export function serializeWebSearchKeyPoolDocument(document: WebSearchKeyPoolDocument): string {
  return JSON.stringify({
    version: 1,
    strategy: document.strategy,
    entries: document.entries.map(({ id, label, addedAt }) => ({ id, label, addedAt })),
  });
}

/** Secret-store slot for one pool entry. The primary entry keeps the pre-pool slot. */
export function webSearchKeyPoolEntrySecretId(baseSecretId: string, entryId: string): string {
  if (!isWebSearchKeyPoolEntryId(entryId)) throw new Error("Invalid Web Search key entry.");
  return entryId === WEB_SEARCH_KEY_POOL_PRIMARY_ENTRY_ID
    ? baseSecretId
    : `${baseSecretId}:pool:${entryId}`;
}

export function webSearchKeyPoolIndexSecretId(baseSecretId: string): string {
  return `${baseSecretId}:pool-index`;
}

export function webSearchKeyPoolSupported(
  providerId: unknown,
): providerId is WebSearchKeyPoolProviderId & WebSearchProviderId {
  return isWebSearchKeyPoolProviderId(providerId);
}

// ── Cooldown tracker ───────────────────────────────────────────────────

export interface WebSearchKeyPoolCooldownPolicy {
  /** First quota/rate-limit cooldown; doubles per consecutive failure. */
  readonly quotaBaseMs: number;
  readonly quotaMaxMs: number;
  /** First rejected-credential cooldown; doubles per consecutive failure. */
  readonly authBaseMs: number;
  readonly authMaxMs: number;
}

export const DEFAULT_WEB_SEARCH_KEY_POOL_COOLDOWN_POLICY: WebSearchKeyPoolCooldownPolicy =
  Object.freeze({
    quotaBaseMs: 60_000,
    quotaMaxMs: 60 * 60_000,
    authBaseMs: 15 * 60_000,
    authMaxMs: 24 * 60 * 60_000,
  });

export interface WebSearchKeyPoolCooldown {
  readonly reason: WebSearchKeyPoolCooldownReason;
  readonly until: number;
  readonly consecutiveFailures: number;
}

interface CooldownRecord {
  reason: WebSearchKeyPoolCooldownReason;
  until: number;
  consecutiveFailures: number;
}

/**
 * Process-local cooldown and round-robin state. It is deliberately not
 * persisted: a restart gives every key a fresh chance, and nothing about
 * provider failures is written to disk.
 */
export class WebSearchKeyPoolTracker {
  private readonly records = new Map<string, CooldownRecord>();
  private readonly cursors = new Map<string, number>();
  private readonly now: () => number;
  private readonly policy: WebSearchKeyPoolCooldownPolicy;

  constructor(
    options: {
      readonly now?: () => number;
      readonly policy?: Partial<WebSearchKeyPoolCooldownPolicy>;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.policy = { ...DEFAULT_WEB_SEARCH_KEY_POOL_COOLDOWN_POLICY, ...options.policy };
  }

  currentTime(): number {
    return this.now();
  }

  /**
   * The attempt order for one search. Ordered pools always start at the
   * first key; round-robin pools start one position later on every call so
   * successive searches spread across healthy keys.
   */
  order(
    providerId: string,
    entryIds: readonly string[],
    strategy: WebSearchKeyPoolStrategy,
  ): string[] {
    if (strategy === "ordered" || entryIds.length < 2) return [...entryIds];
    const cursor = this.cursors.get(providerId) ?? 0;
    this.cursors.set(providerId, (cursor + 1) % entryIds.length);
    const start = cursor % entryIds.length;
    return [...entryIds.slice(start), ...entryIds.slice(0, start)];
  }

  /** Active cooldown, or undefined when the key is eligible. */
  cooldown(providerId: string, entryId: string): WebSearchKeyPoolCooldown | undefined {
    const record = this.records.get(recordKey(providerId, entryId));
    if (!record || record.until <= this.now()) return undefined;
    return { ...record };
  }

  recordFailure(
    providerId: string,
    entryId: string,
    reason: WebSearchKeyPoolCooldownReason,
  ): WebSearchKeyPoolCooldown {
    const key = recordKey(providerId, entryId);
    const previous = this.records.get(key);
    // Escalate only a repeated failure of the same kind. A quota failure after
    // an auth cooldown (or vice versa) starts that kind's backoff from base.
    const consecutiveFailures =
      previous && previous.reason === reason ? previous.consecutiveFailures + 1 : 1;
    const base = reason === "auth" ? this.policy.authBaseMs : this.policy.quotaBaseMs;
    const max = reason === "auth" ? this.policy.authMaxMs : this.policy.quotaMaxMs;
    const duration = Math.min(max, base * 2 ** Math.min(consecutiveFailures - 1, 20));
    const record = { reason, until: this.now() + duration, consecutiveFailures };
    this.records.set(key, record);
    return { ...record };
  }

  recordSuccess(providerId: string, entryId: string): void {
    this.records.delete(recordKey(providerId, entryId));
  }

  /** Manually make one key (or a provider's whole pool) eligible again. */
  clear(providerId: string, entryId?: string): void {
    if (entryId !== undefined) {
      this.records.delete(recordKey(providerId, entryId));
      return;
    }
    const prefix = `${providerId}\u0000`;
    for (const key of [...this.records.keys()]) {
      if (key.startsWith(prefix)) this.records.delete(key);
    }
    this.cursors.delete(providerId);
  }

  /** Drop state for entries that no longer exist, so reused IDs start clean. */
  retain(providerId: string, entryIds: readonly string[]): void {
    const keep = new Set(entryIds.map((entryId) => recordKey(providerId, entryId)));
    const prefix = `${providerId}\u0000`;
    for (const key of [...this.records.keys()]) {
      if (key.startsWith(prefix) && !keep.has(key)) this.records.delete(key);
    }
  }
}

function recordKey(providerId: string, entryId: string): string {
  return `${providerId}\u0000${entryId}`;
}

/** Redacted renderer projection of one provider's pool. */
export function webSearchKeyPoolRendererState(
  providerId: WebSearchKeyPoolProviderId,
  document: WebSearchKeyPoolDocument,
  tracker: WebSearchKeyPoolTracker,
): WebSearchKeyPoolRendererState {
  return {
    providerId,
    strategy: document.strategy,
    maxEntries: MAX_WEB_SEARCH_KEY_POOL_ENTRIES,
    observedAt: tracker.currentTime(),
    entries: document.entries.map((entry) => {
      const cooldown = tracker.cooldown(providerId, entry.id);
      return {
        id: entry.id,
        label: entry.label,
        addedAt: entry.addedAt,
        cooldown: cooldown ? { reason: cooldown.reason, until: cooldown.until } : null,
      };
    }),
  };
}

// ── Failover runner ────────────────────────────────────────────────────

export interface WebSearchPooledKey {
  readonly id: string;
  readonly key: string;
}

export interface WebSearchKeyPool {
  readonly strategy: WebSearchKeyPoolStrategy;
  readonly keys: readonly WebSearchPooledKey[];
}

function cooldownReasonFor(error: unknown): WebSearchKeyPoolCooldownReason | undefined {
  if (!(error instanceof WebSearchError)) return undefined;
  if (error.kind === "auth") return "auth";
  if (error.kind === "quota") return "quota";
  return undefined;
}

/**
 * Run one provider request against a key pool.
 *
 * Keys are tried in pool order (rotated for round-robin), skipping keys that
 * are cooling down. A rejected credential (401/403) or quota/rate-limit
 * response (429 and provider quota codes) puts that key on cooldown and
 * moves to the next key. Any other failure, including cancellation and
 * timeout, stops immediately: another key would not fix it.
 *
 * When every key is cooling down, no request is sent. The pool fails with
 * `quota` if any key is only rate-limited (so automatic routing can fall
 * back and a later search can retry), otherwise with `auth`.
 */
export async function runWithWebSearchKeyPool<T>(options: {
  readonly providerId: WebSearchProviderId;
  readonly pool: WebSearchKeyPool;
  readonly tracker: WebSearchKeyPoolTracker;
  readonly signal?: AbortSignal;
  /** Called immediately before each keyed request is sent. */
  readonly beforeKeyAttempt?: (entryId: string) => void | Promise<void>;
  readonly run: (key: string) => Promise<T>;
}): Promise<T> {
  const { providerId, pool, tracker } = options;
  if (pool.keys.length === 0) throw webSearchError("auth", providerId);
  const byId = new Map(pool.keys.map((entry) => [entry.id, entry]));
  const order = tracker.order(
    providerId,
    pool.keys.map((entry) => entry.id),
    pool.strategy,
  );

  let lastError: unknown;
  let sawQuota = false;
  for (const entryId of order) {
    const entry = byId.get(entryId);
    if (!entry) continue;
    const cooling = tracker.cooldown(providerId, entryId);
    if (cooling) {
      if (cooling.reason === "quota") sawQuota = true;
      continue;
    }
    if (options.signal?.aborted) throw webSearchError("cancelled", providerId);
    if (options.beforeKeyAttempt) await options.beforeKeyAttempt(entryId);
    try {
      const result = await options.run(entry.key);
      tracker.recordSuccess(providerId, entryId);
      return result;
    } catch (error) {
      const reason = cooldownReasonFor(error);
      if (!reason) throw error;
      tracker.recordFailure(providerId, entryId, reason);
      if (reason === "quota") sawQuota = true;
      lastError = error;
      if (options.signal?.aborted) throw webSearchError("cancelled", providerId);
    }
  }
  if (lastError instanceof WebSearchError && (lastError.kind === "quota" || !sawQuota)) {
    throw lastError;
  }
  throw webSearchError(sawQuota ? "quota" : "auth", providerId);
}
