// The live-frame network policy (design mode v2 Phase 3a, D3, D4, D7, S3,
// S15, S57). Pure: the design subscriber in `app-network-main.ts` feeds it
// Electron's request details through `AppFrameRef`s and the registry.
//
// In app context only loopback `http:`/`ws:` (not Aiden's own ports),
// `data:`, `about:blank`/`about:srcdoc` and loopback `blob:` pass; everything
// else is cancelled. Requests outside app context are untouched, so the main
// window, its file and generative-UI frames and every other window behave as
// before. Every unknown cancels.

/** The parts of a frame the policy reads. Any read may throw (a destroyed frame). */
export type AppFrameRef = {
  readonly frameTreeNodeId: number;
  readonly parent: AppFrameRef | null;
  readonly url: string;
  readonly origin: string;
  /** Whether this is the main window's main frame. */
  readonly isMainFrame: boolean;
};

export type AppRequest = {
  url: string;
  frame: AppFrameRef | null;
  initiatorOrigin?: string;
  webContentsId?: number;
  /** The request's web contents is the current main window's. */
  inMainWindow: boolean;
};

export type AppContextKind = "registered" | "backstop";

export type AppPolicyContext = {
  appContext(frame: AppFrameRef | null, inMainWindow: boolean): AppContextKind | null;
  isAppOrigin(origin: string): boolean;
  isExportContents(webContentsId: number): boolean;
  /** `"file://"` in packaged builds, or the dev origin `http://127.0.0.1:4143`. */
  rendererOrigin: string;
  ownPorts: ReadonlySet<number>;
  /** Audited URL prefixes for initiator-less frameless requests (D4). */
  frameless: readonly string[];
  /** The 1 s cancel-only cache (D3). */
  cache?: AppCancelCache;
};

export type AppVerdict = "allow" | "cancel" | "untouched";

/** Why a request got its verdict, for blocked counts and the frameless log. */
export type AppDecision = {
  verdict: AppVerdict;
  /** What the request belonged to when it was decided under the app rule. */
  context: "registered" | "backstop" | "export" | "frameless-app" | "frameless-unknown" | null;
  /** `host` for http(s)/ws(s), else the scheme; never a path or query. */
  target: string;
  /** The cancel came from the cache. */
  cached?: boolean;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function portOf(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80;
}

function loopbackParsed(url: URL, ownPorts: ReadonlySet<number>): boolean {
  if (url.protocol !== "http:" && url.protocol !== "ws:") return false;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
  return !ownPorts.has(portOf(url));
}

/**
 * Loopback for an app frame: a WHATWG-parsed `http:` or `ws:` URL whose host
 * is exactly `localhost`, `127.0.0.1` or `[::1]`, on a port that isn't Aiden's.
 */
export function isAppLoopback(url: string, ownPorts: ReadonlySet<number>): boolean {
  const parsed = parse(url);
  return parsed !== null && loopbackParsed(parsed, ownPorts);
}

/** A loopback `http:` origin (any port), as a frame's committed origin or an initiator reads. */
export function isLoopbackHttpOrigin(origin: string): boolean {
  const parsed = parse(origin);
  return parsed !== null && parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
}

function targetOf(parsed: URL | null, raw: string): string {
  if (!parsed) {
    const colon = raw.indexOf(":");
    return colon > 0 && colon < 32 ? raw.slice(0, colon).toLowerCase() : "unknown";
  }
  if (NETWORK_SCHEMES.has(parsed.protocol)) return parsed.hostname || parsed.protocol.slice(0, -1);
  return parsed.protocol.slice(0, -1);
}

/** The app rule: what an app-context request may load. */
function appRule(parsed: URL | null, ownPorts: ReadonlySet<number>): "allow" | "cancel" {
  if (!parsed) return "cancel";
  switch (parsed.protocol) {
    case "data:":
      return "allow";
    case "about:":
      return parsed.href === "about:blank" || parsed.href === "about:srcdoc" ? "allow" : "cancel";
    case "blob:": {
      const inner = parse(parsed.pathname);
      return inner !== null && inner.protocol === "http:" && loopbackParsed(inner, ownPorts) ? "allow" : "cancel";
    }
    default:
      return loopbackParsed(parsed, ownPorts) ? "allow" : "cancel";
  }
}

function cacheKey(scope: string, parsed: URL | null): string | null {
  if (!parsed) return null;
  return `${scope}|${parsed.protocol}|${parsed.hostname}|${parsed.port}`;
}

function frameIdOf(frame: AppFrameRef): number | null {
  try {
    const id = frame.frameTreeNodeId;
    return typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

/** Every detail of the decision; `appRequestVerdict` is its verdict. */
export function decideAppRequest(request: AppRequest, context: AppPolicyContext): AppDecision {
  const parsed = parse(request.url);
  const target = targetOf(parsed, request.url);
  try {
    // Export windows: everything in them is app context (D18).
    if (typeof request.webContentsId === "number" && context.isExportContents(request.webContentsId)) {
      const key = cacheKey(`c${request.webContentsId}`, parsed);
      if (key && context.cache?.has(key)) return { verdict: "cancel", context: "export", target, cached: true };
      const verdict = appRule(parsed, context.ownPorts);
      if (verdict === "cancel" && key) context.cache?.add(key);
      return { verdict, context: "export", target };
    }

    if (request.frame) {
      const id = frameIdOf(request.frame);
      const key = id === null ? null : cacheKey(`f${id}`, parsed);
      if (key && context.cache?.has(key)) return { verdict: "cancel", context: "registered", target, cached: true };
      const kind = context.appContext(request.frame, request.inMainWindow);
      if (!kind) return { verdict: "untouched", context: null, target };
      const verdict = appRule(parsed, context.ownPorts);
      if (verdict === "cancel" && key) context.cache?.add(key);
      return { verdict, context: kind, target };
    }

    // Frameless (D4).
    if (!parsed || !NETWORK_SCHEMES.has(parsed.protocol)) {
      // Not network (N11). An unparsable URL with an app initiator still cancels.
      if (!parsed && request.initiatorOrigin !== undefined && request.initiatorOrigin !== context.rendererOrigin) {
        return { verdict: "cancel", context: "frameless-app", target };
      }
      return { verdict: "untouched", context: null, target };
    }
    const initiator = request.initiatorOrigin;
    if (initiator !== undefined && initiator !== "") {
      if (initiator === context.rendererOrigin) return { verdict: "untouched", context: null, target };
      if (initiator === "null" || context.isAppOrigin(initiator) || isLoopbackHttpOrigin(initiator)) {
        return { verdict: appRule(parsed, context.ownPorts), context: "frameless-app", target };
      }
      return { verdict: "untouched", context: null, target };
    }
    if (LOOPBACK_HOSTS.has(parsed.hostname)) return { verdict: "untouched", context: null, target };
    if (context.frameless.some((prefix) => request.url.startsWith(prefix))) {
      return { verdict: "untouched", context: null, target };
    }
    return { verdict: "cancel", context: "frameless-unknown", target };
  } catch {
    // A throwing read: cancel when the request could be app context.
    const couldBeApp =
      request.inMainWindow ||
      request.frame !== null ||
      (request.initiatorOrigin !== undefined && request.initiatorOrigin !== context.rendererOrigin);
    return { verdict: couldBeApp ? "cancel" : "untouched", context: couldBeApp ? "backstop" : null, target };
  }
}

export function appRequestVerdict(request: AppRequest, context: AppPolicyContext): AppVerdict {
  return decideAppRequest(request, context).verdict;
}

/**
 * Cancel verdicts only, for one second, keyed by frame (or export contents),
 * scheme, host and port. A buggy app retrying a cancelled host in a tight loop
 * then costs one URL parse per request. Caching only cancels keeps it fail-closed.
 */
export class AppCancelCache {
  private readonly entries = new Map<string, number>();
  private readonly ttl: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(options: { now?: () => number; ttlMs?: number; max?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.ttl = options.ttlMs ?? 1000;
    this.max = options.max ?? 4096;
  }

  has(key: string): boolean {
    const at = this.entries.get(key);
    if (at === undefined) return false;
    if (this.now() - at >= this.ttl) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  add(key: string): void {
    if (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.delete(key);
    this.entries.set(key, this.now());
  }
}

// ---- Response headers (D7) --------------------------------------------------

/** The added `connect-src` for app-context documents and workers (S71). */
export const APP_CONNECT_SRC =
  "connect-src 'self' http://localhost:* http://127.0.0.1:* http://[::1]:* ws://localhost:* ws://127.0.0.1:* ws://[::1]:* data: blob:";
/** The export window's top-level sandbox (D18). */
export const APP_EXPORT_SANDBOX_CSP = "sandbox allow-scripts allow-same-origin allow-forms";

const REPORTING_HEADERS = new Set(["report-to", "nel", "reporting-endpoints"]);
const DOCUMENT_TYPES = new Set(["mainFrame", "subFrame", "script", "other"]);

/** A `Set-Cookie` value with `SameSite=None` and `Secure`, everything else kept (S4). */
export function appSetCookie(value: string): string {
  const parts = value.split(";").map((part) => part.trim());
  const [pair = "", ...attributes] = parts;
  const kept = attributes.filter((attribute) => attribute !== "" && !/^samesite(?:\s*=|$)/iu.test(attribute));
  const secure = kept.some((attribute) => /^secure$/iu.test(attribute));
  return [pair, ...kept, "SameSite=None", ...(secure ? [] : ["Secure"])].join("; ");
}

function withoutFrameAncestors(value: string): string {
  return value
    .split(",")
    .map((policy) =>
      policy
        .split(";")
        .map((directive) => directive.trim())
        .filter((directive) => directive !== "" && directive.split(/\s+/u)[0]!.toLowerCase() !== "frame-ancestors")
        .join("; "),
    )
    .filter((policy) => policy !== "")
    .join(", ");
}

/**
 * The response headers an app-context response gets (D7). The caller decides
 * app context; `appOrigin` says the response came from an app origin.
 */
export function appResponseHeaders(
  headers: Record<string, string[]>,
  kind: { appOrigin: boolean; resourceType: string; exportMainFrame: boolean },
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const document = DOCUMENT_TYPES.has(kind.resourceType) || kind.exportMainFrame;
  let cspKey: string | null = null;
  for (const [name, values] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (REPORTING_HEADERS.has(lower)) continue;
    if (document && lower === "x-dns-prefetch-control") continue;
    if (kind.appOrigin && lower === "x-frame-options") continue;
    if (lower === "content-security-policy") {
      cspKey = name;
      const kept = kind.appOrigin ? values.map(withoutFrameAncestors).filter((value) => value !== "") : [...values];
      if (kept.length > 0) out[name] = kept;
      continue;
    }
    if (kind.appOrigin && lower === "set-cookie") {
      out[name] = values.map(appSetCookie);
      continue;
    }
    out[name] = values;
  }
  const added: string[] = [];
  if (document) added.push(APP_CONNECT_SRC);
  if (kind.exportMainFrame) added.push(APP_EXPORT_SANDBOX_CSP);
  if (added.length > 0) {
    const key = cspKey ?? "Content-Security-Policy";
    out[key] = [...(out[key] ?? []), ...added];
  }
  if (document) out["X-DNS-Prefetch-Control"] = ["off"];
  return out;
}
