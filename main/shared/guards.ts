/** Shared structural guards for untrusted JSON-shaped values. */

/** A non-null, non-array object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return `value` narrowed to a record, or `undefined` when it is not a record. */
export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/**
 * A plain object (`Object.prototype` or `null` prototype), never a Map, Date,
 * or class instance.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** True when `record` owns `key` directly (ignoring inherited properties). */
export function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Read an own property from `record`, ignoring inherited prototype entries. */
export function ownEntry<V>(record: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * Define an own enumerable writable configurable property on `record`, so keys
 * like `__proto__` or `constructor` become own data entries rather than
 * mutating the prototype chain.
 */
export function setOwnEntry<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * True when `record` owns every `required` key and has no key outside
 * `required` and `optional`. Inherited properties never satisfy a requirement.
 */
export function hasExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(record, key)) &&
    Object.keys(record).every((key) => allowed.has(key))
  );
}

export interface RecordErrorMessages {
  record: string;
  fields: string;
}

/**
 * Validate that `value` is a record whose own enumerable keys are all in
 * `allowed`. Throws `error` (or `error.record` / `error.fields` when distinct)
 * on failure.
 */
export function requireAllowedKeys(
  value: unknown,
  allowed: ReadonlySet<string> | readonly string[],
  error: string | RecordErrorMessages,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(typeof error === "string" ? error : error.record);
  }
  const set = allowed instanceof Set ? allowed : new Set(allowed);
  const keys = Object.keys(value);
  if (keys.length > set.size || keys.some((key) => !set.has(key))) {
    throw new Error(typeof error === "string" ? error : error.fields);
  }
  return value;
}

/**
 * Validate that `value` is a plain object (`Object.prototype` or `null`
 * prototype) owning every `required` key and no key outside `required` and
 * `optional`.
 */
export function requirePlainShape(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  error: string,
): Record<string, unknown> {
  if (!isPlainRecord(value) || !hasExactKeys(value, required, optional)) {
    throw new Error(error);
  }
  return value;
}

/**
 * True when `value` is a non-empty string with at most `maximum` Unicode scalar
 * values (code points). Counts in a loop without allocating an array.
 */
export function boundedString(value: unknown, maximum: number): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  let characters = 0;
  for (const _character of value) {
    characters += 1;
    if (characters > maximum) return false;
  }
  return true;
}

/** UTF-8 byte length matching `Buffer.byteLength(value, "utf8")` without Node globals or allocations. */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Validate a non-empty string bounded by UTF-16 code units (`maxChars`) and
 * UTF-8 byte length (`maxBytes`), returning both the string and its UTF-8 byte
 * length. Throws `Invalid ${label}.` on failure.
 */
export function parseUtf8BoundedString(
  value: unknown,
  label: string,
  maxChars: number,
  maxBytes: number,
): { value: string; bytes: number };
export function parseUtf8BoundedString(
  value: unknown,
  label: string,
  maxChars: number,
  maxBytes: number,
  optional: false,
): { value: string; bytes: number };
export function parseUtf8BoundedString(
  value: unknown,
  label: string,
  maxChars: number,
  maxBytes: number,
  optional: boolean,
): { value: string | undefined; bytes: number };
export function parseUtf8BoundedString(
  value: unknown,
  label: string,
  maxChars: number,
  maxBytes: number,
  optional = false,
): { value: string | undefined; bytes: number } {
  if (value === undefined && optional) return { value: undefined, bytes: 0 };
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
    throw new Error(`Invalid ${label}.`);
  }
  const bytes = utf8ByteLength(value);
  if (bytes > maxBytes) throw new Error(`Invalid ${label}.`);
  return { value, bytes };
}

/** Non-negative safe integer timestamp. */
export function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Non-negative finite timestamp. */
export function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Return `value` when it is a non-negative finite timestamp, otherwise `undefined`. */
export function timestampOf(value: unknown): number | undefined {
  return isFiniteTimestamp(value) ? value : undefined;
}
