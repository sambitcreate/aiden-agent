/** Shared parsing helpers for web-search provider adapters. */

export { isRecord } from "../shared/guards.js";

/**
 * Accept a provider-supplied result URL only when it is a credential-free
 * http(s) URL. Control characters are rejected before parsing because the
 * WHATWG URL parser silently strips tabs and newlines, which would let a
 * hostile provider smuggle a different URL past the displayed value.
 */
export function normalizeWebSearchSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || /\p{Cc}/u.test(value)) return undefined;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}
