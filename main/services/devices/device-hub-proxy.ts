/**
 * Adapted from t3code apps/server/src/device/DeviceHubProxy.ts @ 1c127066 (MIT)
 *
 * The only way from the renderer to expo-device-hub. The hub binds loopback
 * and has unauthenticated routes, including serve-sim's shell-exec route, so
 * the renderer never learns its origin. This main-owned proxy also binds
 * loopback, requires a short-lived 256-bit grant token on every request and
 * upgrade (`<img>` and WebSocket cannot set headers, so it travels as `?t=`),
 * and forwards only the routes the Simulator tab needs.
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
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
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
]);

const WS_HANDSHAKE_HEADERS = [
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
];

const DROPPED_RESPONSE_HEADERS = new Set(["content-encoding", "transfer-encoding", "connection", "keep-alive"]);

export interface DeviceHubProxyOptions {
  /** Loopback origin of the hub for a host id, or null when that host is not running. */
  resolveHub(hostId: string): string | null;
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

type RouteDecision =
  | { ok: true; hubOrigin: string; upstreamPath: string; mutable: boolean }
  | { ok: false; status: number; message: string };

function isAllowed(patterns: readonly RegExp[], pathname: string): boolean {
  return patterns.some((pattern) => pattern.test(pathname));
}

function forwardedHeaders(headers: IncomingHttpHeaders, hubOrigin: string): OutgoingHttpHeaders {
  const forwarded: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name) || name.startsWith("proxy-")) continue;
    forwarded[name] = value;
  }
  // serve-sim compares Origin with its own origin on mutations.
  if (headers.origin !== undefined) forwarded.origin = hubOrigin;
  forwarded.host = new URL(hubOrigin).host;
  return forwarded;
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

  function decide(request: IncomingMessage, upgrade: boolean): RouteDecision {
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
    // Encoded separators and dot segments never reach the allowlist, so `..%2f` cannot slip through.
    const rawPath = rawUrl.split("?", 1)[0];
    if (/[%\\]|\/\.\.?(\/|$)/u.test(rawPath) || rawPath !== url.pathname) {
      return { ok: false, status: 404, message: "Not Found" };
    }
    if (!isAllowed(upgrade ? DEVICE_HUB_WS_PATHS : DEVICE_HUB_HTTP_PATHS, url.pathname)) {
      return { ok: false, status: 404, message: "Not Found" };
    }
    if (url.pathname === HELPER_INPUT_SOCKET_PATH && !DEVICE_ID_PATTERN.test(url.searchParams.get("device") ?? "")) {
      return { ok: false, status: 404, message: "Not Found" };
    }
    const mutable = isAllowed(DEVICE_HUB_MUTABLE_PATHS, url.pathname);
    const method = request.method ?? "GET";
    const readOnly = method === "GET" || method === "HEAD";
    if (!upgrade && !readOnly && method !== "OPTIONS" && !(mutable && method === "POST")) {
      return { ok: false, status: 405, message: "Method Not Allowed" };
    }
    if (upgrade && method !== "GET") {
      return { ok: false, status: 405, message: "Method Not Allowed" };
    }
    const hostId = url.searchParams.get("host") || LOCAL_DEVICE_HOST_ID;
    const hubOrigin = options.resolveHub(hostId);
    if (!hubOrigin) return { ok: false, status: 503, message: "Device hub is not running" };
    // The grant and host selector authenticate here and must not travel on to the hub.
    url.searchParams.delete("t");
    url.searchParams.delete("host");
    return { ok: true, hubOrigin, upstreamPath: `${url.pathname}${url.search}`, mutable };
  }

  function refuse(response: ServerResponse, request: IncomingMessage, status: number, message: string) {
    const origin = request.headers.origin;
    const allowed = origin !== undefined && options.allowedOrigins.includes(origin) ? origin : undefined;
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...corsHeaders(allowed) });
    response.end(message);
  }

  function handleRequest(request: IncomingMessage, response: ServerResponse) {
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
    const upstream = httpRequest(
      `${decision.hubOrigin}${decision.upstreamPath}`,
      { method: request.method, headers: forwardedHeaders(request.headers, decision.hubOrigin) },
      (hubResponse) => {
        const headers: OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(hubResponse.headers)) {
          if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name)) continue;
          if (name.startsWith("access-control-") || name === "set-cookie") continue;
          headers[name] = value;
        }
        // Long-lived MJPEG and AVCC responses must never be buffered or cached.
        headers["cache-control"] = "no-store, no-transform";
        Object.assign(headers, corsHeaders(origin));
        response.writeHead(hubResponse.statusCode ?? 502, headers);
        hubResponse.pipe(response);
        response.once("close", () => hubResponse.destroy());
      },
    );
    upstream.once("error", () => {
      if (!response.headersSent) refuse(response, request, 502, "Bad Gateway");
      else response.destroy();
    });
    response.once("close", () => upstream.destroy());
    if (request.method === "POST") request.pipe(upstream);
    else upstream.end();
  }

  function refuseUpgrade(socket: Duplex, status: number, message: string) {
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  function handleUpgrade(request: IncomingMessage, client: Duplex, head: Buffer) {
    if (request.headers.upgrade?.toLowerCase() !== "websocket") return refuseUpgrade(client, 400, "Bad Request");
    const decision = decide(request, true);
    if (!decision.ok) return refuseUpgrade(client, decision.status, decision.message);
    const hub = new URL(decision.hubOrigin);
    const headers = forwardedHeaders(request.headers, decision.hubOrigin);
    for (const name of WS_HANDSHAKE_HEADERS) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";
    const lines = [`GET ${decision.upstreamPath} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined) lines.push(`${name}: ${String(item).replace(/[\r\n]/gu, "")}`);
      }
    }
    const upstream: Socket = connect({ host: hub.hostname, port: Number(hub.port) });
    openSockets.add(client);
    openSockets.add(upstream);
    const teardown = () => {
      client.destroy();
      upstream.destroy();
      openSockets.delete(client);
      openSockets.delete(upstream);
    };
    client.once("error", teardown);
    client.once("close", teardown);
    upstream.once("error", teardown);
    upstream.once("close", teardown);
    upstream.once("connect", () => {
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      // Frames are opaque: H.264 access units one way, input packets the other.
      upstream.pipe(client);
      client.pipe(upstream);
    });
  }

  const server = createServer(handleRequest);
  server.on("upgrade", handleUpgrade);
  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
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
      new Promise<void>((resolve) => {
        grants.clear();
        for (const socket of openSockets) socket.destroy();
        openSockets.clear();
        server.close(() => resolve());
      }),
  };
}
