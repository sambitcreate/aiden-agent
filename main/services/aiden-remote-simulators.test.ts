import assert from "node:assert/strict";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import test from "node:test";
import type { DeviceActionInput } from "../../renderer/shared/devices.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import { refuseUpgrade } from "./devices/device-hub-proxy.js";
import {
  AidenRemoteSimulatorRelay,
  MAX_RELAYS_PER_DEVICE,
  MOBILE_SIMULATOR_REFUSAL,
  type AidenRemoteSimulatorAudience,
  type AidenRemoteSimulatorHost,
  type AidenRemoteSimulatorListing,
} from "./aiden-remote-simulators.js";

const UDID = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-2222-3333-4444-555555555555";

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );
}

function fakeHost(overrides: Partial<AidenRemoteSimulatorHost> & { hub?: string | null } = {}) {
  let sharing = true;
  const listeners = new Set<(sharing: boolean) => void>();
  const calls: unknown[] = [];
  const listing: AidenRemoteSimulatorListing = {
    sharing: true,
    status: "ready",
    detail: "/Users/me/Library/Application Support/Aiden/devices",
    devices: [{ id: UDID, name: "iPhone 17", platform: "ios", version: "iOS 27.0", booted: true, kind: "iphone" }],
  };
  const host: AidenRemoteSimulatorHost = {
    sharing: () => sharing,
    list: async (options) => {
      if (options) calls.push(["list", options]);
      return { ...listing, sharing };
    },
    open: async (deviceId) => {
      calls.push(["open", deviceId]);
      return listing.devices[0]!;
    },
    shutdown: async (deviceId) => {
      calls.push(["shutdown", deviceId]);
    },
    settings: async (deviceId) => {
      calls.push(["settings", deviceId]);
      return { appearance: "dark" };
    },
    action: async (input: DeviceActionInput) => {
      calls.push(["action", input]);
      return {};
    },
    hubOrigin: () => (overrides.hub === undefined ? null : overrides.hub),
    isKnownDevice: (deviceId) => deviceId === UDID,
    onSharingChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...overrides,
  };
  return {
    host,
    calls,
    setSharing(next: boolean) {
      sharing = next;
      for (const listener of listeners) listener(next);
    },
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** A stand-in for the Aiden Remote router: authentication already passed as device `peer-1`. */
async function front(
  relay: AidenRemoteSimulatorRelay,
  as: { deviceId?: string; audience?: AidenRemoteSimulatorAudience; chatId?: string } = {},
) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://front");
    relay
      .handle({
        request: req,
        response: res,
        path: url.pathname,
        query: url.search.slice(1),
        deviceId: as.deviceId ?? "peer-1",
        ...(as.audience ? { audience: as.audience } : {}),
        ...(as.chatId ? { chatId: as.chatId } : {}),
        readJson: async (maximum) => {
          const body = await readBody(req);
          if (body.length > maximum) throw new AidenRemoteServiceError("payload_too_large", "Too large.", 413);
          return JSON.parse(body.toString("utf8") || "null") as unknown;
        },
        writeJson: (status, value) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(value));
        },
      })
      .catch((error: unknown) => {
        const failure = error as AidenRemoteServiceError;
        if (res.headersSent) return void res.destroy();
        res.writeHead(failure.status ?? 500, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: failure.code, message: failure.message }));
      });
  });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://front");
    try {
      relay.upgrade({
        request: req,
        socket,
        head,
        path: url.pathname,
        query: url.search.slice(1),
        deviceId: as.deviceId ?? "peer-1",
        ...(as.audience ? { audience: as.audience } : {}),
      });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      refuseUpgrade(socket, status, status === 404 ? "Not Found" : "Refused");
    }
  });
  const origin = await listen(server);
  return { server, origin };
}

function call(origin: string, method: string, path: string, body?: unknown) {
  return new Promise<{ status: number; json: Record<string, unknown>; text: string }>((resolve, reject) => {
    const req = request(`${origin}${path}`, { method, headers: { "content-type": "application/json" } }, (res) => {
      void readBody(res).then((buffer) => {
        const text = buffer.toString("utf8");
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(text) as Record<string, unknown>;
        } catch {
          // Relayed hub bodies may be plain text.
        }
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    req.once("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test("a Mac that is not sharing reveals no simulators or local detail", async (t) => {
  const fake = fakeHost();
  fake.setSharing(false);
  const { server, origin } = await front(new AidenRemoteSimulatorRelay(() => fake.host));
  t.after(() => server.close());
  const listed = await call(origin, "GET", "/simulators");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json, { sharing: false, status: "ready", devices: [] });
  const opened = await call(origin, "POST", "/simulators/open", { deviceId: UDID });
  assert.equal(opened.status, 404);
  assert.equal(opened.json.code, "not_found");
  assert.deepEqual(fake.calls, []);
});

test("without a device service every simulator route is not found", async (t) => {
  const { server, origin } = await front(new AidenRemoteSimulatorRelay(() => null));
  t.after(() => server.close());
  assert.equal((await call(origin, "GET", "/simulators")).status, 404);
  assert.equal((await call(origin, "POST", "/simulators/open", { deviceId: UDID })).status, 404);
});

test("mutations take exactly a listed deviceId and hide host failures", async (t) => {
  const fake = fakeHost({
    settings: async () => {
      throw new Error("xcrun failed at /Users/me/Library/Developer");
    },
  });
  const { server, origin } = await front(new AidenRemoteSimulatorRelay(() => fake.host));
  t.after(() => server.close());
  assert.equal((await call(origin, "GET", "/simulators?x=1")).status, 400);
  assert.equal((await call(origin, "POST", "/simulators/open", { deviceId: UDID, hostId: "local" })).status, 400);
  assert.equal((await call(origin, "POST", "/simulators/open", { deviceId: "../etc" })).status, 400);
  assert.equal((await call(origin, "POST", "/simulators/open", { deviceId: OTHER })).status, 404);
  assert.equal((await call(origin, "POST", "/simulators/reboot", { deviceId: UDID })).status, 404);
  assert.equal((await call(origin, "DELETE", "/simulators/open")).status, 404);
  const opened = await call(origin, "POST", "/simulators/open", { deviceId: UDID });
  assert.equal(opened.status, 200);
  assert.equal((opened.json.device as { id: string }).id, UDID);
  assert.equal((await call(origin, "POST", "/simulators/shutdown", { deviceId: UDID })).status, 200);
  const failed = await call(origin, "POST", "/simulators/settings", { deviceId: UDID });
  assert.equal(failed.status, 500);
  assert.doesNotMatch(failed.text, /xcrun|\/Users/u);
  assert.deepEqual(fake.calls, [
    ["open", UDID],
    ["shutdown", UDID],
  ]);
});

test("actions always target the serving Mac", async (t) => {
  const fake = fakeHost();
  const { server, origin } = await front(new AidenRemoteSimulatorRelay(() => fake.host));
  t.after(() => server.close());
  const done = await call(origin, "POST", "/simulators/action", {
    hostId: "peer:elsewhere",
    deviceId: UDID,
    type: "setAppearance",
    value: "dark",
  });
  assert.equal(done.status, 200);
  assert.deepEqual(fake.calls, [["action", { hostId: "local", deviceId: UDID, type: "setAppearance", value: "dark" }]]);
  const unknown = await call(origin, "POST", "/simulators/action", { deviceId: OTHER, type: "setAppearance", value: "dark" });
  assert.equal(unknown.status, 404);
  assert.equal((await call(origin, "POST", "/simulators/action", { deviceId: UDID, type: "exec" })).status, 400);
});

test("the hub relay applies the allowlist, listed devices, and a filtered screenshot body", async (t) => {
  const seen: { method: string; url: string; origin?: string; auth?: string; body: string }[] = [];
  const hub = createServer((req, res) => {
    void readBody(req).then((body) => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        origin: req.headers.origin,
        auth: req.headers.authorization,
        body: body.toString("utf8"),
      });
      res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*", "set-cookie": "a=b" });
      res.end("hub-ok");
    });
  });
  const hubOrigin = await listen(hub);
  t.after(() => hub.close());
  const fake = fakeHost({ hub: hubOrigin });
  const { server, origin } = await front(new AidenRemoteSimulatorRelay(() => fake.host));
  t.after(() => server.close());

  const health = await call(origin, "GET", `/simulators/hub/vendor/serve-sim/helper/${UDID}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.text, "hub-ok");
  assert.equal(seen[0]!.url, `/vendor/serve-sim/helper/${UDID}/health`);
  assert.equal(seen[0]!.origin, hubOrigin, "the hub sees its own origin");
  assert.equal(seen[0]!.auth, undefined);

  assert.equal((await call(origin, "GET", `/simulators/hub/vendor/serve-sim/helper/${OTHER}/health`)).status, 404);
  assert.equal((await call(origin, "GET", "/simulators/hub/exec")).status, 404);
  assert.equal((await call(origin, "GET", "/simulators/hub/vendor/serve-sim/helper/..%2fexec/health")).status, 404);
  assert.equal((await call(origin, "POST", `/simulators/hub/vendor/serve-sim/helper/${UDID}/health`, {})).status, 405);

  const shot = await call(origin, "POST", "/simulators/hub/vendor/serve-sim/api/screenshot", { udid: UDID, path: "/tmp/x" });
  assert.equal(shot.status, 200);
  assert.deepEqual(JSON.parse(seen[1]!.body), { udid: UDID });
  assert.equal((await call(origin, "POST", "/simulators/hub/vendor/serve-sim/api/screenshot", { udid: OTHER })).status, 404);
  assert.equal(
    (await call(origin, "POST", "/simulators/hub/vendor/serve-sim/api/screenshot", { udid: UDID, pad: "x".repeat(2_000) }))
      .status,
    413,
  );
  assert.equal(seen.length, 2, "refused requests never reach the hub");

  fake.setSharing(false);
  assert.equal((await call(origin, "GET", `/simulators/hub/vendor/serve-sim/helper/${UDID}/health`)).status, 404);
});

test("revoking a device or turning sharing off closes live relays", async (t) => {
  const hub = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "multipart/x-mixed-replace" });
    res.write("frame");
  });
  const hubOrigin = await listen(hub);
  t.after(() => {
    hub.closeAllConnections();
    hub.close();
  });
  const fake = fakeHost({ hub: hubOrigin });
  const relay = new AidenRemoteSimulatorRelay(() => fake.host);
  const { server, origin } = await front(relay);
  t.after(() => server.close());

  const stream = () =>
    new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(`${origin}/simulators/hub/vendor/serve-sim/helper/${UDID}/stream.mjpeg`, resolve);
      req.once("error", reject);
      req.end();
    });
  const ended = (res: IncomingMessage) =>
    new Promise<void>((resolve) => {
      res.once("close", resolve);
      res.resume();
    });

  const first = await stream();
  relay.revokeDevice("peer-1");
  await ended(first);

  const second = await stream();
  fake.setSharing(false);
  await ended(second);
});

test("a paired device may hold only a bounded number of relays", async (t) => {
  const hub = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "multipart/x-mixed-replace" });
    res.write("frame");
  });
  const hubOrigin = await listen(hub);
  t.after(() => {
    hub.closeAllConnections();
    hub.close();
  });
  const fake = fakeHost({ hub: hubOrigin });
  const relay = new AidenRemoteSimulatorRelay(() => fake.host);
  const { server, origin } = await front(relay);
  t.after(() => {
    relay.closeAll();
    server.closeAllConnections();
    server.close();
  });
  const stream = () =>
    new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(`${origin}/simulators/hub/vendor/serve-sim/helper/${UDID}/stream.mjpeg`, resolve);
      req.once("error", reject);
      req.end();
    });
  const open: IncomingMessage[] = [];
  for (let index = 0; index < MAX_RELAYS_PER_DEVICE; index += 1) {
    const response = await stream();
    assert.equal(response.statusCode, 200);
    response.resume();
    open.push(response);
  }
  const refused = await stream();
  assert.equal(refused.statusCode, 429);
  refused.resume();
  const closed = new Promise<void>((resolve) => open[0]!.once("close", () => resolve()));
  open[0]!.destroy();
  await closed;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const next = await stream();
    next.resume();
    if (next.statusCode === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("a freed relay slot was never reusable");
});

test("WebSocket upgrades relay only allowlisted sockets for listed devices", async (t) => {
  const upgrades: string[] = [];
  const hub = createServer();
  hub.on("upgrade", (req, socket) => {
    upgrades.push(`${req.url} origin=${req.headers.origin}`);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.end();
  });
  const hubOrigin = await listen(hub);
  t.after(() => hub.close());
  const fake = fakeHost({ hub: hubOrigin });
  const { server, origin } = await front(new AidenRemoteSimulatorRelay(() => fake.host));
  t.after(() => server.close());

  const upgrade = (path: string) =>
    new Promise<string>((resolve) => {
      const url = new URL(origin);
      const socket = connect({ host: url.hostname, port: Number(url.port) });
      let text = "";
      socket.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
      socket.on("close", () => resolve(text.split("\r\n")[0] ?? ""));
      socket.on("error", () => undefined);
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
    });

  assert.equal(await upgrade(`/simulators/hub/vendor/serve-sim/helper/ws?device=${UDID}`), "HTTP/1.1 101 Switching Protocols");
  assert.deepEqual(upgrades, [`/vendor/serve-sim/helper/ws?device=${UDID} origin=${hubOrigin}`]);
  assert.equal(await upgrade(`/simulators/hub/vendor/serve-sim/helper/ws?device=${OTHER}`), "HTTP/1.1 404 Not Found");
  assert.equal(await upgrade("/simulators/hub/exec"), "HTTP/1.1 404 Not Found");
  assert.equal(await upgrade("/simulators/open"), "HTTP/1.1 404 Not Found");
  assert.equal(upgrades.length, 1);
});

function upgradeStatus(origin: string, path: string) {
  return new Promise<string>((resolve) => {
    const url = new URL(origin);
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    let text = "";
    socket.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    socket.on("close", () => resolve(text.split("\r\n")[0] ?? ""));
    socket.on("error", () => undefined);
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
  });
}

test("a phone reaches only the MJPEG stream, the screen config reads and the input socket", async (t) => {
  const seen: string[] = [];
  const hub = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hub-ok");
  });
  hub.on("upgrade", (req, socket) => {
    seen.push(`UPGRADE ${req.url}`);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.end();
  });
  const hubOrigin = await listen(hub);
  t.after(() => hub.close());
  const phones = fakeHost({ hub: hubOrigin });
  // Paired Macs are not shared with, so the phone's consent alone lets it in.
  const desktops = fakeHost({ hub: hubOrigin });
  desktops.setSharing(false);
  const relay = new AidenRemoteSimulatorRelay((audience) => (audience === "mobile" ? phones.host : desktops.host));
  const { server, origin } = await front(relay, { deviceId: "phone-1", audience: "mobile" });
  t.after(() => server.close());

  for (const path of [
    `/simulators/hub/vendor/serve-sim/helper/${UDID}/stream.mjpeg`,
    `/simulators/hub/vendor/serve-sim/helper/${UDID}/config`,
    `/simulators/hub/vendor/serve-sim/helper/${UDID}/health`,
  ]) {
    const relayed = await call(origin, "GET", path);
    assert.equal(relayed.status, 200, path);
    assert.equal(relayed.text, "hub-ok");
  }
  for (const [method, path, body] of [
    ["GET", `/simulators/hub/vendor/serve-sim/helper/${UDID}/stream.avcc`],
    ["GET", `/simulators/hub/vendor/serve-sim/helper/${UDID}/ax`],
    ["GET", `/simulators/hub/vendor/serve-sim/helper/${UDID}/foreground`],
    ["GET", "/simulators/hub/vendor/serve-sim/api"],
    ["GET", "/simulators/hub/vendor/serve-sim/api/event-log"],
    ["GET", "/simulators/hub/api/devices"],
    ["POST", "/simulators/hub/vendor/serve-sim/api/screenshot", { udid: UDID }],
  ] as const) {
    const refused = await call(origin, method, path, body);
    assert.equal(refused.status, 403, path);
    assert.deepEqual(refused.json, { code: "capability_denied", message: MOBILE_SIMULATOR_REFUSAL });
  }
  assert.equal(await upgradeStatus(origin, `/simulators/hub/vendor/serve-sim/helper/ws?device=${UDID}`), "HTTP/1.1 101 Switching Protocols");
  assert.equal(await upgradeStatus(origin, "/simulators/hub/api/devices/ws"), "HTTP/1.1 403 Refused");
  assert.equal(await upgradeStatus(origin, `/simulators/hub/vendor/serve-sim/helper/ws?device=${OTHER}`), "HTTP/1.1 404 Not Found");
  assert.deepEqual(seen, [
    `GET /vendor/serve-sim/helper/${UDID}/stream.mjpeg`,
    `GET /vendor/serve-sim/helper/${UDID}/config`,
    `GET /vendor/serve-sim/helper/${UDID}/health`,
    `UPGRADE /vendor/serve-sim/helper/ws?device=${UDID}`,
  ]);

  // Settings and device actions stay desktop-only; open and shut down are allowed.
  for (const path of ["/simulators/settings", "/simulators/action"]) {
    const refused = await call(origin, "POST", path, { deviceId: UDID, type: "setAppearance", value: "dark" });
    assert.equal(refused.status, 403, path);
    assert.equal(refused.json.code, "capability_denied");
  }
  assert.equal((await call(origin, "POST", "/simulators/open", { deviceId: UDID })).status, 200);
  assert.equal((await call(origin, "POST", "/simulators/shutdown", { deviceId: UDID })).status, 200);
  assert.deepEqual(phones.calls, [
    ["open", UDID],
    ["shutdown", UDID],
  ]);
  assert.deepEqual(desktops.calls, []);

  phones.setSharing(false);
  const listing = await call(origin, "GET", "/simulators");
  assert.deepEqual(listing.json, { sharing: false, status: "ready", devices: [] });
  assert.equal((await call(origin, "GET", `/simulators/hub/vendor/serve-sim/helper/${UDID}/stream.mjpeg`)).status, 404);
});

test("a chat-scoped listing names the chat to the host and is refused anywhere else", async (t) => {
  const phones = fakeHost();
  const relay = new AidenRemoteSimulatorRelay(() => phones.host);
  const { server, origin } = await front(relay, { audience: "mobile", chatId: "chat-1" });
  t.after(() => server.close());
  const listed = await call(origin, "GET", "/simulators");
  assert.equal(listed.status, 200);
  assert.deepEqual(phones.calls, [["list", { chatId: "chat-1" }]]);
  assert.equal((await call(origin, "POST", "/simulators/open", { deviceId: UDID })).status, 400);
  assert.equal((await call(origin, "GET", `/simulators/hub/vendor/serve-sim/helper/${UDID}/stream.mjpeg`)).status, 400);
});

test("each audience's consent closes only its own live relays", async (t) => {
  const hub = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "multipart/x-mixed-replace" });
    res.write("frame");
  });
  const hubOrigin = await listen(hub);
  t.after(() => {
    hub.closeAllConnections();
    hub.close();
  });
  const phones = fakeHost({ hub: hubOrigin });
  const desktops = fakeHost({ hub: hubOrigin });
  const relay = new AidenRemoteSimulatorRelay((audience) => (audience === "mobile" ? phones.host : desktops.host));
  const phoneFront = await front(relay, { deviceId: "phone-1", audience: "mobile" });
  const macFront = await front(relay, { deviceId: "mac-1", audience: "desktop" });
  t.after(() => {
    relay.closeAll();
    for (const { server } of [phoneFront, macFront]) {
      server.closeAllConnections();
      server.close();
    }
  });
  const stream = (origin: string) =>
    new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(`${origin}/simulators/hub/vendor/serve-sim/helper/${UDID}/stream.mjpeg`, resolve);
      req.once("error", reject);
      req.end();
    });
  const phoneStream = await stream(phoneFront.origin);
  const macStream = await stream(macFront.origin);
  let macClosed = false;
  macStream.once("close", () => (macClosed = true));
  macStream.resume();
  const phoneClosed = new Promise<void>((resolve) => {
    phoneStream.once("close", resolve);
    phoneStream.resume();
  });

  phones.setSharing(false);
  await phoneClosed;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(macClosed, false, "turning off phone sharing leaves paired Macs streaming");
});

test("a paired Mac watches and folds a listed Android emulator, and stream tuning stays local", async (t) => {
  const seen: { method: string; url: string; body: string }[] = [];
  const hub = createServer((req, res) => {
    void readBody(req).then((body) => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", body: body.toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const hubOrigin = await listen(hub);
  t.after(() => hub.close());
  const SERIAL = "emulator-5554";
  const fake = fakeHost({ hub: hubOrigin, isKnownDevice: (deviceId) => deviceId === SERIAL });
  const { server, origin } = await front(new AidenRemoteSimulatorRelay(() => fake.host));
  t.after(() => server.close());
  const emu = "/simulators/hub/vendor/serve-emu/api";

  assert.equal((await call(origin, "GET", `${emu}/fold?device=${SERIAL}`)).status, 200);
  assert.equal((await call(origin, "GET", `${emu}/screenshot?device=${SERIAL}`)).status, 200);
  // The fold body is rebuilt from its posture alone.
  assert.equal((await call(origin, "POST", `${emu}/fold?device=${SERIAL}`, { posture: "closed", extra: 1 })).status, 200);
  assert.equal((await call(origin, "POST", `${emu}/fold?device=${SERIAL}`, { posture: "tent" })).status, 400);
  // Every device-scoped route must name a listed emulator.
  assert.equal((await call(origin, "GET", `${emu}/fold?device=emulator-5556`)).status, 404);
  assert.equal((await call(origin, "GET", `${emu}/fold`)).status, 404);
  assert.equal((await call(origin, "PUT", `${emu}/stream-mode?device=${SERIAL}`, { mode: "scrcpy" })).status, 405);
  assert.equal((await call(origin, "PATCH", `${emu}/stream-settings?device=${SERIAL}`, {})).status, 405);
  assert.equal((await call(origin, "POST", `${emu}/tap?device=${SERIAL}`, { x: 1, y: 1 })).status, 404);
  assert.deepEqual(
    seen.map((record) => [record.method, record.url, record.body]),
    [
      ["GET", `/vendor/serve-emu/api/fold?device=${SERIAL}`, ""],
      ["GET", `/vendor/serve-emu/api/screenshot?device=${SERIAL}`, ""],
      ["POST", `/vendor/serve-emu/api/fold?device=${SERIAL}`, JSON.stringify({ posture: "closed" })],
    ],
  );
});

test("Android listings and opens use AVD names and serials as device ids", async (t) => {
  const AVD = "Pixel_9_API_35";
  const fake = fakeHost({
    isKnownDevice: (deviceId) => deviceId === AVD,
    open: async () => ({
      id: "emulator-5554",
      name: AVD,
      platform: "android",
      version: "Android 15.0",
      booted: true,
      kind: "other",
    }),
  });
  const { server, origin } = await front(new AidenRemoteSimulatorRelay(() => fake.host));
  t.after(() => server.close());
  const opened = await call(origin, "POST", "/simulators/open", { deviceId: AVD });
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.json.device, {
    id: "emulator-5554",
    name: AVD,
    platform: "android",
    version: "Android 15.0",
    booted: true,
    kind: "other",
  });
  assert.equal((await call(origin, "POST", "/simulators/open", { deviceId: "-s" })).status, 400);
});

/** A client frame, masked as a phone's WebSocket sends it unless told otherwise. */
function clientFrame(opcode: number, payload: Buffer, options: { fin?: boolean; masked?: boolean } = {}): Buffer {
  const key = Buffer.from([0x5a, 0x13, 0xc4, 0x7e]);
  const masked = options.masked ?? true;
  const maskBit = masked ? 0x80 : 0;
  const length =
    payload.length < 126
      ? Buffer.from([payload.length | maskBit])
      : Buffer.from([126 | maskBit, payload.length >> 8, payload.length & 0xff]);
  const body = masked ? Buffer.from(payload.map((byte, index) => byte ^ key[index % 4]!)) : payload;
  const first = ((options.fin ?? true) ? 0x80 : 0) | opcode;
  return Buffer.concat([Buffer.from([first]), length, masked ? key : Buffer.alloc(0), body]);
}

const inputFrame = (tag: number, json: unknown) =>
  clientFrame(0x2, Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(json))]));

async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(condition(), what);
}

/** A hub whose input socket records every byte a client sends after the upgrade. */
async function recordingHub(t: { after(fn: () => void): void }) {
  const sockets: Array<{ headers: IncomingMessage["headers"]; bytes: Buffer; closed: boolean }> = [];
  const hub = createServer();
  hub.on("upgrade", (req, socket, head) => {
    const record = { headers: req.headers, bytes: Buffer.from(head), closed: false };
    sockets.push(record);
    socket.on("data", (chunk: Buffer) => (record.bytes = Buffer.concat([record.bytes, chunk])));
    // Like a WebSocket server, the hub closes its side once the relay closes.
    socket.on("end", () => socket.end());
    socket.on("close", () => (record.closed = true));
    socket.on("error", () => undefined);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
  const origin = await listen(hub);
  t.after(() => hub.close());
  return { origin, sockets };
}

async function openInputSocket(origin: string) {
  const url = new URL(origin);
  const socket = connect({ host: url.hostname, port: Number(url.port) });
  const state = { received: Buffer.alloc(0), closed: false };
  socket.on("data", (chunk: Buffer) => (state.received = Buffer.concat([state.received, chunk])));
  socket.on("close", () => (state.closed = true));
  socket.on("error", () => undefined);
  socket.write(
    `GET /simulators/hub/vendor/serve-sim/helper/ws?device=${UDID} HTTP/1.1\r\nHost: ${url.host}\r\n` +
      "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
      "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n\r\n",
  );
  await waitUntil(() => state.received.includes("\r\n\r\n"), "the upgrade was answered");
  assert.match(state.received.toString("latin1"), /^HTTP\/1\.1 101 /u);
  state.received = state.received.subarray(state.received.indexOf("\r\n\r\n") + 4);
  return { socket, state };
}

test("a phone's input socket carries only touch, button, orientation and keyboard-mode messages", async (t) => {
  const hub = await recordingHub(t);
  const phones = fakeHost({ hub: hub.origin });
  const relay = new AidenRemoteSimulatorRelay((audience) => (audience === "mobile" ? phones.host : null));
  const { server, origin } = await front(relay, { deviceId: "phone-1", audience: "mobile" });
  t.after(() => server.close());

  const { socket, state } = await openInputSocket(origin);
  await waitUntil(() => hub.sockets.length === 1, "the hub saw the upgrade");
  assert.equal(hub.sockets[0]!.headers["sec-websocket-extensions"], undefined, "no extension rewrites a phone's frames");

  const longTouch = inputFrame(0x03, { type: "move", x: 0.5, y: 0.5, padding: "x".repeat(180) });
  const rest = [
    inputFrame(0x0d, { enabled: false }),
    inputFrame(0x03, { type: "begin", x: 0.25, y: 0.75 }),
    inputFrame(0x04, { button: "home" }),
    inputFrame(0x07, { orientation: "landscape_left" }),
    clientFrame(0x9, Buffer.from("ping")),
  ];
  // A frame split before its tag byte still reaches a verdict.
  socket.write(longTouch.subarray(0, 5));
  await new Promise((resolve) => setTimeout(resolve, 10));
  socket.write(longTouch.subarray(5));
  for (const frame of rest) socket.write(frame);
  const expected = Buffer.concat([longTouch, ...rest]);
  await waitUntil(() => hub.sockets[0]!.bytes.length >= expected.length, "the hub received every allowed frame");
  assert.deepEqual(hub.sockets[0]!.bytes, expected, "allowed frames pass byte for byte");

  // A keyboard key (0x06) is desktop-only: the phone is closed with 1008 and the hub never sees it.
  socket.write(Buffer.concat([inputFrame(0x06, { usage: 4, down: true }), inputFrame(0x03, { type: "end", x: 0, y: 0 })]));
  await waitUntil(() => state.closed, "the phone was closed");
  await waitUntil(() => hub.sockets[0]!.closed, "the hub socket was closed");
  assert.equal(state.received[0], 0x88, "the phone got a close frame");
  assert.equal(state.received.readUInt16BE(2), 1008);
  assert.deepEqual(hub.sockets[0]!.bytes, expected, "nothing from the violation on reached the hub");

  // Text, unmasked and empty messages are violations too.
  for (const frame of [
    clientFrame(0x1, Buffer.from('{"type":"begin"}')),
    clientFrame(0x2, Buffer.from([0x03, 0x7b, 0x7d]), { masked: false }),
    clientFrame(0x2, Buffer.alloc(0)),
  ]) {
    const before = hub.sockets.length;
    const next = await openInputSocket(origin);
    await waitUntil(() => hub.sockets.length === before + 1, "the hub saw the upgrade");
    next.socket.write(frame);
    await waitUntil(() => next.state.closed, "the phone was closed");
    assert.equal(next.state.received.readUInt16BE(2), 1008);
    assert.equal(hub.sockets[before]!.bytes.length, 0);
  }
});

test("a paired Mac's input socket stays an opaque pipe", async (t) => {
  const hub = await recordingHub(t);
  const desktops = fakeHost({ hub: hub.origin });
  const { server, origin } = await front(new AidenRemoteSimulatorRelay(() => desktops.host));
  t.after(() => server.close());

  const { socket, state } = await openInputSocket(origin);
  await waitUntil(() => hub.sockets.length === 1, "the hub saw the upgrade");
  assert.equal(hub.sockets[0]!.headers["sec-websocket-extensions"], "permessage-deflate; client_max_window_bits");
  const frames = Buffer.concat([
    inputFrame(0x06, { usage: 4, down: true }),
    inputFrame(0x05, { touches: [] }),
    clientFrame(0x1, Buffer.from("text")),
  ]);
  socket.write(frames);
  await waitUntil(() => hub.sockets[0]!.bytes.length >= frames.length, "the hub received every frame");
  assert.deepEqual(hub.sockets[0]!.bytes, frames);
  assert.equal(state.closed, false);
  socket.destroy();
});
