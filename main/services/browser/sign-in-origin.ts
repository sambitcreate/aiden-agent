// The site a Bot asks the person to sign in to (plan §5.2): always a public
// `https://` origin, so the sign-in card names exactly what opens and a Bot
// can't point the person at a local service, an address that hides its host,
// or a page that carries a user name in its URL.

const SIGN_IN_ORIGIN_ERROR = "Use an https site name like github.com.";
const MAX_SITE_LENGTH = 2_048;

function refuse(): never {
  throw new Error(SIGN_IN_ORIGIN_ERROR);
}

/** `host:port`, which `new URL` would otherwise read as a scheme. */
function looksLikeHostAndPort(input: string): boolean {
  return /^[^/?#:@]+:\d+(?:[/?#]|$)/u.test(input);
}

/**
 * Normalize a site the Bot names (`github.com`, `https://github.com/login`)
 * to its `https://` origin. Refuses other schemes, user names or passwords in
 * the URL, IP addresses in any notation, `localhost` and `*.localhost`,
 * single-label hosts and any port but 443.
 */
export function normalizeSignInOrigin(site: string): string {
  if (typeof site !== "string") refuse();
  const input = site.trim();
  if (input.length === 0 || input.length > MAX_SITE_LENGTH) refuse();
  const explicit = input.includes("://") || (/^[a-z][a-z\d+.-]*:/iu.test(input) && !looksLikeHostAndPort(input));
  let url: URL;
  try {
    url = new URL(explicit ? input : `https://${input}`);
  } catch {
    refuse();
  }
  if (url.protocol !== "https:") refuse();
  if (url.username !== "" || url.password !== "") refuse();
  // `new URL` already dropped `:443` and rewrote every IPv4 spelling
  // (`2130706433`, `0x7f.1`, `0177.0.0.1`) to dotted decimal.
  if (url.port !== "") refuse();
  const host = url.hostname.replace(/\.$/u, "").toLowerCase();
  if (host.length === 0 || host.startsWith("[") || host.includes(":")) refuse();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) refuse();
  if (host === "localhost" || host.endsWith(".localhost")) refuse();
  if (!host.includes(".") || host.split(".").some((label) => label.length === 0)) refuse();
  return `https://${host}`;
}
