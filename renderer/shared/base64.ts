/** Canonical standard base64 character lookup and decoded byte-length validation. */

/** Decode one canonical base64 character code to its 6-bit value, or `undefined` if invalid. */
export function base64Value(code: number): number | undefined {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return undefined;
}

/**
 * Validate canonical standard base64 (non-empty, length multiple of 4, canonical
 * padding, zero trailing bits) and return its decoded byte length without
 * allocating slices or Buffers. Returns `undefined` when invalid or over `maxChars`.
 */
export function decodedBase64Bytes(value: string, maxChars?: number): number | undefined {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    (maxChars !== undefined && value.length > maxChars)
  ) {
    return undefined;
  }
  let padding = 0;
  if (value.endsWith("=")) padding += 1;
  if (value.endsWith("==")) padding += 1;
  const bodyEnd = value.length - padding;
  for (let index = 0; index < bodyEnd; index += 1) {
    if (base64Value(value.charCodeAt(index)) === undefined) return undefined;
  }
  for (let index = bodyEnd; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return undefined;
  }
  const finalValue = base64Value(value.charCodeAt(bodyEnd - 1));
  if (finalValue === undefined) return undefined;
  if ((padding === 2 && (finalValue & 15) !== 0) || (padding === 1 && (finalValue & 3) !== 0)) {
    return undefined;
  }
  return (value.length / 4) * 3 - padding;
}
