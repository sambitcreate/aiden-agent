/**
 * Renderer-safe Web Search API-key pool contract.
 *
 * Key material never appears in this module. The renderer sees only opaque
 * entry IDs, user-chosen labels, order, rotation strategy, and redacted
 * cooldown state. Plaintext keys stay in the main process.
 */

/** Providers whose adapter can rotate through several keys. */
export const WEB_SEARCH_KEY_POOL_PROVIDER_IDS = Object.freeze(["tavily"] as const);
export type WebSearchKeyPoolProviderId = (typeof WEB_SEARCH_KEY_POOL_PROVIDER_IDS)[number];

export const MAX_WEB_SEARCH_KEY_POOL_ENTRIES = 8;
export const MAX_WEB_SEARCH_KEY_POOL_LABEL_CHARS = 48;
/** The pre-pool single credential slot is always addressed by this entry ID. */
export const WEB_SEARCH_KEY_POOL_PRIMARY_ENTRY_ID = "primary";

export type WebSearchKeyPoolStrategy = "ordered" | "round-robin";
export const WEB_SEARCH_KEY_POOL_STRATEGIES: readonly WebSearchKeyPoolStrategy[] = Object.freeze([
  "ordered",
  "round-robin",
]);

/** Why a key is temporarily skipped. */
export type WebSearchKeyPoolCooldownReason = "auth" | "quota";

export interface WebSearchKeyPoolEntryMetadata {
  readonly id: string;
  readonly label: string;
  /** Epoch milliseconds; zero for a key saved before pools existed. */
  readonly addedAt: number;
}

export interface WebSearchKeyPoolRendererEntry extends WebSearchKeyPoolEntryMetadata {
  readonly cooldown: null | {
    readonly reason: WebSearchKeyPoolCooldownReason;
    /** Epoch milliseconds when the key becomes eligible again. */
    readonly until: number;
  };
}

export interface WebSearchKeyPoolRendererState {
  readonly providerId: WebSearchKeyPoolProviderId;
  readonly strategy: WebSearchKeyPoolStrategy;
  readonly maxEntries: number;
  readonly entries: readonly WebSearchKeyPoolRendererEntry[];
  /** Epoch milliseconds when main produced this projection. */
  readonly observedAt: number;
}

const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

export function isWebSearchKeyPoolProviderId(value: unknown): value is WebSearchKeyPoolProviderId {
  return (
    typeof value === "string" &&
    (WEB_SEARCH_KEY_POOL_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

export function isWebSearchKeyPoolStrategy(value: unknown): value is WebSearchKeyPoolStrategy {
  return value === "ordered" || value === "round-robin";
}

export function isWebSearchKeyPoolEntryId(value: unknown): value is string {
  return typeof value === "string" && ENTRY_ID_PATTERN.test(value);
}

/**
 * Bound a display label. Control characters are collapsed to spaces and an
 * empty label becomes the supplied fallback, so a label can never carry a
 * line break into logs or UI.
 */
export function normalizeWebSearchKeyPoolLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").replace(/\s+/gu, " ");
  const trimmed = Array.from(cleaned.trim())
    .slice(0, MAX_WEB_SEARCH_KEY_POOL_LABEL_CHARS)
    .join("")
    .trim();
  return trimmed || fallback;
}

/**
 * Apply a caller-provided order. The order must be an exact permutation of
 * the current entry IDs so a stale renderer cannot drop or resurrect a key.
 */
export function reorderWebSearchKeyPoolEntries<T extends { readonly id: string }>(
  entries: readonly T[],
  orderedIds: unknown,
): T[] {
  if (!Array.isArray(orderedIds) || orderedIds.length !== entries.length) {
    throw new Error("The key order no longer matches the saved keys.");
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const next: T[] = [];
  for (const id of orderedIds) {
    if (typeof id !== "string" || seen.has(id)) {
      throw new Error("The key order no longer matches the saved keys.");
    }
    const entry = byId.get(id);
    if (!entry) throw new Error("The key order no longer matches the saved keys.");
    seen.add(id);
    next.push(entry);
  }
  return next;
}

/** Move one entry up or down, returning the resulting ID order. */
export function moveWebSearchKeyPoolEntry(
  entries: readonly { readonly id: string }[],
  index: number,
  direction: -1 | 1,
): string[] {
  const ids = entries.map((entry) => entry.id);
  const target = index + direction;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return ids;
  [ids[index], ids[target]] = [ids[target]!, ids[index]!];
  return ids;
}

/** Short, human-readable remaining cooldown, e.g. "45s", "12m", "3h 5m". */
export function formatWebSearchKeyPoolCooldown(until: number, now: number): string {
  const remainingSeconds = Math.max(1, Math.ceil((until - now) / 1_000));
  if (remainingSeconds < 60) return `${remainingSeconds}s`;
  const minutes = Math.ceil(remainingSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
