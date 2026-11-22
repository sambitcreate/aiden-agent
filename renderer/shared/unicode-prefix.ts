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

/**
 * `value` itself when it fits in `maxCodeUnits`, otherwise cut and ended with
 * `ellipsis` so the whole is at most `maxCodeUnits` long. The cut never
 * separates a surrogate pair: it falls before the pair instead.
 */
export function clippedUnicode(value: string, maxCodeUnits: number, ellipsis = "…"): string {
  if (value.length <= maxCodeUnits) return value;
  let end = Math.max(0, maxCodeUnits - ellipsis.length);
  const high = value.charCodeAt(end - 1);
  const low = value.charCodeAt(end);
  if (end > 0 && high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) end -= 1;
  return `${value.slice(0, end)}${ellipsis}`;
}
