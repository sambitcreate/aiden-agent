import { types as utilTypes } from "node:util";
import { hasExactKeys, isPlainObject, snapshotPlainDataRecord } from "./guards.js";

/**
 * True when `value` is an unproxied plain object (`Object.prototype` or `null`
 * prototype). Rejects `Proxy` instances before inspecting prototypes so proxy
 * traps never execute.
 */
export function isUnproxiedPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !utilTypes.isProxy(value) &&
    isPlainObject(value)
  );
}

/**
 * Snapshot an unproxied plain object whose own keys are all enumerable string
 * data properties, preserving `"__proto__"` via `Object.defineProperty`.
 */
export function snapshotPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) {
    return undefined;
  }
  return snapshotPlainDataRecord(value);
}

/**
 * Snapshot an unproxied plain data record and verify that it owns every
 * `required` key and no key outside `required` and `optional`.
 */
export function snapshotExactPlainRecord(
  value: unknown,
  required: Iterable<string>,
  optional: Iterable<string> = [],
): Record<string, unknown> | undefined {
  const snapshot = snapshotPlainRecord(value);
  return snapshot && hasExactKeys(snapshot, required, optional) ? snapshot : undefined;
}
