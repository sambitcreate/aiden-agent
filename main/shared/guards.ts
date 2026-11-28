/** Shared structural guards for untrusted JSON-shaped values across main and renderer. */

/** A non-null, non-array object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A plain object record whose prototype is `Object.prototype` or `null`. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Snapshot a plain object whose own keys are all enumerable string data
 * properties, preserving `"__proto__"` as an own property via
 * `Object.defineProperty` without mutating the snapshot prototype or invoking
 * accessors.
 */
export function snapshotPlainDataRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return undefined;
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      return undefined;
    }
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

/**
 * True when `record` owns every `required` key and has no key outside
 * `required` and `optional`. Inherited properties never satisfy a requirement.
 */
export function hasExactKeys(
  record: Record<string, unknown>,
  required: Iterable<string>,
  optional: Iterable<string> = [],
): boolean {
  const requiredKeys = [...required];
  const allowed = new Set([...requiredKeys, ...optional]);
  return (
    requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(record, key)) &&
    Object.keys(record).every((key) => allowed.has(key))
  );
}
