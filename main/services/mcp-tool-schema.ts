/**
 * Provider-safe normalization for MCP tool input schemas.
 *
 * Rust MCP servers built with `schemars` annotate numeric fields with formats such as
 * `uint32`, `int8`, `uint`, or `double`. Those are not JSON Schema formats, and some
 * providers reject tool definitions that carry them. This module removes those
 * formats and, where a width is meaningful and representable as an exact JSON
 * number, re-expresses it as `minimum` / `maximum` so the model still sees the range.
 *
 * The normalizer is pure: it never mutates its input, and it leaves every other keyword,
 * including standard formats (`date-time`, `uri`, ...), untouched. Callers must keep
 * using the raw server schema for identity checks (fingerprints, drift detection);
 * only the schema handed to the model is normalized.
 */

type NumericRange = { minimum?: number; maximum?: number };

/**
 * Non-standard numeric formats emitted by schemars (and OpenAPI-flavoured generators).
 * 64/128-bit and pointer-width bounds are omitted where they exceed exact JSON numbers.
 */
const NUMERIC_FORMAT_RANGES: ReadonlyMap<string, NumericRange> = new Map([
  ["int8", { minimum: -128, maximum: 127 }],
  ["int16", { minimum: -32_768, maximum: 32_767 }],
  ["int32", { minimum: -2_147_483_648, maximum: 2_147_483_647 }],
  ["int64", {}],
  ["int128", {}],
  ["int", {}],
  ["uint8", { minimum: 0, maximum: 255 }],
  ["uint16", { minimum: 0, maximum: 65_535 }],
  ["uint32", { minimum: 0, maximum: 4_294_967_295 }],
  ["uint64", { minimum: 0 }],
  ["uint128", { minimum: 0 }],
  ["uint", { minimum: 0 }],
  ["float", {}],
  ["double", {}],
  ["float32", {}],
  ["float64", {}],
]);

/** Keywords whose value is a single subschema. */
const SUBSCHEMA_KEYWORDS = new Set([
  "additionalProperties",
  "additionalItems",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "items",
]);

/** Keywords whose value is an array of subschemas. */
const SUBSCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems", "items"]);

/** Keywords whose value maps names to subschemas. */
const SUBSCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowsNumbers(type: unknown): boolean {
  if (type === undefined) return true;
  const types = Array.isArray(type) ? type : [type];
  return types.some((entry) => entry === "integer" || entry === "number");
}

function tighten(
  schema: Record<string, unknown>,
  key: "minimum" | "maximum",
  bound: number | undefined,
): void {
  if (bound === undefined) return;
  const current = schema[key];
  if (typeof current !== "number" || !Number.isFinite(current)) {
    schema[key] = bound;
    return;
  }
  schema[key] = key === "minimum" ? Math.max(current, bound) : Math.min(current, bound);
}

function normalizeSchema(value: unknown): unknown {
  const copies = new WeakMap<object, Record<string, unknown>>();
  const pending: Array<{ source: Record<string, unknown>; target: Record<string, unknown> }> = [];
  const copySchema = (source: unknown): unknown => {
    if (!isRecord(source)) return source;
    const existing = copies.get(source);
    if (existing) return existing;
    const target: Record<string, unknown> = {};
    copies.set(source, target);
    pending.push({ source, target });
    return target;
  };
  const result = copySchema(value);
  // A worklist normalizes deep schemas completely without consuming the JS call
  // stack. Reused schema objects are copied once; raw identity stays untouched.
  while (pending.length > 0) {
    const { source, target } = pending.pop()!;
    for (const [key, entry] of Object.entries(source)) {
      if (SUBSCHEMA_MAP_KEYWORDS.has(key) && isRecord(entry)) {
        target[key] = Object.fromEntries(
          Object.entries(entry).map(([name, schema]) => [name, copySchema(schema)]),
        );
      } else if (SUBSCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(entry)) {
        target[key] = entry.map(copySchema);
      } else if (SUBSCHEMA_KEYWORDS.has(key) && isRecord(entry)) {
        target[key] = copySchema(entry);
      } else {
        target[key] = entry;
      }
    }
    const format = typeof target.format === "string" ? target.format.toLowerCase() : undefined;
    const range = format === undefined ? undefined : NUMERIC_FORMAT_RANGES.get(format);
    if (range) {
      delete target.format;
      if (allowsNumbers(target.type)) {
        tighten(target, "minimum", range.minimum);
        tighten(target, "maximum", range.maximum);
      }
    }
  }
  return result;
}

/**
 * Return a copy of an MCP tool input schema with non-standard numeric formats replaced
 * by portable range constraints. Non-object input is returned unchanged.
 */
export function normalizeMcpToolInputSchema<T>(schema: T): T {
  return normalizeSchema(schema) as T;
}
