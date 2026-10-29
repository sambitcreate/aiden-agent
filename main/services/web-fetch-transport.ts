/**
 * Public-page transport for `web_fetch`.
 *
 * Reads one public http(s) page for the agent. It refuses local, private,
 * link-local and other non-public addresses, including through DNS: the
 * address is checked when the socket connects, so a name that changes its
 * answer between check and use cannot reach the local network. Every
 * redirect is checked again. No cookies or credentials are sent, and the
 * body, time and redirect count are bounded.
 */

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { addAbortSignal, type Readable, type Transform } from "node:stream";

export const WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024;
export const WEB_FETCH_TIMEOUT_MS = 20_000;
export const WEB_FETCH_MAX_REDIRECTS = 5;
export const WEB_FETCH_MAX_URL_CHARS = 2_048;

export type WebFetchErrorKind =
  | "invalid-url"
  | "blocked-address"
  | "unsupported-content"
  | "http-status"
  | "too-many-redirects"
  | "timeout"
  | "network";

const MESSAGES: Readonly<Record<WebFetchErrorKind, string>> = {
  "invalid-url": "Only public http and https URLs without credentials can be read.",
  "blocked-address": "That address is on this computer or a private network; web_fetch reads public pages only.",
  "unsupported-content": "That URL is not a web page or text (for example a PDF or an image).",
  "http-status": "The site answered with an error.",
  "too-many-redirects": "The site redirected too many times.",
  timeout: "The site did not answer in time.",
  network: "The site could not be reached.",
};

export class WebFetchError extends Error {
  constructor(
    readonly kind: WebFetchErrorKind,
    readonly status?: number,
  ) {
    super(kind === "http-status" && status ? `The site answered with HTTP ${status}.` : MESSAGES[kind]);
    this.name = "WebFetchError";
  }
}

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

/** The IPv4 address inside an IPv4-mapped or -compatible IPv6 address. */
function embeddedIpv4(address: string): string | undefined {
  const lower = address.toLowerCase();
  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(lower);
  if (!hex) return undefined;
  const high = Number.parseInt(hex[1]!, 16);
  const low = Number.parseInt(hex[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** Whether an IP literal is a public unicast address. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6) return false;
  const mapped = embeddedIpv4(address);
  if (mapped !== undefined) return isPublicAddress(mapped);
  // Only global unicast (2000::/3) is public.
  if (!/^[23][0-9a-f]{0,3}:/iu.test(address)) return false;
  return !blocked.check(address, "ipv6");
}

export interface WebFetchOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Tests only: which resolved addresses may be reached. */
  readonly allowAddress?: (address: string) => boolean;
  /** Tests only: name resolution. */
  readonly lookup?: typeof dnsLookup;
}

export interface WebFetchResult {
  /** The final URL after redirects. */
  readonly url: string;
  readonly status: number;
  /** Lowercase media type without parameters, such as `text/html`. */
  readonly mediaType: string;
  readonly body: string;
  /** The body was longer than the byte limit and was cut. */
  readonly truncated: boolean;
}

const TEXT_TYPES = new Set([
  "text/html", "application/xhtml+xml", "text/plain", "text/markdown", "text/x-markdown",
  "text/csv", "application/json", "application/ld+json", "application/xml", "text/xml",
  "application/rss+xml", "application/atom+xml",
]);

export function isReadableMediaType(mediaType: string): boolean {
  return TEXT_TYPES.has(mediaType) || /^application\/[\w.-]+\+(?:json|xml)$/u.test(mediaType);
}

/** Parse and check a model-supplied URL. Bare hosts get https. */
export function normalizeWebFetchUrl(value: unknown): URL {
  if (typeof value !== "string") throw new WebFetchError("invalid-url");
  const input = value.trim();
  if (!input || input.length > WEB_FETCH_MAX_URL_CHARS) throw new WebFetchError("invalid-url");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//iu.test(input) ? input : `https://${input}`);
  } catch {
    throw new WebFetchError("invalid-url");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname) {
    throw new WebFetchError("invalid-url");
  }
  url.hash = "";
  return url;
}

function guardedLookup(allow: (address: string) => boolean, resolve: typeof dnsLookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, "", 0);
        return;
      }
      const list = addresses as unknown as LookupAddress[];
      // Every answer must be public: a mixed answer could still connect privately.
      if (list.length === 0 || !list.every(({ address }) => allow(address))) {
        callback(new WebFetchError("blocked-address") as NodeJS.ErrnoException, "", 0);
        return;
      }
      if (options.all) (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, list);
      else callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

function hostAddress(url: URL): string | undefined {
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  return isIP(host) ? host : undefined;
}

function decoderFor(contentType: string): TextDecoder {
  const charset = /charset\s*=\s*"?([\w.:-]+)"?/iu.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8");
  } catch {
    return new TextDecoder("utf-8");
  }
}

interface Hop {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly stream: http.IncomingMessage;
}

function request(url: URL, signal: AbortSignal, lookup: LookupFunction, accept: string): Promise<Hop> {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const outgoing = client.request(
      url,
      {
        method: "GET",
        lookup,
        agent: false,
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Aiden/1.0; +https://github.com/sambitcreate/aiden-agent)",
          Accept: accept,
          "Accept-Encoding": "gzip, deflate, br",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
      (response) => resolve({ status: response.statusCode ?? 0, headers: response.headers, stream: response }),
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function decompressorFor(encoding: string): Transform | undefined {
  if (encoding === "gzip" || encoding === "x-gzip") return createGunzip();
  if (encoding === "deflate") return createInflate();
  if (encoding === "br") return createBrotliDecompress();
  return undefined;
}

async function readBody(hop: Hop, maxBytes: number, signal: AbortSignal): Promise<{ bytes: Buffer; truncated: boolean }> {
  const encoding = String(hop.headers["content-encoding"] ?? "").trim().toLowerCase();
  const decompressor = decompressorFor(encoding);
  let stream: Readable = hop.stream;
  if (decompressor) {
    stream = hop.stream.pipe(decompressor);
    // pipe() forwards data only: a source that fails or closes early would
    // leave the decoder waiting for input that never comes.
    hop.stream.once("error", (error) => decompressor.destroy(error));
    hop.stream.once("close", () => {
      if (!hop.stream.readableEnded) decompressor.destroy(new Error("The connection closed before the page ended."));
    });
  }
  // A timeout or Stop ends the read even while no chunk is arriving.
  addAbortSignal(signal, stream);
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for await (const chunk of stream) {
      signal.throwIfAborted();
      const buffer = chunk as Buffer;
      if (total + buffer.length > maxBytes) {
        chunks.push(buffer.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(buffer);
      total += buffer.length;
    }
  } finally {
    hop.stream.destroy();
    if (stream !== hop.stream) stream.destroy();
  }
  return { bytes: Buffer.concat(chunks, total), truncated };
}

/** Shared socket-time address policy and bounded body reader. Callers choose a closed media policy. */
export async function fetchPublicBytes(
  target: URL,
  policy: { accept: string; readableMediaType: (mediaType: string) => boolean },
  options: WebFetchOptions = {},
): Promise<{ url: string; status: number; mediaType: string; contentType: string; bytes: Buffer; truncated: boolean }> {
  const allow = options.allowAddress ?? isPublicAddress;
  const lookup = guardedLookup(allow, options.lookup ?? dnsLookup);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? WEB_FETCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let url = normalizeWebFetchUrl(target.href);
  try {
    for (let redirects = 0; ; redirects++) {
      const literal = hostAddress(url);
      if (literal !== undefined && !allow(literal)) throw new WebFetchError("blocked-address");
      const hop = await request(url, signal, lookup, policy.accept);
      const location = hop.headers.location;
      if (hop.status >= 300 && hop.status < 400 && location) {
        hop.stream.destroy();
        if (redirects >= WEB_FETCH_MAX_REDIRECTS) throw new WebFetchError("too-many-redirects");
        try {
          url = normalizeWebFetchUrl(new URL(location, url).href);
        } catch {
          throw new WebFetchError("invalid-url");
        }
        continue;
      }
      if (hop.status < 200 || hop.status >= 300) {
        hop.stream.destroy();
        throw new WebFetchError("http-status", hop.status);
      }
      const contentType = String(hop.headers["content-type"] ?? "text/html");
      const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
      if (!policy.readableMediaType(mediaType)) {
        hop.stream.destroy();
        throw new WebFetchError("unsupported-content");
      }
      const { bytes, truncated } = await readBody(hop, options.maxBytes ?? WEB_FETCH_MAX_BYTES, signal);
      return { url: url.href, status: hop.status, mediaType, contentType, bytes, truncated };
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof WebFetchError) throw error;
    if (timeout.aborted) throw new WebFetchError("timeout");
    // The guarded lookup reports a blocked answer through the socket error.
    if (error instanceof Error && error.message === MESSAGES["blocked-address"]) {
      throw new WebFetchError("blocked-address");
    }
    throw new WebFetchError("network");
  }
}

/** Fetch one public page as text. */
export async function fetchPublicPage(target: URL, options: WebFetchOptions = {}): Promise<WebFetchResult> {
  const { bytes, contentType, ...result } = await fetchPublicBytes(target, {
    accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5",
    readableMediaType: isReadableMediaType,
  }, options);
  return { ...result, body: decoderFor(contentType).decode(bytes) };
}
