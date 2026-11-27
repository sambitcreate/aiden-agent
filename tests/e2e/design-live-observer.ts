// Observers for the live-frame E2E (design mode v2 Phase 3a, Task 14). Every
// way out of an app frame that the policy blocks is checked twice: the page
// sees the request fail, and the observer it was aimed at sees nothing. Each
// observer counts what reaches it; the spec asserts zero.

import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { networkInterfaces } from "node:os";

export type Counts = { connections: number; bytes: number };

export type TcpObserver = { host: string; port: number; counts: Counts; close(): Promise<void> };
export type UdpObserver = { port: number; datagrams: () => number; close(): Promise<void> };
export type HttpObserver = TcpObserver & { paths: string[] };

function listen(server: TcpServer | HttpServer, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve((server.address() as { port: number }).port));
  });
}

function closeServer(server: TcpServer | HttpServer): Promise<void> {
  return new Promise((resolve) => {
    (server as HttpServer).closeAllConnections?.();
    server.close(() => resolve());
  });
}

/** A raw TCP listener: TLS to it never completes, but any connection is counted. */
export async function startTcpObserver(host: string): Promise<TcpObserver> {
  const counts: Counts = { connections: 0, bytes: 0 };
  const sockets = new Set<import("node:net").Socket>();
  const server = createTcpServer((socket) => {
    counts.connections += 1;
    sockets.add(socket);
    socket.on("data", (chunk) => (counts.bytes += chunk.length));
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  });
  const port = await listen(server, host);
  return {
    host,
    port,
    counts,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
}

/** An HTTP listener that answers 200 to anything, counting connections, bytes and paths. */
export async function startHttpObserver(host: string): Promise<HttpObserver> {
  const counts: Counts = { connections: 0, bytes: 0 };
  const paths: string[] = [];
  const server = createHttpServer((request, response) => {
    paths.push(request.url ?? "");
    request.resume();
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.end("observer");
  });
  server.on("connection", (socket) => {
    counts.connections += 1;
    socket.on("data", (chunk) => (counts.bytes += chunk.length));
  });
  const port = await listen(server, host);
  return { host, port, counts, paths, close: () => closeServer(server) };
}

/** A UDP listener for QUIC and WebTransport attempts. */
export async function startUdpObserver(host: string): Promise<UdpObserver> {
  let datagrams = 0;
  const socket: UdpSocket = createSocket("udp4");
  socket.on("message", () => (datagrams += 1));
  const port = await new Promise<number>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, host, () => resolve(socket.address().port));
  });
  return { port, datagrams: () => datagrams, close: () => new Promise((resolve) => socket.close(() => resolve())) };
}

/** The machine's first non-internal IPv4 address, where external hosts are mapped. */
export function nonLoopbackAddress(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  throw new Error("The live-frame E2E needs a non-loopback IPv4 interface for its external-host observer; this machine has none.");
}

/** External hosts the probe aims at, all resolved to the observer. */
export const MAPPED_HOSTS = ["example.com", "www.youtube.com", "localhost.evil.test", "fonts.googleapis.com", "dns-prefetch.example.com"];

/** Chromium's test-only `--host-resolver-rules`, sending every mapped host to `address:port`. */
export function hostResolverRules(address: string, port: number): string {
  return `--host-resolver-rules=${MAPPED_HOSTS.map((host) => `MAP ${host} ${address}:${port}`).join(", ")}`;
}
