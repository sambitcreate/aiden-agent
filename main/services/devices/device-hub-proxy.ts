/**
 * Adapted from t3code apps/server/src/device/DeviceHubProxy.ts @ 1c127066 (MIT)
 *
 * The only way from the renderer to expo-device-hub. The hub binds loopback
 * and has unauthenticated routes, including serve-sim's shell-exec route, so
 * the renderer never learns its origin. This main-owned proxy also binds
 * loopback, requires a short-lived 256-bit grant token on every request and
 * upgrade (`<img>` and WebSocket cannot set headers, so it travels as `?t=`),
 * and forwards only the routes the Simulator tab needs.
 *
 * A `?host=` naming a paired Mac forwards to that Mac's Aiden Remote relay
 * (`aiden-remote-simulators.ts`) over pinned TLS. Main adds the bearer
 * credential; the renderer never sees it. The relay applies the same
 * allowlist through `decideDeviceHubRoute`.
 */
import { randomBytes } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";
import { LOCAL_DEVICE_HOST_ID, type DeviceStreamGrant } from "../../../renderer/shared/devices.js";

export const DEVICE_STREAM_GRANT_TTL_MS = 60_000;

/** Simulator UDIDs are UUIDs; anything else in the device segment is refused. */
const DEVICE = "[A-Za-z0-9-]+";

export const DEVICE_HUB_HTTP_PATHS: readonly RegExp[] = [
  /^\/api\/devices$/u,
  /^\/vendor\/serve-sim\/api$/u,
  /^\/vendor\/serve-sim\/api\/screenshot$/u,
  /^\/vendor\/serve-sim\/api\/event-log(\/events)?$/u,
  new RegExp(`^/vendor/serve-sim/helper/${DEVICE}/(stream\\.mjpeg|stream\\.avcc|config|health|ax|foreground)$`, "u"),
  new RegExp(`^/vendor/serve-sim/helper/${DEVICE}/panel/(1|3)/stream\\.avcc$`, "u"),
  /^\/vendor\/serve-sim\/appstate$/u,
];

/** Read routes are GET/HEAD only; screenshot capture is the one route that takes a body. */
export const DEVICE_HUB_MUTABLE_PATHS: readonly RegExp[] = [/^\/vendor\/serve-sim\/api\/screenshot$/u];

/** The hub's input socket route. It routes WebSockets by exact path, so the device travels as `?device=`. */
const HELPER_INPUT_SOCKET_PATH = "/vendor/serve-sim/helper/ws";
const DEVICE_ID_PATTERN = new RegExp(`^${DEVICE}$`, "u");
const HELPER_DEVICE_PATTERN = new RegExp(`^/vendor/serve-sim/helper/(${DEVICE})/`, "u");

/** The device list socket and the helper input socket. */
export const DEVICE_HUB_WS_PATHS: readonly RegExp[] = [
  /^\/api\/devices\/ws$/u,
  /^\/vendor\/serve-sim\/helper\/ws$/u,
];

/** Headers that must never reach the hub. WebSocket handshake headers are handled separately. */
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "cookie",
  "authorization",
  "dpop",
  "content-length",
  "accept-encoding",
  "aiden-protocol-version",
]);

const WS_HANDSHAKE_HEADERS = [
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
];

const DROPPED_RESPONSE_HEADERS = new Set(["content-encoding", "transfer-encoding", "connection", "keep-alive"]);

/** A paired Mac's simulator relay. Built in main from the pinned pairing; never sent to the renderer. */
export interface DeviceHubUpstream {
  /** `https://host[:port]` of the paired Mac's Aiden Remote endpoint. */
  origin: string;
  /** The relay prefix on that Mac, e.g. `/api/aiden/v1/simulators/hub`. */
  basePath: string;
  /** The bearer credential and protocol header. */
  headers: Record<string, string>;
  /** Pinned TLS options from `peerTlsOptions`. */
  tls: Pick<ConnectionOptions, "ca" | "rejectUnauthorized" | "checkServerIdentity">;
}

/** A loopback hub origin, or a paired Mac's relay. */
export type DeviceHubTarget = string | DeviceHubUpstream;

export interface DeviceHubProxyOptions {
  /** Where a host id's hub is, or null when that host is not running or not shared. */
  resolveHub(hostId: string): DeviceHubTarget | null | Promise<DeviceHubTarget | null>;
  /** Origins allowed to call the proxy: the packaged `file://` renderer and the dev server. */
  allowedOrigins: readonly string[];
  now?: () => number;
  grantTtlMs?: number;
}

export interface DeviceHubProxy {
  origin: string;
  mintGrant(): DeviceStreamGrant;
  close(): Promise<void>;
}

export type DeviceHubRoute =
  | {
      ok: true;
      /** Path and query to send to the hub. */
      upstreamPath: string;
      mutable: boolean;
      /** Simulator UDIDs the request names, in its path or its `device`/`udid` query. */
      deviceIds: string[];
    }
  | { ok: false; status: number; message: string };

function isAllowed(patterns: readonly RegExp[], pathname: string): boolean {
  return patterns.some((pattern) => pattern.test(pathname));
}

/**
 * The hub allowlist, shared by this proxy and the Aiden Remote relay. `rawPath`
 * is the undecoded path; `search` must already be free of the caller's own
 * parameters. serve-sim's exec route and anything unlisted are refused.
 */
export function decideDeviceHubRoute(input: {
  method: string;
  rawPath: string;
  search: URLSearchParams;
  upgrade: boolean;
}): DeviceHubRoute {
  const { rawPath, search, upgrade } = input;
  // Encoded separators and dot segments never reach the allowlist, so `..%2f` cannot slip through.
  if (!rawPath.startsWith("/") || rawPath.startsWith("//") || /[%\\?#]|\/\.\.?(\/|$)/u.test(rawPath)) {
    return { ok: false, status: 404, message: "Not Found" };
  }
  if (!isAllowed(upgrade ? DEVICE_HUB_WS_PATHS : DEVICE_HUB_HTTP_PATHS, rawPath)) {
    return { ok: false, status: 404, message: "Not Found" };
  }
  const queryDevice = search.get("device");
  if (rawPath === HELPER_INPUT_SOCKET_PATH && !DEVICE_ID_PATTERN.test(queryDevice ?? "")) {
    return { ok: false, status: 404, message: "Not Found" };
  }
  const mutable = isAllowed(DEVICE_HUB_MUTABLE_PATHS, rawPath);
  const method = input.method;
  const readOnly = method === "GET" || method === "HEAD";
  if (!upgrade && !readOnly && method !== "OPTIONS" && !(mutable && method === "POST")) {
    return { ok: false, status: 405, message: "Method Not Allowed" };
  }
  if (upgrade && method !== "GET") {
    return { ok: false, status: 405, message: "Method Not Allowed" };
  }
  const deviceIds: string[] = [];
  const helperDevice = HELPER_DEVICE_PATTERN.exec(rawPath)?.[1];
  if (helperDevice && helperDevice !== "ws") deviceIds.push(helperDevice);
  for (const name of ["device", "udid"]) {
    for (const value of search.getAll(name)) deviceIds.push(value);
  }
  const query = search.toString();
  return { ok: true, upstreamPath: query ? `${rawPath}?${query}` : rawPath, mutable, deviceIds };
}

/**
 * Request headers for the hub. Credentials, cookies, hop-by-hop headers and
 * the Aiden protocol header are dropped. serve-sim compares Origin with its
 * own origin on mutations, so a present Origin (or `forceOrigin`) becomes the
 * hub's.
 */
export function hubRequestHeaders(
  headers: IncomingHttpHeaders,
  hubOrigin: string,
  options: { forceOrigin?: boolean } = {},
): OutgoingHttpHeaders {
  const forwarded: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name) || name.startsWith("proxy-")) continue;
    forwarded[name] = value;
  }
  if (headers.origin !== undefined || options.forceOrigin) forwarded.origin = hubOrigin;
  forwarded.host = new URL(hubOrigin).host;
  return forwarded;
}

/** Hub response headers minus CORS, cookies and hop-by-hop headers. Streams are never cached. */
export function hubResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name)) continue;
    if (name.startsWith("access-control-") || name === "set-cookie") continue;
    result[name] = value;
  }
  // Long-lived MJPEG and AVCC responses must never be buffered or cached.
  result["cache-control"] = "no-store, no-transform";
  return result;
}

/** The raw HTTP/1.1 upgrade request for `path`, carrying the client's WebSocket handshake headers. */
export function upgradeRequestHead(
  path: string,
  headers: OutgoingHttpHeaders,
  incoming: IncomingHttpHeaders,
): string {
  const all: OutgoingHttpHeaders = { ...headers };
  for (const name of WS_HANDSHAKE_HEADERS) {
    const value = incoming[name];
    if (typeof value === "string") all[name] = value;
  }
  all.connection = "Upgrade";
  all.upgrade = "websocket";
  const lines = [`GET ${path} HTTP/1.1`];
  for (const [name, value] of Object.entries(all)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) lines.push(`${name}: ${String(item).replace(/[\r\n]/gu, "")}`);
    }
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/**
 * Pipes an accepted client upgrade to an upstream socket once it is ready.
 * Frames are opaque: H.264 access units one way, input packets the other.
 */
export function pipeUpgrade(input: {
  client: Duplex;
  upstream: Duplex;
  readyEvent: "connect" | "secureConnect";
  requestHead: string;
  head: Buffer;
  track?: Set<Duplex>;
}): void {
  const { client, upstream, track } = input;
  track?.add(client);
  track?.add(upstream);
  const teardown = () => {
    client.destroy();
    upstream.destroy();
    track?.delete(client);
    track?.delete(upstream);
  };
  client.once("error", teardown);
  client.once("close", teardown);
  upstream.once("error", teardown);
  upstream.once("close", teardown);
  upstream.once(input.readyEvent, () => {
    upstream.write(input.requestHead);
    if (input.head.length > 0) upstream.write(input.head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
}

export function refuseUpgrade(socket: Duplex, status: number, message: string): void {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function isUpstream(target: DeviceHubTarget): target is DeviceHubUpstream {
  return typeof target !== "string";
}

/** Headers for a paired Mac's relay: never the renderer's Origin, which Aiden Remote refuses. */
function upstreamHeaders(incoming: IncomingHttpHeaders, upstream: DeviceHubUpstream): OutgoingHttpHeaders {
  const headers = hubRequestHeaders(incoming, upstream.origin);
  delete headers.origin;
  return { ...headers, ...upstream.headers };
}

export async function startDeviceHubProxy(options: DeviceHubProxyOptions): Promise<DeviceHubProxy> {
  const now = options.now ?? Date.now;
  const ttl = options.grantTtlMs ?? DEVICE_STREAM_GRANT_TTL_MS;
  const grants = new Map<string, number>();
  const openSockets = new Set<Duplex>();
  let port = 0;

  const liveToken = (token: string | null): boolean => {
    const at = now();
    for (const [key, expiresAt] of grants) if (expiresAt <= at) grants.delete(key);
    return token !== null && grants.has(token);
  };

  const corsHeaders = (origin: string | undefined): Record<string, string> =>
    origin ? { "access-control-allow-origin": origin, vary: "Origin" } : { vary: "Origin" };

  type Decision =
    | { ok: true; hostId: string; upstreamPath: string; mutable: boolean }
    | { ok: false; status: number; message: string };

  function decide(request: IncomingMessage, upgrade: boolean): Decision {
    const rawUrl = request.url ?? "";
    if (request.headers.host !== `127.0.0.1:${port}`) {
      return { ok: false, status: 403, message: "Forbidden" };
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !options.allowedOrigins.includes(origin)) {
      return { ok: false, status: 403, message: "Forbidden" };
    }
    if (!rawUrl.startsWith("/") || rawUrl.startsWith("//")) {
      return { ok: false, status: 400, message: "Bad Request" };
    }
    const url = new URL(rawUrl, `http://127.0.0.1:${port}`);
    if (!liveToken(url.searchParams.get("t"))) {
      return { ok: false, status: 401, message: "Unauthorized" };
    }
    const rawPath = rawUrl.split("?", 1)[0];
    if (rawPath !== url.pathname) return { ok: false, status: 404, message: "Not Found" };
    const hostId = url.searchParams.get("host") || LOCAL_DEVICE_HOST_ID;
    // The grant and host selector authenticate here and must not travel on.
    url.searchParams.delete("t");
    url.searchParams.delete("host");
    const route = decideDeviceHubRoute({ method: request.method ?? "GET", rawPath, search: url.searchParams, upgrade });
    if (!route.ok) return route;
    return { ok: true, hostId, upstreamPath: route.upstreamPath, mutable: route.mutable };
  }

  async function resolve(hostId: string): Promise<DeviceHubTarget | null> {
    try {
      return await options.resolveHub(hostId);
    } catch {
      return null;
    }
  }

  function refuse(response: ServerResponse, request: IncomingMessage, status: number, message: string) {
    const origin = request.headers.origin;
    const allowed = origin !== undefined && options.allowedOrigins.includes(origin) ? origin : undefined;
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...corsHeaders(allowed) });
    response.end(message);
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse) {
    const decision = decide(request, false);
    if (!decision.ok) return refuse(response, request, decision.status, decision.message);
    const origin = request.headers.origin;
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        ...corsHeaders(origin),
        "access-control-allow-methods": decision.mutable ? "GET, HEAD, POST" : "GET, HEAD",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "0",
      });
      response.end();
      return;
    }
    const target = await resolve(decision.hostId);
    if (response.destroyed) return;
    if (!target) return refuse(response, request, 503, "Device hub is not running");
    const onResponse = (hubResponse: IncomingMessage) => {
      const headers = hubResponseHeaders(hubResponse.headers);
      Object.assign(headers, corsHeaders(origin));
      response.writeHead(hubResponse.statusCode ?? 502, headers);
      hubResponse.pipe(response);
      response.once("close", () => hubResponse.destroy());
    };
    const upstream = isUpstream(target)
      ? httpsRequest(
          `${target.origin}${target.basePath}${decision.upstreamPath}`,
          {
            method: request.method,
            headers: upstreamHeaders(request.headers, target),
            agent: false,
            ...target.tls,
          },
          onResponse,
        )
      : httpRequest(
          `${target}${decision.upstreamPath}`,
          { method: request.method, headers: hubRequestHeaders(request.headers, target) },
          onResponse,
        );
    upstream.once("error", () => {
      if (!response.headersSent) refuse(response, request, 502, "Bad Gateway");
      else response.destroy();
    });
    response.once("close", () => upstream.destroy());
    if (request.method === "POST") request.pipe(upstream);
    else upstream.end();
  }

  async function handleUpgrade(request: IncomingMessage, client: Duplex, head: Buffer) {
    if (request.headers.upgrade?.toLowerCase() !== "websocket") return refuseUpgrade(client, 400, "Bad Request");
    const decision = decide(request, true);
    if (!decision.ok) return refuseUpgrade(client, decision.status, decision.message);
    openSockets.add(client);
    const target = await resolve(decision.hostId);
    if (client.destroyed) return;
    if (!target) return refuseUpgrade(client, 503, "Device hub is not running");
    if (isUpstream(target)) {
      const url = new URL(target.origin);
      const hostname = url.hostname.replace(/^\[|\]$/gu, "");
      const upstream = tlsConnect({
        host: hostname,
        port: Number(url.port || 443),
        ...(isIP(hostname) ? {} : { servername: hostname }),
        ...target.tls,
      });
      pipeUpgrade({
        client,
        upstream,
        readyEvent: "secureConnect",
        requestHead: upgradeRequestHead(
          `${target.basePath}${decision.upstreamPath}`,
          upstreamHeaders(request.headers, target),
          request.headers,
        ),
        head,
        track: openSockets,
      });
      return;
    }
    const hub = new URL(target);
    const upstream: Socket = connect({ host: hub.hostname, port: Number(hub.port) });
    pipeUpgrade({
      client,
      upstream,
      readyEvent: "connect",
      requestHead: upgradeRequestHead(decision.upstreamPath, hubRequestHeaders(request.headers, target), request.headers),
      head,
      track: openSockets,
    });
  }

  const server = createServer((request, response) => void handleRequest(request, response));
  server.on("upgrade", (request, socket, head) => void handleUpgrade(request, socket, head));
  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    mintGrant() {
      const token = randomBytes(32).toString("base64url");
      const expiresAt = now() + ttl;
      grants.set(token, expiresAt);
      return { origin, token, expiresAt };
    },
    close: () =>
      new Promise<void>((resolveClose) => {
        grants.clear();
        for (const socket of openSockets) socket.destroy();
        openSockets.clear();
        server.close(() => resolveClose());
      }),
  };
}
