/**
 * Own-property lookups for keys that come from the model or a stored tree.
 * Plain objects inherit `constructor`, `toString`, `__proto__` and friends, so
 * a bare `table[name]` can resolve to a function or prototype. Every lookup
 * keyed by a model-written string goes through these helpers, which read only
 * entries the object owns.
 */

export function hasOwn(target: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/** The table entry named `key`, or undefined when the name is inherited or absent. */
export function ownEntry<V>(table: Readonly<Record<string, V>>, key: unknown): V | undefined {
  return typeof key === "string" && hasOwn(table, key) ? table[key] : undefined;
}

/** The own field `key` of a value, or undefined. */
export function ownField(value: unknown, key: unknown): unknown {
  if (!value || typeof value !== "object" || typeof key !== "string" || !hasOwn(value, key)) return undefined;
  return (value as Record<string, unknown>)[key];
}

/**
 * A record that holds only the own entries of `value` (or nothing, for a
 * non-object). It has no prototype, so any key read from it is an own entry.
 */
export function ownRecord(value: unknown): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const key of Object.keys(value)) out[key] = (value as Record<string, unknown>)[key];
  return out;
}
