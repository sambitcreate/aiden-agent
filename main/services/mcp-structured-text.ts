/** Text blocks examined, and the longest text parsed, when looking for a serialized copy. */
const MAX_TEXT_PARTS = 64;
const MAX_TEXT_CHARS = 2_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_EQUALITY_NODES = 20_000;

/** Structural JSON equality with bounded work; any limit or cycle answers "not equal". */
function jsonEqual(left: unknown, right: unknown): boolean {
  let nodes = 0;
  const equal = (a: unknown, b: unknown, depth: number): boolean => {
    if (++nodes > MAX_EQUALITY_NODES || depth > 64) return false;
    if (a === b) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => equal(item, b[index], depth + 1));
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) &&
      equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], depth + 1));
  };
  return equal(left, right, 0);
}

/** Whether a text block already serializes `structured` (MCP: servers SHOULD send both). */
export function textCarriesStructured(content: unknown, structured: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.slice(0, MAX_TEXT_PARTS).some((part) => {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string" || part.text.length > MAX_TEXT_CHARS) return false;
    const text = part.text.trim();
    if (!text.startsWith("{") && !text.startsWith("[")) return false;
    try { return jsonEqual(JSON.parse(text), structured); } catch { return false; }
  });
}
