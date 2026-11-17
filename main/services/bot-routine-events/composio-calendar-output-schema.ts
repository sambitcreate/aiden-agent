// Only curated Calendar OUTPUT schemas use this normalization. It implements
// acyclic, root-local definition pointers, not a general JSON Schema resolver.
import { copyBoundedJson, utf8Size } from "../bounded-json.js";

type RecordValue = Record<string, unknown>;
export type ComposioCalendarReferenceFailure = "invalid_json" | "invalid_definition" | "unsupported_reference" | "missing_target" | "cycle" | "reference_siblings" | "nested_definitions" | "expansion_limit";
export class ComposioCalendarOutputSchemaError extends Error {
  constructor(readonly failure: ComposioCalendarReferenceFailure, readonly keyword: "$ref" | "$defs" | "definitions" | "properties" | "anyOf" | "oneOf" | "allOf" | "other", readonly work: { nodes: number; depth: number; nodeLimit: 512; depthLimit: 12 }) { super("Calendar output schema has an unsupported local reference."); }
}
const BOUNDS = { maxNodes: 12_000, maxDepth: 18, maxSize: 256 * 1024, measure: utf8Size };
const ANNOTATIONS = new Set(["title", "description", "default", "examples", "deprecated", "$comment"]);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
const safeName = (name: string) => /^[A-Za-z0-9_-]{1,128}$/u.test(name) && !["__proto__", "prototype", "constructor"].includes(name);

/** Expand used references and return a separate schema for auditing every unused
 * definition through the EXISTING restricted compiler before discarding it.
 * The original schema remains the caller's fingerprint input. */
export function normalizeComposioCalendarOutputSchema(value: unknown): { schema: unknown; audit?: unknown } {
  let nodes = 0, depth = 0;
  let remainingExpandedBytes = BOUNDS.maxSize;
  const fail = (failure: ComposioCalendarReferenceFailure, keyword: ComposioCalendarOutputSchemaError["keyword"] = "$ref"): never => { throw new ComposioCalendarOutputSchemaError(failure, keyword, { nodes: Math.min(nodes, 513), depth: Math.min(depth, 13), nodeLimit: 512, depthLimit: 12 }); };
  const bounded = (value: unknown, expanded = false) => {
    const copy = copyBoundedJson(value, expanded ? { ...BOUNDS, maxSize: remainingExpandedBytes } : BOUNDS);
    if (copy === undefined) return fail(expanded ? "expansion_limit" : "invalid_json", "other");
    const bytes = Buffer.byteLength(JSON.stringify(copy), "utf8");
    if (bytes > BOUNDS.maxSize || (expanded && bytes > remainingExpandedBytes)) return fail(expanded ? "expansion_limit" : "invalid_json", "other");
    if (expanded) remainingExpandedBytes -= bytes;
    return copy;
  };
  const root = bounded(value);
  if (!record(root)) return fail("invalid_json", "other");
  const tables = new Map<string, RecordValue>();
  for (const key of ["$defs", "definitions"] as const) if (own(root, key)) {
    const table = root[key]; if (!record(table)) return fail("invalid_definition", key);
    for (const name of Object.keys(table)) if (!safeName(name)) return fail("invalid_definition", key);
    tables.set(key, table);
  }
  const used = new Set<string>();
  const expand = (value: unknown, level: number, active: Set<string>, atRoot = false): unknown => {
    nodes++; depth = Math.max(depth, level);
    if (nodes > 512 || level > 12) return fail("expansion_limit", "other");
    if (typeof value === "boolean") return value;
    if (!record(value)) return fail("invalid_definition", "other");
    if (own(value, "$ref")) {
      if (Object.keys(value).some((key) => key !== "$ref" && !ANNOTATIONS.has(key))) return fail("reference_siblings");
      const match = typeof value.$ref === "string" ? /^#\/(\$defs|definitions)\/([A-Za-z0-9_-]{1,128})$/u.exec(value.$ref) : null;
      if (!match || !safeName(match[2]!)) return fail("unsupported_reference");
      const container = match[1]!, name = match[2]!, table = tables.get(container), key = `${container}/${name}`;
      if (!table || !own(table, name)) return fail("missing_target");
      if (active.has(key)) return fail("cycle");
      used.add(key); active.add(key);
      // Annotations beside $ref never override the target and never execute.
      try { return expand(table[name], level, active); } finally { active.delete(key); }
    }
    const result: RecordValue = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
      if (key === "$defs" || key === "definitions") { if (!atRoot) return fail("nested_definitions", key); continue; }
      if (key === "properties") {
        if (!record(entry)) return fail("invalid_definition", "properties");
        const properties: RecordValue = Object.create(null);
        for (const [name, child] of Object.entries(entry)) properties[name] = expand(child, level + 1, active);
        result[key] = properties;
      } else if (key === "items" || key === "additionalProperties") result[key] = expand(entry, level + 1, active);
      else if (key === "anyOf" || key === "oneOf" || key === "allOf") {
        if (!Array.isArray(entry) || entry.length > 8) return fail("invalid_definition", key);
        result[key] = entry.map((child) => expand(child, level + 1, active));
      } else result[key] = entry; // Annotation/default/example values stay inert.
    }
    return result;
  };
  const schema = bounded(expand(root, 0, new Set(), true), true);
  const auditProperties: RecordValue = Object.create(null);
  let audits = 0;
  for (const [container, table] of tables) for (const [name, target] of Object.entries(table)) {
    const key = `${container}/${name}`;
    if (used.has(key)) continue;
    used.add(key);
    auditProperties[`definition_${audits++}`] = expand(target, 1, new Set([key]));
  }
  const audit = audits ? bounded({ type: "object", properties: auditProperties, additionalProperties: false }, true) : undefined;
  return { schema, ...(audit === undefined ? {} : { audit }) };
}
