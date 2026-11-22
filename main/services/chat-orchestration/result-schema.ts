// Structured results for started chats (docs/plans/proactive-aiden-plan.md,
// Phase 5, D6). A lead may give each chat it starts a JSON Schema; the started
// chat hands its answer back with `submit_result`, checked here with ajv. A
// schema is at most 16 KB, may only refer to its root or its own `$defs` /
// `definitions` (nothing is ever fetched to resolve it) and may not contain a
// regular expression anywhere.

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";

export const RESULT_SCHEMA_MAX_BYTES = 16 * 1024;
/** The most a submitted result may weigh, as JSON. */
export const RESULT_MAX_BYTES = 64 * 1024;

export type ResultSchemaCheck = { ok: true; validate: ValidateFunction } | { ok: false; error: string };

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
  try {
    const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    return { ok: true, validate: ajv.compile(schema) };
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

/** Checks a submitted result against its schema, naming the fields that fail. */
export function checkResult(schema: unknown, value: unknown): { ok: true } | { ok: false; error: string } {
  if (value === undefined) return { ok: false, error: "submit_result needs a result." };
  if (byteLength(value) > RESULT_MAX_BYTES) return { ok: false, error: `The result is larger than ${RESULT_MAX_BYTES / 1024} KB.` };
  const compiled = compileResultSchema(schema);
  if (!compiled.ok) return compiled;
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
    regexKeyword(value) === undefined
  );
}

export function isStorableResult(value: unknown): boolean {
  return value !== undefined && byteLength(value) <= RESULT_MAX_BYTES;
}
