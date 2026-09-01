import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import * as http from "node:http";
import * as net from "node:net";
import type { Duplex } from "node:stream";
import { issueSourcePreviewTransportProof } from "./source-preview-transport-core.js";
import { attachSourcePreviewWebSocketProxy } from "./source-preview-websocket-proxy.js";

async function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve(address.port);
    });
  });
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function proof(port: number) {
  const value = issueSourcePreviewTransportProof({
    version: 1,
    sessionId: "preview_websocket_test_01",
    targetOrigin: `http://127.0.0.1:${port}`,
    resolvedAddresses: ["127.0.0.1"],
    allowedHttpPathPrefixes: ["/"],
    allowedWebSocketPathPrefixes: ["/hmr"],
    allowedHttpQueryKeys: [],
    allowedWebSocketQueryParameters: { token: "exact" },
    allowedWebSocketProtocols: ["vite-hmr"],
  });
  assert.ok(value);
  return value;
}

function acceptFor(key: string): string {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
    .digest("base64");
}

function rawUpgrade(
  port: number,
  overrides: { path?: string; origin?: string; headers?: string[] } = {},
): Promise<{ socket: net.Socket; response: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port, family: 4 });
    let response = "";
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(
        [
          `GET ${overrides.path ?? "/hmr?token=exact"} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          `Origin: ${overrides.origin ?? `http://127.0.0.1:${port}`}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Protocol: vite-hmr",
          ...(overrides.headers ?? []),
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (response.includes("\r\n\r\n")) resolve({ socket, response });
    });
  });
}

test("proxies one proof-bound loopback WebSocket and tears down upgraded sockets", async () => {
  let targetUpgrades = 0;
  let targetPort = 0;
  const targetSockets = new Set<Duplex>();
  const target = http.createServer();
  target.on("upgrade", (request, socket) => {
    targetUpgrades += 1;
    targetSockets.add(socket);
    socket.once("close", () => targetSockets.delete(socket));
    assert.equal(request.headers.host, `127.0.0.1:${targetPort}`);
    assert.equal(request.headers.origin, `http://127.0.0.1:${targetPort}`);
    assert.equal(request.headers.cookie, undefined);
    const key = request.headers["sec-websocket-key"];
    assert.equal(typeof key, "string");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        `Sec-WebSocket-Accept: ${acceptFor(key as string)}\r\n` +
        "Sec-WebSocket-Protocol: vite-hmr\r\n" +
        "Set-Cookie: upstream=forbidden\r\n" +
        "Location: http://example.test/escape\r\n\r\n",
    );
  });
  targetPort = await listen(target);
  const proxy = http.createServer((_request, response) => response.end("ok"));
  const proxyPort = await listen(proxy);
  const controller = attachSourcePreviewWebSocketProxy(proxy, {
    proof: proof(targetPort),
    proxyPort,
  });
  try {
    const upgraded = await rawUpgrade(proxyPort);
    assert.match(upgraded.response, /^HTTP\/1\.1 101/u);
    assert.doesNotMatch(upgraded.response, /set-cookie|location/iu);
    assert.equal(targetUpgrades, 1);
    assert.equal(controller.socketCount, 2);
    const clientClosed = once(upgraded.socket, "close");
    controller.close();
    await clientClosed;
    assert.equal(controller.socketCount, 0);
    assert.equal(upgraded.socket.destroyed, true);
  } finally {
    controller.close();
    for (const socket of targetSockets) socket.destroy();
    await close(proxy);
    await close(target);
  }
});

test("denies origin, credentials, protocol path, and token before opening the target", async () => {
  let targetUpgrades = 0;
  const target = http.createServer();
  target.on("upgrade", (_request, socket) => {
    targetUpgrades += 1;
    socket.destroy();
  });
  const targetPort = await listen(target);
  const proxy = http.createServer();
  const proxyPort = await listen(proxy);
  const denials: string[] = [];
  const controller = attachSourcePreviewWebSocketProxy(proxy, {
    proof: proof(targetPort),
    proxyPort,
    onDenied: (reason) => denials.push(reason),
  });
  try {
    for (const overrides of [
      { origin: "http://127.0.0.1:9999" },
      { headers: ["Cookie: secret=x"] },
      { path: "/admin?token=exact" },
      { path: "/hmr?token=attacker" },
    ]) {
      const result = await rawUpgrade(proxyPort, overrides);
      assert.match(result.response, /^HTTP\/1\.1 403/u);
      result.socket.destroy();
    }
    assert.equal(targetUpgrades, 0);
    assert.equal(denials.length, 4);
  } finally {
    controller.close();
    await close(proxy);
    await close(target);
  }
});

test("does not follow an upstream WebSocket redirect", async () => {
  const target = http.createServer();
  target.on("upgrade", (_request, socket) => {
    socket.end(
      "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/escape\r\nConnection: close\r\n\r\n",
    );
  });
  const targetPort = await listen(target);
  const proxy = http.createServer();
  const proxyPort = await listen(proxy);
  const controller = attachSourcePreviewWebSocketProxy(proxy, {
    proof: proof(targetPort),
    proxyPort,
  });
  try {
    const result = await rawUpgrade(proxyPort);
    assert.match(result.response, /^HTTP\/1\.1 502/u);
    result.socket.destroy();
  } finally {
    controller.close();
    await close(proxy);
    await close(target);
  }
});
