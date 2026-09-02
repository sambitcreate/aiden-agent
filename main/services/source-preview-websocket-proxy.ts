import type { Duplex } from "node:stream";
import { createHash } from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
import {
  authorizeSourcePreviewWebSocketUpgrade,
  type SourcePreviewTransportProofV1,
} from "./source-preview-transport-core.js";

const LOOPBACK_ADDRESS = "127.0.0.1";
const MAX_UPGRADE_HEADERS_BYTES = 16 * 1024;
const UPGRADE_TIMEOUT_MS = 10_000;
const SENSITIVE_REQUEST_HEADER =
  /^(?:authorization|cookie|proxy-authorization|x-api-key|x-auth-token)$/iu;

export interface SourcePreviewWebSocketProxy {
  readonly socketCount: number;
  close(): void;
}

export interface SourcePreviewWebSocketProxyOptions {
  proof: SourcePreviewTransportProofV1 | (() => SourcePreviewTransportProofV1);
  proxyPort: number;
  onDenied?: (reason: string) => void;
  connect?: typeof net.connect;
}

function commaTokens(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function rejectUpgrade(socket: Duplex, status: 400 | 403 | 502, reason: string): void {
  if (!socket.destroyed) {
    socket.end(
      `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : status === 502 ? "Bad Gateway" : "Bad Request"}\r\n` +
        "Connection: close\r\n" +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        `Content-Length: ${Buffer.byteLength(reason, "utf8")}\r\n\r\n${reason}`,
    );
  }
}

function headerValue(request: http.IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? undefined : value;
}

function protocolsFrom(request: http.IncomingMessage): string[] | undefined {
  const raw = headerValue(request, "sec-websocket-protocol");
  if (!raw) return [];
  const protocols = raw.split(",").map((entry) => entry.trim());
  return protocols.length <= 16 &&
    protocols.every(Boolean) &&
    new Set(protocols).size === protocols.length
    ? protocols
    : undefined;
}

function hasDuplicateAuthorityHeaders(request: http.IncomingMessage): boolean {
  const counts = new Map<string, number>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [
    "host",
    "origin",
    "upgrade",
    "connection",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
  ].some((name) => (counts.get(name) ?? 0) > 1);
}

function upstreamHeaders(
  request: http.IncomingMessage,
  proof: SourcePreviewTransportProofV1,
  protocols: readonly string[],
): Record<string, string> | undefined {
  const key = headerValue(request, "sec-websocket-key");
  const version = headerValue(request, "sec-websocket-version");
  if (!key || !version) return undefined;
  let decodedKey: Buffer;
  try {
    decodedKey = Buffer.from(key, "base64");
  } catch {
    return undefined;
  }
  if (decodedKey.length !== 16 || decodedKey.toString("base64") !== key) return undefined;
  const headers: Record<string, string> = {
    host: `${LOOPBACK_ADDRESS}:${proof.port}`,
    origin: proof.httpOrigin,
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-key": key,
    "sec-websocket-version": version,
  };
  const userAgent = headerValue(request, "user-agent");
  if (userAgent) headers["user-agent"] = userAgent;
  if (protocols.length > 0) headers["sec-websocket-protocol"] = protocols.join(", ");
  return headers;
}

function serializeUpgradeRequest(target: URL, headers: Readonly<Record<string, string>>): Buffer {
  const lines = [`GET ${target.pathname}${target.search} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "utf8");
}

function parseUpgradeResponse(
  bytes: Buffer,
  requestedProtocols: readonly string[],
  requestKey: string,
): { headerBytes: number; response: Buffer } | undefined {
  const boundary = bytes.indexOf("\r\n\r\n");
  if (boundary < 0) return undefined;
  const headerText = bytes.subarray(0, boundary).toString("latin1");
  const lines = headerText.split("\r\n");
  if (!/^HTTP\/1\.[01] 101(?:\s|$)/u.test(lines.shift() ?? "")) {
    throw new Error("The preview WebSocket upstream refused its approved upgrade.");
  }
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error("The preview WebSocket upstream returned invalid headers.");
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (headers.has(name) || /[\r\n\0]/u.test(value)) {
      throw new Error("The preview WebSocket upstream returned invalid headers.");
    }
    headers.set(name, value);
  }
  if (
    headers.get("upgrade")?.toLowerCase() !== "websocket" ||
    !commaTokens(headers.get("connection")).includes("upgrade") ||
    headers.has("sec-websocket-extensions")
  ) {
    throw new Error("The preview WebSocket upstream did not complete an upgrade.");
  }
  const expectedAccept = createHash("sha1")
    .update(`${requestKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
    .digest("base64");
  if (headers.get("sec-websocket-accept") !== expectedAccept) {
    throw new Error("The preview WebSocket upstream returned an invalid handshake proof.");
  }
  const acceptedProtocol = headers.get("sec-websocket-protocol");
  if (
    (requestedProtocols.length === 0 && acceptedProtocol !== undefined) ||
    (requestedProtocols.length > 0 &&
      (!acceptedProtocol || !requestedProtocols.includes(acceptedProtocol)))
  ) {
    throw new Error("The preview WebSocket upstream changed its approved protocol.");
  }
  const responseLines = [
    "HTTP/1.1 101 Switching Protocols",
    "Connection: Upgrade",
    "Upgrade: websocket",
    `Sec-WebSocket-Accept: ${expectedAccept}`,
    ...(acceptedProtocol ? [`Sec-WebSocket-Protocol: ${acceptedProtocol}`] : []),
    "",
    "",
  ];
  return {
    headerBytes: boundary + 4,
    response: Buffer.from(responseLines.join("\r\n"), "latin1"),
  };
}

/**
 * Attaches a contained, proof-bound WebSocket tunnel to one preview HTTP server.
 * The tunnel never follows redirects, performs DNS, forwards credentials, or
 * survives controller teardown.
 */
export function attachSourcePreviewWebSocketProxy(
  server: http.Server,
  options: SourcePreviewWebSocketProxyOptions,
): SourcePreviewWebSocketProxy {
  const sockets = new Set<Duplex>();
  let closed = false;
  const connect = options.connect ?? net.connect;
  const proxyOrigin = `http://${LOOPBACK_ADDRESS}:${options.proxyPort}`;

  const destroyPair = (left: Duplex, right?: Duplex): void => {
    sockets.delete(left);
    left.destroy();
    if (right) {
      sockets.delete(right);
      right.destroy();
    }
  };

  const onUpgrade = (request: http.IncomingMessage, client: Duplex, head: Buffer): void => {
    const deny = (reason: string, status: 400 | 403 | 502 = 403): void => {
      options.onDenied?.(reason);
      rejectUpgrade(client, status, reason);
    };
    if (closed || request.method !== "GET") return deny("Preview WebSocket upgrades are closed.");
    if (
      (client instanceof net.Socket && client.remoteAddress !== LOOPBACK_ADDRESS) ||
      hasDuplicateAuthorityHeaders(request) ||
      Object.keys(request.headers).some((name) => SENSITIVE_REQUEST_HEADER.test(name)) ||
      headerValue(request, "host") !== `${LOOPBACK_ADDRESS}:${options.proxyPort}` ||
      headerValue(request, "origin") !== proxyOrigin
    ) {
      return deny("Preview WebSocket credentials or origin are not approved.");
    }
    const proof = typeof options.proof === "function" ? options.proof() : options.proof;
    const protocols = protocolsFrom(request);
    const headers = protocols ? upstreamHeaders(request, proof, protocols) : undefined;
    let incomingUrl: URL;
    try {
      incomingUrl = new URL(request.url ?? "/", proxyOrigin);
    } catch {
      return deny("Preview WebSocket URL is invalid.", 400);
    }
    if (incomingUrl.origin !== proxyOrigin || !protocols || !headers) {
      return deny("Preview WebSocket upgrade is invalid.", 400);
    }
    const target = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, proof.webSocketOrigin);
    const authorization = authorizeSourcePreviewWebSocketUpgrade({
      proof,
      targetUrl: target.toString(),
      protocols,
      headers,
      resolvedAddresses: [LOOPBACK_ADDRESS],
    });
    if (!authorization.allowed) return deny(`Preview WebSocket denied: ${authorization.reason}.`);

    const upstream = connect({
      host: LOOPBACK_ADDRESS,
      port: proof.port,
      family: 4,
    });
    sockets.add(client);
    sockets.add(upstream);
    let responseBytes = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => destroyPair(client, upstream), UPGRADE_TIMEOUT_MS);
    timer.unref();
    const fail = (reason: string): void => {
      clearTimeout(timer);
      options.onDenied?.(reason);
      if (!client.destroyed && !upgraded) rejectUpgrade(client, 502, reason);
      destroyPair(client, upstream);
    };
    client.once("close", () => destroyPair(upstream));
    client.once("error", () => destroyPair(upstream));
    upstream.once("close", () => destroyPair(client));
    upstream.once("error", () => fail("The approved preview WebSocket target is unavailable."));
    upstream.once("connect", () => {
      upstream.write(serializeUpgradeRequest(target, headers));
    });
    const onHandshakeData = (chunk: Buffer): void => {
      responseBytes = Buffer.concat([responseBytes, chunk]);
      if (responseBytes.length > MAX_UPGRADE_HEADERS_BYTES) {
        fail("The preview WebSocket upstream returned oversized headers.");
        return;
      }
      let parsed: { headerBytes: number; response: Buffer } | undefined;
      try {
        parsed = parseUpgradeResponse(responseBytes, protocols, headers["sec-websocket-key"]);
      } catch (error) {
        fail(error instanceof Error ? error.message : "The preview WebSocket upgrade failed.");
        return;
      }
      if (!parsed) return;
      clearTimeout(timer);
      upgraded = true;
      upstream.off("data", onHandshakeData);
      client.write(parsed.response);
      const trailing = responseBytes.subarray(parsed.headerBytes);
      if (trailing.length > 0) client.write(trailing);
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    };
    upstream.on("data", onHandshakeData);
  };

  server.on("upgrade", onUpgrade);
  return {
    get socketCount() {
      return sockets.size;
    },
    close() {
      if (closed) return;
      closed = true;
      server.off("upgrade", onUpgrade);
      for (const socket of [...sockets]) socket.destroy();
      sockets.clear();
    },
  };
}
