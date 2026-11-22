// Structured results for started chats (docs/plans/proactive-aiden-plan.md,
// Phase 5, D6). A lead may give each chat it starts a JSON Schema; the started
// chat hands its answer back with `submit_result`, checked here with ajv. A
// schema is at most 16 KB, may only refer to its root or its own `$defs` /
// `definitions` (nothing is ever fetched to resolve it; references must not
// loop), may not contain a regular expression anywhere, and its worst-case
// checking work is bounded before ajv compiles it. A submitted result is
// bounded too (64 KB, 10,000 values, 64 levels), and its size times the
// schema's cost must stay under a fixed budget before ajv checks it.

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";

export const RESULT_SCHEMA_MAX_BYTES = 16 * 1024;
/** The most a submitted result may weigh, as JSON. */
export const RESULT_MAX_BYTES = 64 * 1024;

/** The most values (objects, arrays, strings, numbers…) a submitted result may hold. */
export const RESULT_MAX_VALUES = 10_000;
/** The most levels a submitted result may nest. */
export const RESULT_MAX_DEPTH = 64;
/**
 * The most work one check may do: the schema's cost (`schemaCost`) times the
 * result's size (`resultSize`). ajv may try every branch of the schema at
 * every value, and string keywords (`minLength`) read each string per branch.
 */
export const RESULT_CHECK_MAX_WORK = 1_000_000;
/** Characters of string that count as one more value of size. */
const STRING_CHARS_PER_UNIT = 64;

export type ResultSchemaCheck = { ok: true; validate: ValidateFunction; cost: number } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/**
 * The only references a schema may make: to its own root, or to a named entry
 * of its own `$defs` or `definitions`. A JSON pointer into any other keyword
 * (`#/default`, `#/enum/0`, `#/examples/0`, `#/const`, escaped segments) could
 * make ajv compile data as schema, so none is allowed.
 */
const LOCAL_REFERENCE = /^#(?:\/(?:\$defs|definitions)\/[A-Za-z0-9_.-]{1,128})?$/;
const REFERENCE_KEYWORDS: ReadonlySet<string> = new Set(["$ref", "$dynamicRef", "$recursiveRef"]);
const MAX_DEPTH = 64;
const TOO_DEEP = "(nested too deeply)";

/** The first reference that isn't one of the allowed local forms, if any. */
function disallowedReference(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_DEPTH) return TOO_DEEP;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = disallowedReference(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (REFERENCE_KEYWORDS.has(key) && (typeof child !== "string" || !LOCAL_REFERENCE.test(child))) {
      return typeof child === "string" ? child.slice(0, 200) : "(not a string)";
    }
    const found = disallowedReference(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * Keys ajv turns into a native RegExp. A crafted pattern can backtrack for
 * seconds on a short string and freeze Aiden's main process. ajv follows
 * references and keyword maps in ways that are hard to model, so every object
 * anywhere in the schema is scanned, data keywords and map names included; a
 * `propertyNames` schema is caught by scanning into it. A property that is
 * literally named "pattern" is refused too: the price of a check that can't be
 * talked around.
 */
const REGEX_KEYS: ReadonlySet<string> = new Set(["pattern", "patternProperties"]);

/** The first regular-expression key anywhere in the schema, if any. */
function regexKeyword(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_DEPTH) return TOO_DEEP;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = regexKeyword(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (REGEX_KEYS.has(key)) return key;
    const found = regexKeyword(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** The most work one check of a result may cost, in schema nodes tried (see `schemaCost`). */
export const RESULT_SCHEMA_MAX_COST = 10_000;
/** The most references one schema may contain. */
export const RESULT_SCHEMA_MAX_REFS = 256;

/** Keywords that apply one subschema. */
const ONE_SCHEMA = ["not", "if", "then", "else", "additionalItems", "additionalProperties", "contains", "propertyNames", "unevaluatedItems", "unevaluatedProperties"];
/** Keywords that apply a list of subschemas. */
const SCHEMA_LIST = ["anyOf", "oneOf", "allOf", "prefixItems"];
/** Keywords that apply a map of subschemas. */
const SCHEMA_MAP = ["properties", "patternProperties", "dependentSchemas", "dependencies"];
/** Keys that would change what a reference points at. */
const RESOURCE_KEYS: ReadonlySet<string> = new Set(["$id", "id", "$anchor", "$dynamicAnchor", "$recursiveAnchor"]);
const SCALAR_TYPES: ReadonlySet<string> = new Set(["string", "number", "integer", "boolean", "null"]);

/** One more unit of cost per this many bytes of data a keyword compares against. */
const DATA_BYTES_PER_UNIT = 64;

/**
 * What a node's own keywords cost besides its subschemas: `enum` compares the
 * value with every member (and deep-compares objects, arrays and long
 * strings), `const` deep-compares once, and `required`, `dependentRequired`
 * and draft-07 array `dependencies` check every name they list.
 */
function dataCost(node: Record<string, unknown>): number {
  let extra = 0;
  const data = (value: unknown) => Math.floor(byteLength(value) / DATA_BYTES_PER_UNIT);
  if (Array.isArray(node.enum)) extra += node.enum.length + data(node.enum);
  if ("const" in node) extra += data(node.const);
  if (Array.isArray(node.required)) extra += node.required.length;
  for (const key of ["dependentRequired", "dependencies"]) {
    const map = node[key];
    if (isRecord(map)) for (const names of Object.values(map)) if (Array.isArray(names)) extra += names.length;
  }
  return extra;
}

/**
 * The worst-case work of one check, before ajv sees the schema. Each node
 * costs 1, plus its data keywords (`dataCost`), plus every subschema it
 * applies, with references followed (and memoized), so `anyOf` chains that branch through `$defs` are counted at
 * their real, multiplied size. ajv's `anyOf` has to try every branch when
 * none matches, which is why this is the number that matters. References may
 * not loop, and `uniqueItems` needs items of a plain type: comparing objects
 * or arrays pairwise is quadratic in the result's length.
 */
function schemaCost(root: Record<string, unknown>): { ok: true; cost: number } | { ok: false; error: string } {
  const memo = new Map<unknown, number>();
  const visiting = new Set<unknown>();
  let references = 0;
  let problem: string | undefined;
  const over = RESULT_SCHEMA_MAX_COST + 1;

  const target = (ref: string): unknown => {
    if (ref === "#") return root;
    const [, group, name] = ref.split("/") as [string, string, string];
    const defs = root[group];
    return isRecord(defs) ? defs[name] : undefined;
  };

  function cost(node: unknown, top: boolean): number {
    if (problem) return over;
    if (typeof node === "boolean") return 1;
    if (!isRecord(node)) return 1;
    const known = memo.get(node);
    if (known !== undefined) return known;
    if (visiting.has(node)) {
      problem = "result_schema's references loop back on themselves; refs must not loop.";
      return over;
    }
    visiting.add(node);
    let total = 1 + dataCost(node);
    const add = (child: unknown) => { total = Math.min(over, total + cost(child, false)); };
    for (const key of Object.keys(node)) {
      if (!top && RESOURCE_KEYS.has(key)) {
        problem = `result_schema can't use "${key}" inside the schema.`;
        return over;
      }
    }
    for (const key of REFERENCE_KEYWORDS) {
      const ref = node[key];
      if (typeof ref !== "string") continue;
      references += 1;
      if (references > RESULT_SCHEMA_MAX_REFS) {
        problem = `result_schema has more than ${RESULT_SCHEMA_MAX_REFS} references.`;
        return over;
      }
      const resolved = target(ref);
      if (resolved === undefined) {
        problem = `result_schema refers to ${ref.slice(0, 200)}, which it doesn't define.`;
        return over;
      }
      add(resolved);
    }
    for (const key of ONE_SCHEMA) if (key in node) add(node[key]);
    for (const key of SCHEMA_LIST) if (Array.isArray(node[key])) for (const child of node[key] as unknown[]) add(child);
    for (const key of SCHEMA_MAP) {
      const map = node[key];
      if (isRecord(map)) for (const child of Object.values(map)) if (typeof child === "boolean" || isRecord(child)) add(child);
    }
    const items = node.items;
    if (Array.isArray(items)) for (const child of items) add(child);
    else if (items !== undefined) add(items);
    if (node.uniqueItems === true) {
      const types = isRecord(items) ? (Array.isArray(items.type) ? items.type : [items.type]) : [];
      if (!types.length || !types.every((type) => typeof type === "string" && SCALAR_TYPES.has(type))) {
        problem = "result_schema's uniqueItems needs items with a plain type (string, number, integer, boolean or null).";
        return over;
      }
    }
    visiting.delete(node);
    memo.set(node, total);
    return total;
  }

  const total = cost(root, true);
  if (problem) return { ok: false, error: problem };
  if (total > RESULT_SCHEMA_MAX_COST) {
    return { ok: false, error: "result_schema could take too long to check: its anyOf, oneOf or allOf branches multiply through references, or its enum, const or required lists are too long for them. Use fewer branches, shorter lists or a flatter shape." };
  }
  return { ok: true, cost: total };
}

/** Compiles a lead's schema, or says in one sentence why it can't be used. */
export function compileResultSchema(schema: unknown): ResultSchemaCheck {
  if (!isRecord(schema)) return { ok: false, error: "result_schema must be a JSON Schema object." };
  if (byteLength(schema) > RESULT_SCHEMA_MAX_BYTES) {
    return { ok: false, error: `result_schema is larger than ${RESULT_SCHEMA_MAX_BYTES / 1024} KB.` };
  }
  const reference = disallowedReference(schema);
  if (reference === TOO_DEEP) return { ok: false, error: `result_schema is nested more than ${MAX_DEPTH} levels deep.` };
  if (reference) {
    return { ok: false, error: `result_schema may only refer to "#", "#/$defs/<name>" or "#/definitions/<name>"; ${reference} isn't one of those.` };
  }
  const regex = regexKeyword(schema);
  if (regex === TOO_DEEP) return { ok: false, error: `result_schema is nested more than ${MAX_DEPTH} levels deep.` };
  if (regex) {
    return {
      ok: false,
      error: `result_schema can't contain the key "${regex}" anywhere, even as a property name or inside enum, const, default or examples: Aiden doesn't check regular expressions. Use enum, const or plain types instead.`,
    };
  }
  const cost = schemaCost(schema);
  if (!cost.ok) return cost;
  try {
    // The first error is enough to name what failed, and stops each check early.
    const ajv = new Ajv({ strict: false, validateFormats: false });
    return { ok: true, validate: ajv.compile(schema), cost: cost.cost };
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0]!.slice(0, 200) : "it is not a valid JSON Schema";
    return { ok: false, error: `result_schema doesn't compile: ${reason}.` };
  }
}

function describe(error: ErrorObject): string {
  const where = error.instancePath ? `${error.instancePath}` : "the result";
  if (error.keyword === "required" && typeof error.params.missingProperty === "string") {
    return `${error.instancePath || ""}/${error.params.missingProperty} is required`;
  }
  if (error.keyword === "additionalProperties" && typeof error.params.additionalProperty === "string") {
    return `${error.instancePath || ""}/${error.params.additionalProperty} is not allowed`;
  }
  return `${where} ${error.message ?? "is invalid"}`;
}

/**
 * A result's size for the work budget: one per value (object, array, string,
 * number, boolean, null, and each object key), plus one per 64 characters of
 * every string and key. Walked without recursion, and stopped as soon as the
 * result holds more than `RESULT_MAX_VALUES` values or nests more than
 * `RESULT_MAX_DEPTH` levels, so a hostile value costs little to measure.
 */
function resultSize(value: unknown): { ok: true; size: number } | { ok: false; error: string } {
  let values = 0;
  let chars = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length) {
    const next = stack.pop()!;
    values += 1;
    if (values > RESULT_MAX_VALUES) {
      return { ok: false, error: `The result holds more than ${RESULT_MAX_VALUES.toLocaleString("en-US")} values; send a shorter one.` };
    }
    if (next.depth > RESULT_MAX_DEPTH) return { ok: false, error: `The result is nested more than ${RESULT_MAX_DEPTH} levels deep.` };
    if (typeof next.value === "string") chars += next.value.length;
    else if (Array.isArray(next.value)) {
      for (const item of next.value) stack.push({ value: item, depth: next.depth + 1 });
    } else if (isRecord(next.value)) {
      for (const [key, item] of Object.entries(next.value)) {
        values += 1;
        chars += key.length;
        stack.push({ value: item, depth: next.depth + 1 });
      }
    }
  }
  return { ok: true, size: values + Math.floor(chars / STRING_CHARS_PER_UNIT) };
}

/** Checks a submitted result against its schema, naming the fields that fail. */
export function checkResult(schema: unknown, value: unknown): { ok: true } | { ok: false; error: string } {
  if (value === undefined) return { ok: false, error: "submit_result needs a result." };
  // Measured before anything serializes it, so a deep value can't overflow the stack.
  const size = resultSize(value);
  if (!size.ok) return size;
  if (byteLength(value) > RESULT_MAX_BYTES) return { ok: false, error: `The result is larger than ${RESULT_MAX_BYTES / 1024} KB.` };
  const compiled = compileResultSchema(schema);
  if (!compiled.ok) return compiled;
  if (compiled.cost * size.size > RESULT_CHECK_MAX_WORK) {
    return {
      ok: false,
      error: "The result is too large to check against this schema, whose branches make every value costly to check. Send a shorter result (fewer items, shorter text).",
    };
  }
  if (compiled.validate(value)) return { ok: true };
  const reasons = (compiled.validate.errors ?? []).slice(0, 5).map(describe);
  return { ok: false, error: `The result doesn't match the schema: ${reasons.join("; ")}.` };
}

/** Whether a stored schema is still usable, for the link parser. */
export function isStorableResultSchema(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    byteLength(value) <= RESULT_SCHEMA_MAX_BYTES &&
    disallowedReference(value) === undefined &&
    regexKeyword(value) === undefined &&
    schemaCost(value).ok
  );
}

export function isStorableResult(value: unknown): boolean {
  return value !== undefined && byteLength(value) <= RESULT_MAX_BYTES;
}
