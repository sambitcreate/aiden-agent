// Structured results for started chats (docs/plans/proactive-aiden-plan.md,
// Phase 5, D6). A lead may give each chat it starts a JSON Schema; the started
// chat hands its answer back with `submit_result`, checked here with ajv. A
// schema is at most 16 KB and may only refer inside itself: nothing is ever
// fetched to resolve it.

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

/** The first `$ref`/`$dynamicRef` that points outside the schema, if any. */
function remoteReference(value: unknown, depth = 0): string | undefined {
  if (depth > 64) return "(nested too deeply)";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = remoteReference(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "$ref" || key === "$dynamicRef") && (typeof child !== "string" || !child.startsWith("#"))) {
      return typeof child === "string" ? child : "(not a string)";
    }
    const found = remoteReference(child, depth + 1);
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
  const remote = remoteReference(schema);
  if (remote) return { ok: false, error: `result_schema may only refer inside itself; ${remote} points elsewhere.` };
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
  return isRecord(value) && byteLength(value) <= RESULT_SCHEMA_MAX_BYTES && remoteReference(value) === undefined;
}

export function isStorableResult(value: unknown): boolean {
  return value !== undefined && byteLength(value) <= RESULT_MAX_BYTES;
}
