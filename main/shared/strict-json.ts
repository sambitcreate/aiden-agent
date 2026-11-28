/**
 * Parameterized RFC 8259 JSON scanner for untrusted wire payloads and durable
 * store snapshots.
 *
 * `JSON.parse` keeps only the last occurrence of a duplicate object key and
 * accepts arbitrary nesting up to V8's stack limit. Callers run `scanStrictJson`
 * first to reject duplicate keys (including escaped-equivalent spellings such
 * as `"a"` and `"\\u0061"`), bound nesting depth and cumulative object keys,
 * and optionally reject unpaired UTF-16 surrogates and non-finite numbers
 * while raising caller-specific errors.
 */

export interface StrictJsonScanOptions {
  readonly maxDepth: number;
  readonly maxObjectKeys: number;
  readonly rejectLoneSurrogates: boolean;
  readonly rejectNonFiniteNumbers: boolean;
  readonly onInvalid: () => never;
}

/** True when `value` contains no unpaired high or low UTF-16 surrogates. */
export function isValidJsonString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (
        Number.isNaN(nextCodeUnit) ||
        nextCodeUnit < 0xdc00 ||
        nextCodeUnit > 0xdfff
      ) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function scanStrictJson(
  serialized: string,
  {
    maxDepth,
    maxObjectKeys,
    rejectLoneSurrogates,
    rejectNonFiniteNumbers,
    onInvalid,
  }: StrictJsonScanOptions,
): void {
  let offset = 0;
  let objectKeys = 0;

  function fail(): never {
    return onInvalid();
  }

  function skipWhitespace(): void {
    while (
      serialized[offset] === " " ||
      serialized[offset] === "\t" ||
      serialized[offset] === "\n" ||
      serialized[offset] === "\r"
    ) {
      offset += 1;
    }
  }

  function readString(decode: boolean): string | undefined {
    if (serialized[offset] !== '"') fail();
    offset += 1;
    const shouldDecode = decode || rejectLoneSurrogates;
    let segmentStart = offset;
    let decoded = "";
    while (offset < serialized.length) {
      const character = serialized[offset]!;
      if (character === '"') {
        if (shouldDecode) decoded += serialized.slice(segmentStart, offset);
        if (rejectLoneSurrogates && !isValidJsonString(decoded)) fail();
        offset += 1;
        return decode ? decoded : undefined;
      }
      if (character === "\\") {
        if (shouldDecode) decoded += serialized.slice(segmentStart, offset);
        offset += 1;
        const escaped = serialized[offset];
        if (escaped === undefined) fail();
        if (escaped === "u") {
          const hexadecimal = serialized.slice(offset + 1, offset + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(hexadecimal)) fail();
          if (shouldDecode) {
            decoded += String.fromCharCode(Number.parseInt(hexadecimal, 16));
          }
          offset += 5;
          segmentStart = offset;
          continue;
        }
        const replacement =
          escaped === '"'
            ? '"'
            : escaped === "\\"
              ? "\\"
              : escaped === "/"
                ? "/"
                : escaped === "b"
                  ? "\b"
                  : escaped === "f"
                    ? "\f"
                    : escaped === "n"
                      ? "\n"
                      : escaped === "r"
                        ? "\r"
                        : escaped === "t"
                          ? "\t"
                          : undefined;
        if (replacement === undefined) fail();
        if (shouldDecode) decoded += replacement;
        offset += 1;
        segmentStart = offset;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) fail();
      offset += 1;
    }
    fail();
  }

  function readNumber(): void {
    const numberStart = offset;
    if (serialized[offset] === "-") offset += 1;
    if (serialized[offset] === "0") {
      offset += 1;
    } else {
      const first = serialized.charCodeAt(offset);
      if (!(first >= 0x31 && first <= 0x39)) fail();
      do {
        offset += 1;
      } while (serialized.charCodeAt(offset) >= 0x30 && serialized.charCodeAt(offset) <= 0x39);
    }
    if (serialized[offset] === ".") {
      offset += 1;
      const firstFraction = serialized.charCodeAt(offset);
      if (!(firstFraction >= 0x30 && firstFraction <= 0x39)) fail();
      do {
        offset += 1;
      } while (serialized.charCodeAt(offset) >= 0x30 && serialized.charCodeAt(offset) <= 0x39);
    }
    if (serialized[offset] === "e" || serialized[offset] === "E") {
      offset += 1;
      if (serialized[offset] === "+" || serialized[offset] === "-") offset += 1;
      const firstExponent = serialized.charCodeAt(offset);
      if (!(firstExponent >= 0x30 && firstExponent <= 0x39)) fail();
      do {
        offset += 1;
      } while (serialized.charCodeAt(offset) >= 0x30 && serialized.charCodeAt(offset) <= 0x39);
    }
    if (
      rejectNonFiniteNumbers &&
      !Number.isFinite(Number(serialized.slice(numberStart, offset)))
    ) {
      fail();
    }
  }

  function readValue(depth: number): void {
    if (depth > maxDepth) fail();
    skipWhitespace();
    const character = serialized[offset];
    if (character === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (serialized[offset] === "}") {
        offset += 1;
        return;
      }
      for (;;) {
        const key = readString(true);
        objectKeys += 1;
        if (objectKeys > maxObjectKeys || key === undefined || keys.has(key)) fail();
        keys.add(key);
        skipWhitespace();
        if (serialized[offset] !== ":") fail();
        offset += 1;
        readValue(depth + 1);
        skipWhitespace();
        if (serialized[offset] === "}") {
          offset += 1;
          return;
        }
        if (serialized[offset] !== ",") fail();
        offset += 1;
        skipWhitespace();
      }
    }
    if (character === "[") {
      offset += 1;
      skipWhitespace();
      if (serialized[offset] === "]") {
        offset += 1;
        return;
      }
      for (;;) {
        readValue(depth + 1);
        skipWhitespace();
        if (serialized[offset] === "]") {
          offset += 1;
          return;
        }
        if (serialized[offset] !== ",") fail();
        offset += 1;
        skipWhitespace();
      }
    }
    if (character === '"') {
      readString(false);
      return;
    }
    if (character === "-" || (character !== undefined && character >= "0" && character <= "9")) {
      readNumber();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (serialized.startsWith(literal, offset)) {
        offset += literal.length;
        return;
      }
    }
    fail();
  }

  readValue(0);
  skipWhitespace();
  if (offset !== serialized.length) fail();
}
