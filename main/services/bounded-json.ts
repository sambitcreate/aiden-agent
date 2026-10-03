import type { JsonValue } from "@earendil-works/pi-ai";

/** Work and size limits for copying untrusted JSON-shaped values. */
export interface JsonCopyBounds {
  /** Maximum number of values visited, containers included. */
  maxNodes: number;
  /** Maximum nesting depth; the root is depth 0. */
  maxDepth: number;
  /** Size budget charged per value; strings and keys cost `measure(text)` plus their JSON punctuation. */
  maxSize: number;
  /** Size of a string or key, before quoting. */
  measure: (text: string) => number;
}

/** Exact UTF-8 size, for budgets stated in bytes. */
export const utf8Size = (text: string): number => Buffer.byteLength(text, "utf8");
/** Upper bound of JSON-escaped length (every UTF-16 unit as `\uXXXX`), without encoding the string. */
export const worstCaseJsonSize = (text: string): number => text.length * 6;

/**
 * Copy plain JSON (null-prototype objects in the result) or return undefined.
 * Accessors never run, cycles, sparse arrays, class instances and non-JSON
 * values are rejected, and work stops as soon as a bound is exceeded, so a
 * hostile value cannot force unbounded allocation. Repeated (acyclic)
 * references are copied each time and count against the bounds each time.
 */
export function copyBoundedJson(value: unknown, bounds: JsonCopyBounds): JsonValue | undefined {
  let nodes = 0;
  let remaining = bounds.maxSize;
  const ancestors = new Set<object>();
  function copy(entry: unknown, depth: number): JsonValue {
    if (++nodes > bounds.maxNodes || depth > bounds.maxDepth || remaining <= 0) throw new Error("limit");
    if (entry === null || typeof entry === "boolean") { remaining -= 5; return entry; }
    if (typeof entry === "number" && Number.isFinite(entry)) { remaining -= 32; return entry; }
    if (typeof entry === "string") {
      remaining -= bounds.measure(entry) + 2;
      if (remaining < 0) throw new Error("limit");
      return entry;
    }
    if (!entry || typeof entry !== "object" || ancestors.has(entry)) throw new Error("invalid JSON");
    const prototype = Object.getPrototypeOf(entry);
    if (!Array.isArray(entry) && prototype !== Object.prototype && prototype !== null) throw new Error("invalid object");
    ancestors.add(entry);
    remaining -= 2;
    const output: Record<string, JsonValue> | JsonValue[] = Array.isArray(entry) ? [] : Object.create(null);
    for (const key in entry) {
      if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
      remaining -= bounds.measure(key) + 4;
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("accessor");
      const next = copy(descriptor.value, depth + 1);
      if (Array.isArray(output)) {
        if (key !== String(output.length)) throw new Error("non-JSON array");
        output.push(next);
      } else output[key] = next;
    }
    if (Array.isArray(entry) && (output as JsonValue[]).length !== entry.length) throw new Error("sparse array");
    ancestors.delete(entry);
    return output;
  }
  try { return copy(value, 0); } catch { return undefined; }
}
