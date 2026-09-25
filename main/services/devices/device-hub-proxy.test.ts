import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { Socket } from "node:net";
import test from "node:test";
import { loadOrCreateAidenRemoteTlsIdentity } from "../aiden-remote-tls-identity.js";
import { peerTlsOptions } from "../peer-transport.js";
import { startDeviceHubProxy, type DeviceHubProxy, type DeviceHubUpstream } from "./device-hub-proxy.js";

const UDID = "5C1E4B7A-0000-4000-8000-000000000001";

interface HubRecord {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
  upgrade: boolean;
}

interface FakeHub {
  origin: string;
  records: HubRecord[];
  upgradeSockets: Socket[];
  received: Buffer[];
  server: Server;
}

async function startFakeHub(): Promise<FakeHub> {
  const records: HubRecord[] = [];
  const upgradeSockets: Socket[] = [];
  const received: Buffer[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      records.push({ method: request.method!, url: request.url!, headers: request.headers, body, upgrade: false });
      response.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "hub=1",
        "access-control-allow-origin": "*",
        "cache-control": "max-age=600",
      });
      response.end(JSON.stringify({ ok: true, url: request.url }));
    });
  });
  server.on("upgrade", (request, socket: Socket) => {
    records.push({ method: request.method!, url: request.url!, headers: request.headers, body: "", upgrade: true });
    upgradeSockets.push(socket);
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const message = Buffer.from(`hub:${request.url}`);
    socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]));
    socket.on("data", (chunk) => received.push(chunk));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { origin: `http://127.0.0.1:${port}`, records, upgradeSockets, received, server };
}

interface Harness {
  hub: FakeHub;
  proxy: DeviceHubProxy;
  clock: { now: number };
  hubRunning: { value: boolean };
}

async function withProxy(run: (harness: Harness) => Promise<void>) {
  const hub = await startFakeHub();
  const clock = { now: 1_000_000 };
  const hubRunning = { value: true };
  const proxy = await startDeviceHubProxy({
    resolveHub: (hostId) => (hostId === "local" && hubRunning.value ? hub.origin : null),
    allowedOrigins: ["file://", "http://localhost:5173"],
    now: () => clock.now,
  });
  try {
    await run({ hub, proxy, clock, hubRunning });
  } finally {
    await proxy.close();
    for (const socket of hub.upgradeSockets) socket.destroy();
    hub.server.closeAllConnections();
    await new Promise((resolve) => hub.server.close(resolve));
  }
}

interface ProxyResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function send(
  proxy: DeviceHubProxy,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${proxy.origin}${path}`,
      { method: options.method ?? "GET", headers: options.headers ?? {} },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body }));
      },
    );
    request.once("error", reject);
    request.end(options.body);
  });
}

function upgrade(
  proxy: DeviceHubProxy,
  path: string,
  headers: Record<string, string> = { origin: "file://" },
): Promise<{ status: number; socket?: Socket; firstFrame?: Promise<string> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${proxy.origin}${path}`, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        ...headers,
      },
    });
    request.once("upgrade", (response, socket: Socket, head: Buffer) => {
      // The hub's first frame can arrive in the same packet as the 101 response.
      const decode = (chunk: Buffer) => chunk.subarray(2, 2 + chunk[1]).toString();
      const firstFrame =
        head.length > 0
          ? Promise.resolve(decode(head))
          : new Promise<string>((frameResolve) => {
              socket.once("data", (chunk: Buffer) => frameResolve(decode(chunk)));
            });
      resolve({ status: response.statusCode!, socket, firstFrame });
    });
    request.once("response", (response) => {
      response.resume();
      resolve({ status: response.statusCode! });
    });
    request.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolve({ status: 0 });
      else reject(error);
    });
    request.end();
  });
}

test("grants are 256-bit loopback tokens that rotate per mint", async () => {
  await withProxy(async ({ proxy, clock }) => {
    assert.match(proxy.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
    const first = proxy.mintGrant();
    const second = proxy.mintGrant();
    assert.equal(first.origin, proxy.origin);
    assert.match(first.token, /^[A-Za-z0-9_-]{43}$/u);
    assert.notEqual(first.token, second.token);
    assert.equal(first.expiresAt, clock.now + 60_000);
  });
});

test("missing, wrong, and expired tokens are refused before reaching the hub", async () => {
  await withProxy(async ({ proxy, hub, clock }) => {
    assert.equal((await send(proxy, "/api/devices")).status, 401);
    assert.equal((await send(proxy, `/api/devices?t=${"x".repeat(43)}`)).status, 401);
    const grant = proxy.mintGrant();
    assert.equal((await send(proxy, `/api/devices?t=${grant.token}`)).status, 200);
    clock.now = grant.expiresAt;
    assert.equal((await send(proxy, `/api/devices?t=${grant.token}`)).status, 401);
    assert.equal((await upgrade(proxy, `/api/devices/ws?t=${grant.token}`)).status, 401);
    assert.equal(hub.records.length, 1);
  });
});

test("only allowlisted routes reach the hub, and never exec, tools, or traversal", async () => {
  await withProxy(async ({ proxy, hub }) => {
    const { token } = proxy.mintGrant();
    for (const path of [
      "/vendor/serve-sim/api/exec",
      "/vendor/serve-sim/api/tools",
      "/vendor/serve-sim/api/tools/run",
      "/vendor/serve-sim/grid/api/start",
      "/vendor/serve-sim/helper/..%2f..%2fapi%2fexec/config",
      "/vendor/serve-sim/helper/%252e%252e/config",
      `/vendor/serve-sim/helper/${UDID}/../../api/exec`,
      "/vendor/serve-sim/helper/./config",
      "/vendor/serve-sim/helper/a\\b/config",
      "/vendor/serve-sim/helper/a.b/config",
      "/api/devices/",
      "/api/devices/boot",
      "/",
      "/vendor/serve-emu/api/devices",
    ]) {
      const response = await send(proxy, `${path}?t=${token}`);
      assert.equal(response.status, 404, path);
    }
    assert.equal(hub.records.length, 0);

    for (const path of [
      "/api/devices",
      "/vendor/serve-sim/api",
      "/vendor/serve-sim/api/event-log",
      "/vendor/serve-sim/api/event-log/events",
      `/vendor/serve-sim/helper/${UDID}/stream.mjpeg`,
      `/vendor/serve-sim/helper/${UDID}/stream.avcc`,
      `/vendor/serve-sim/helper/${UDID}/config`,
      `/vendor/serve-sim/helper/${UDID}/panel/3/stream.avcc`,
      "/vendor/serve-sim/appstate",
    ]) {
      assert.equal((await send(proxy, `${path}?t=${token}`)).status, 200, path);
    }
  });
});

test("only screenshot capture accepts POST, and read routes answer 405", async () => {
  await withProxy(async ({ proxy, hub }) => {
    const { token } = proxy.mintGrant();
    assert.equal((await send(proxy, `/api/devices?t=${token}`, { method: "POST" })).status, 405);
    assert.equal((await send(proxy, `/api/devices?t=${token}`, { method: "DELETE" })).status, 405);
    assert.equal(hub.records.length, 0);
    const response = await send(proxy, `/vendor/serve-sim/api/screenshot?t=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "file://" },
      body: JSON.stringify({ udid: UDID }),
    });
    assert.equal(response.status, 200);
    assert.equal(hub.records[0].method, "POST");
    assert.equal(hub.records[0].body, JSON.stringify({ udid: UDID }));
  });
});

test("the grant and host selector are stripped and credentials never cross", async () => {
  await withProxy(async ({ proxy, hub }) => {
    const { token } = proxy.mintGrant();
    const response = await send(proxy, `/vendor/serve-sim/api/event-log?since=4&t=${token}&host=local`, {
      headers: {
        origin: "file://",
        cookie: "session=secret",
        authorization: "Bearer secret",
        "accept-encoding": "gzip",
      },
    });
    assert.equal(response.status, 200);
    const [record] = hub.records;
    assert.equal(record.url, "/vendor/serve-sim/api/event-log?since=4");
    assert.equal(record.headers.cookie, undefined);
    assert.equal(record.headers.authorization, undefined);
    assert.equal(record.headers["accept-encoding"], undefined);
    assert.equal(record.headers.origin, hub.origin);
    assert.equal(record.headers.host, new URL(hub.origin).host);
    assert.equal(response.headers["cache-control"], "no-store, no-transform");
    assert.equal(response.headers["set-cookie"], undefined);
    assert.equal(response.headers["access-control-allow-origin"], "file://");
    assert.doesNotMatch(response.body, new RegExp(token, "u"));
  });
});

test("foreign origins and rebinding hosts are refused, and preflight is scoped", async () => {
  await withProxy(async ({ proxy, hub }) => {
    const { token } = proxy.mintGrant();
    assert.equal((await send(proxy, `/api/devices?t=${token}`, { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await send(proxy, `/api/devices?t=${token}`, { headers: { origin: "null" } })).status, 403);
    assert.equal((await send(proxy, `/api/devices?t=${token}`, { headers: { host: "evil.example" } })).status, 403);
    assert.equal(
      (await upgrade(proxy, `/api/devices/ws?t=${token}`, { origin: "https://evil.example" })).status,
      403,
    );
    assert.equal(hub.records.length, 0);

    const devServer = await send(proxy, `/api/devices?t=${token}`, { headers: { origin: "http://localhost:5173" } });
    assert.equal(devServer.status, 200);
    const preflight = await send(proxy, `/vendor/serve-sim/api/screenshot?t=${token}`, {
      method: "OPTIONS",
      headers: { origin: "file://", "access-control-request-method": "POST" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], "file://");
    assert.equal(preflight.headers["access-control-allow-methods"], "GET, HEAD, POST");
    const readPreflight = await send(proxy, `/api/devices?t=${token}`, {
      method: "OPTIONS",
      headers: { origin: "file://" },
    });
    assert.equal(readPreflight.headers["access-control-allow-methods"], "GET, HEAD");
    assert.equal(hub.records.length, 1);
  });
});

test("a stopped hub answers 503", async () => {
  await withProxy(async ({ proxy, hubRunning }) => {
    const { token } = proxy.mintGrant();
    hubRunning.value = false;
    assert.equal((await send(proxy, `/api/devices?t=${token}`)).status, 503);
    assert.equal((await send(proxy, `/api/devices?t=${token}&host=remote`)).status, 503);
  });
});

test("allowlisted WebSocket upgrades are piped end to end", async () => {
  await withProxy(async ({ proxy, hub }) => {
    const { token } = proxy.mintGrant();
    const connection = await upgrade(proxy, `/vendor/serve-sim/helper/ws?device=${UDID}&t=${token}&host=local`);
    assert.equal(connection.status, 101);
    assert.equal(await connection.firstFrame, `hub:/vendor/serve-sim/helper/ws?device=${UDID}`);
    const [record] = hub.records;
    assert.equal(record.upgrade, true);
    assert.equal(record.headers["sec-websocket-key"], "dGhlIHNhbXBsZSBub25jZQ==");
    assert.equal(record.headers.origin, hub.origin);
    connection.socket!.write(Buffer.from([0x82, 0x80, 1, 2, 3, 4]));
    for (let attempt = 0; attempt < 50 && hub.received.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(Buffer.concat(hub.received), Buffer.from([0x82, 0x80, 1, 2, 3, 4]));
    connection.socket!.destroy();

    const list = await upgrade(proxy, `/api/devices/ws?t=${token}`);
    assert.equal(list.status, 101);
    list.socket!.destroy();
  });
});

test("WebSocket upgrades on other paths are refused without reaching the hub", async () => {
  await withProxy(async ({ proxy, hub }) => {
    const { token } = proxy.mintGrant();
    for (const path of [
      // The hub never routes the per-device socket path serve-sim's config reports.
      `/vendor/serve-sim/helper/${UDID}/ws`,
      "/vendor/serve-sim/api/exec",
      "/vendor/serve-sim/exec/ws",
      "/api/devices",
      `/vendor/serve-sim/helper/${UDID}/stream.avcc`,
    ]) {
      const result = await upgrade(proxy, `${path}?t=${token}`);
      assert.ok(result.status === 404 || result.status === 0, path);
    }
    // The input socket needs one well-formed device id.
    for (const query of ["", "device=", "device=..%2Fexec", "device=a%20b", "device=a/b"]) {
      const result = await upgrade(proxy, `/vendor/serve-sim/helper/ws?${query}&t=${token}`);
      assert.ok(result.status === 404 || result.status === 0, query);
    }
    assert.equal(hub.records.length, 0);
  });
});

test("a paired Mac's hub is reached over pinned TLS with main's credential, never the renderer's parameters", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-hub-upstream-"));
  const identity = await loadOrCreateAidenRemoteTlsIdentity({ directory });
  const records: HubRecord[] = [];
  const relay = createHttpsServer({ key: identity.privateKey, cert: identity.certificateChain }, (request, response) => {
    records.push({ method: request.method!, url: request.url!, headers: request.headers, body: "", upgrade: false });
    request.resume();
    response.writeHead(200, { "content-type": "application/json", "set-cookie": "relay=1" });
    response.end('{"ok":true}');
  });
  const relaySockets: Socket[] = [];
  relay.on("upgrade", (request, socket: Socket) => {
    records.push({ method: request.method!, url: request.url!, headers: request.headers, body: "", upgrade: true });
    relaySockets.push(socket);
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const message = Buffer.from("relay");
    socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  const trust = {
    endpoint: `https://127.0.0.1:${address.port}/api/aiden/v1`,
    serverSpkiSha256: identity.serverSpkiSha256,
    caCertificateDerBase64: new X509Certificate(identity.caCertificate).raw.toString("base64"),
  };
  const upstream = (pin: string): DeviceHubUpstream => ({
    origin: `https://127.0.0.1:${address.port}`,
    basePath: "/api/aiden/v1/simulators/hub",
    headers: { authorization: `Bearer ${"s".repeat(43)}`, "aiden-protocol-version": "1" },
    tls: peerTlsOptions({ ...trust, serverSpkiSha256: pin }),
  });
  const proxy = await startDeviceHubProxy({
    resolveHub: async (hostId) =>
      hostId === "studio"
        ? upstream(trust.serverSpkiSha256)
        : hostId === "impostor"
          ? upstream(`sha256/${Buffer.alloc(32, 9).toString("base64")}`)
          : null,
    allowedOrigins: ["file://"],
  });
  try {
    const { token } = proxy.mintGrant();
    const response = await send(proxy, `/api/devices?host=studio&t=${token}`, {
      headers: { origin: "file://", authorization: "Bearer renderer", cookie: "a=1" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers["set-cookie"], undefined);
    const [record] = records;
    assert.equal(record?.url, "/api/aiden/v1/simulators/hub/api/devices");
    assert.equal(record?.headers.authorization, `Bearer ${"s".repeat(43)}`);
    assert.equal(record?.headers["aiden-protocol-version"], "1");
    assert.equal(record?.headers.origin, undefined);
    assert.equal(record?.headers.cookie, undefined);

    const socket = await upgrade(proxy, `/vendor/serve-sim/helper/ws?device=UDID-1&host=studio&t=${token}`);
    assert.equal(socket.status, 101);
    assert.equal(await socket.firstFrame, "relay");
    socket.socket?.destroy();
    const upgraded = records.find((entry) => entry.upgrade);
    assert.equal(upgraded?.url, "/api/aiden/v1/simulators/hub/vendor/serve-sim/helper/ws?device=UDID-1");
    assert.equal(upgraded?.headers.authorization, `Bearer ${"s".repeat(43)}`);
    assert.equal(upgraded?.headers.origin, undefined);

    const before = records.length;
    assert.equal((await send(proxy, `/api/devices?host=impostor&t=${token}`, { headers: { origin: "file://" } })).status, 502);
    assert.equal((await send(proxy, `/api/devices?host=nobody&t=${token}`, { headers: { origin: "file://" } })).status, 503);
    assert.equal(records.length, before);
  } finally {
    await proxy.close();
    for (const socket of relaySockets) socket.destroy();
    relay.closeAllConnections();
    await new Promise((resolve) => relay.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
