/** Bounded UTF-16 prefix that never separates a valid surrogate pair. */
export function boundedUnicodePrefix(value: string, maxCodeUnits: number): string {
  let end = Math.min(value.length, Math.max(0, maxCodeUnits));
  if (
    end > 0 &&
    end < value.length &&
    value.charCodeAt(end - 1) >= 0xd800 &&
    value.charCodeAt(end - 1) <= 0xdbff &&
    value.charCodeAt(end) >= 0xdc00 &&
    value.charCodeAt(end) <= 0xdfff
  ) {
    end += 1;
  }
  return value.slice(0, end);
}
