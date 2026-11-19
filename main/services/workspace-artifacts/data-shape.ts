/**
 * One-line descriptions of a source's data for the model, such as
 * `array(42) of {month: string, total: number}`, so it can write markup that
 * reads the right fields without being sent the data itself.
 */

const MAX_SHAPE_CHARS = 240;
const MAX_SAMPLE_CHARS = 240;
/** Items of a list read to learn its element shape. */
const ITEMS_READ = 25;
const MAX_FIELDS = 12;
/** Nesting levels described before an object or list is named without its contents. */
const MAX_DEPTH = 3;
const MAX_ALTERNATIVES = 3;

function bounded(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectShape(objects: readonly Record<string, unknown>[], depth: number): string {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const object of objects) {
    for (const key of Object.keys(object)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  if (keys.length === 0) return "{}";
  const fields = keys.slice(0, MAX_FIELDS).map((key) => {
    const present = objects.filter((object) => Object.prototype.hasOwnProperty.call(object, key));
    const optional = present.length < objects.length ? "?" : "";
    return `${key}${optional}: ${shapeOf(present.map((object) => object[key]), depth + 1)}`;
  });
  if (keys.length > MAX_FIELDS) fields.push(`…${keys.length - MAX_FIELDS} more`);
  return `{${fields.join(", ")}}`;
}

/** The shape every value in `values` fits: one type, or up to three joined by |. */
function shapeOf(values: readonly unknown[], depth: number): string {
  const parts: string[] = [];
  const primitives = new Set<string>();
  const arrays: unknown[][] = [];
  const objects: Record<string, unknown>[] = [];
  for (const value of values) {
    if (Array.isArray(value)) arrays.push(value);
    else if (isObject(value)) objects.push(value);
    else primitives.add(value === null ? "null" : typeof value);
  }
  for (const name of ["string", "number", "boolean"]) if (primitives.has(name)) parts.push(name);
  if (arrays.length) {
    const items = arrays.flatMap((array) => array.slice(0, ITEMS_READ)).slice(0, ITEMS_READ);
    // A list adds no level of its own: its items are read at the depth it sits.
    parts.push(items.length === 0 ? "array" : `array of ${shapeOf(items, depth)}`);
  }
  if (objects.length) parts.push(depth >= MAX_DEPTH ? "object" : objectShape(objects.slice(0, ITEMS_READ), depth));
  if (primitives.has("null")) parts.push("null");
  if (parts.length === 0) return "unknown";
  return parts.length > MAX_ALTERNATIVES ? "mixed" : parts.join(" | ");
}

/**
 * The data's shape on one bounded line. A top-level list gives its length, so
 * `array(0)` tells an empty result apart from a missing one.
 */
export function describeDataShape(value: unknown): string {
  const shape = Array.isArray(value)
    ? `array(${value.length})${value.length ? ` of ${shapeOf(value.slice(0, ITEMS_READ), 0)}` : ""}`
    : shapeOf([value], 0);
  return bounded(shape, MAX_SHAPE_CHARS);
}

/** A short sample of the data as JSON: the first items of a list, or the start of the value. */
export function describeDataSample(value: unknown): string {
  const sample = Array.isArray(value) && value.length > 2 ? [...value.slice(0, 2), `…${value.length - 2} more`] : value;
  return bounded(JSON.stringify(sample) ?? "null", MAX_SAMPLE_CHARS);
}

/** Shape and sample of a source result's stored JSON, or undefined when there is none to read. */
export function describeSourceData(dataJson: string | undefined): { shape: string; sample: string } | undefined {
  if (dataJson === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(dataJson);
  } catch {
    return undefined;
  }
  return { shape: describeDataShape(value), sample: describeDataSample(value) };
}
