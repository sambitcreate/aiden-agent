import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import test from "node:test";

import { createDeviceStreamClient, type DeviceScreenSize, type DeviceStreamRuntime } from "../../../renderer/lib/device-stream.js";
import { BOT_COMPUTER_VIEWER_HOST_ID } from "../../../renderer/shared/bot-computers.js";
import { startDeviceHubProxy, type DeviceHubProxy } from "../devices/device-hub-proxy.js";
import { createBotComputerControl } from "./control.js";
import { XK } from "./keysyms.js";
import { connectRfb } from "./rfb-client.js";
import { FakeRfbServer } from "./rfb-fake-server.js";
import { createRfbScreen, type BotComputerLiveScreen } from "./rfb-screen.js";
import { BotComputerTakenOverError } from "./types.js";
import { BOT_COMPUTER_VIEWER_KEY_HEADER, startBotComputerViewerHub, type BotComputerViewerHub } from "./viewer-hub.js";

const VM = "aiden-bot-0123456789abcdef";
const BOT = "bot-ada";

async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${condition.toString().slice(0, 160)}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Harness {
  server: FakeRfbServer;
  screen: BotComputerLiveScreen;
  hub: BotComputerViewerHub;
  proxy: DeviceHubProxy;
  key: string;
  control: ReturnType<typeof createBotComputerControl>;
  touches: string[];
  encodes: () => number;
  takeOvers: string[];
}

async function withHub(run: (harness: Harness) => Promise<void>, options: { keepAliveMs?: number } = {}) {
  const server = new FakeRfbServer({ width: 40, height: 30, password: "run-pass-1" });
  const port = await server.listen();
  let encodes = 0;
  const screen = await createRfbScreen({
    connect: (signal) => connectRfb(connect({ host: "127.0.0.1", port }), { password: "run-pass-1", signal }),
    // Each JPEG names the pixel at (0, 0), so a part shows which picture it carries.
    encode: async (bgra, width, height) => {
      encodes += 1;
      return { image: Buffer.from(`JPEG ${bgra[2]},${bgra[1]},${bgra[0]}`), width, height };
    },
    frameIntervalMs: 10,
  });
  const control = createBotComputerControl();
  const takeOvers: string[] = [];
  control.onChange((botId) => {
    if (control.controller(botId) === "person") takeOvers.push(control.takenOverBy(botId) ?? "?");
  });
  const touches: string[] = [];
  const key = randomBytes(32).toString("base64url");
  const hub = await startBotComputerViewerHub({
    key,
    botForVm: (vmName) => (vmName === VM ? BOT : undefined),
    screen: async () => screen,
    control,
    touch: (botId) => touches.push(botId),
    frameIntervalMs: 30,
    keepAliveMs: options.keepAliveMs ?? 60_000,
    inputTouchMs: 0,
  });
  const proxy = await startDeviceHubProxy({
    resolveHub: (hostId) => (hostId === BOT_COMPUTER_VIEWER_HOST_ID ? hub.origin : null),
    allowedOrigins: ["file://"],
    hubHeaders: { [BOT_COMPUTER_VIEWER_KEY_HEADER]: key },
  });
  try {
    await run({ server, screen, hub, proxy, key, control, touches, encodes: () => encodes, takeOvers });
  } finally {
    await proxy.close();
    await hub.close();
    await screen.close();
    await server.close();
  }
}

const proxied = (proxy: DeviceHubProxy, path: string) => {
  const url = new URL(path, proxy.origin);
  url.searchParams.set("t", proxy.mintGrant().token);
  url.searchParams.set("host", BOT_COMPUTER_VIEWER_HOST_ID);
  return `${url.pathname}${url.search}`;
};

/** A GET whose body is read as it arrives. */
function get(origin: string, path: string, headers: Record<string, string>) {
  return new Promise<{ response: IncomingMessage; chunks: Buffer[] }>((resolve, reject) => {
    const request = httpRequest(`${origin}${path}`, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", () => undefined);
      resolve({ response, chunks });
    });
    request.once("error", reject);
    request.end();
  });
}

interface Part {
  headers: Record<string, string>;
  body: string;
}

/** Splits `--frame` multipart bytes into whole parts, checking each part's length. */
function parts(chunks: Buffer[]): Part[] {
  const bytes = Buffer.concat(chunks);
  const found: Part[] = [];
  let cursor = 0;
  for (;;) {
    const start = bytes.indexOf("--frame\r\n", cursor);
    if (start < 0) return found;
    const headerEnd = bytes.indexOf("\r\n\r\n", start);
    if (headerEnd < 0) return found;
    const headers: Record<string, string> = {};
    for (const line of bytes.subarray(start + 9, headerEnd).toString().split("\r\n")) {
      const [name, ...value] = line.split(":");
      headers[name.toLowerCase()] = value.join(":").trim();
    }
    const length = Number(headers["content-length"]);
    const bodyStart = headerEnd + 4;
    if (bytes.length < bodyStart + length + 2) return found;
    assert.equal(bytes.subarray(bodyStart + length, bodyStart + length + 2).toString(), "\r\n");
    found.push({ headers, body: bytes.subarray(bodyStart, bodyStart + length).toString() });
    cursor = bodyStart + length + 2;
  }
}

/** A minimal masked WebSocket client, so frames can also be malformed on purpose. */
async function openSocket(origin: string, path: string, headers: Record<string, string> = {}) {
  const url = new URL(origin);
  const socket = connect({ host: url.hostname, port: Number(url.port) });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${url.host}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ];
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  let buffered = Buffer.alloc(0);
  const messages: Buffer[] = [];
  let status = 0;
  let closed = false;
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (status === 0) {
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      status = Number(/^HTTP\/1\.1 (\d+)/u.exec(buffered.subarray(0, end).toString())?.[1] ?? 0);
      buffered = buffered.subarray(end + 4);
    }
    while (buffered.length >= 2) {
      const length = buffered[1] & 0x7f;
      const offset = length === 126 ? 4 : 2;
      const size = length === 126 ? buffered.readUInt16BE(2) : length;
      if (buffered.length < offset + size) return;
      messages.push(Buffer.from(buffered.subarray(0, offset + size)));
      buffered = buffered.subarray(offset + size);
    }
  });
  socket.on("close", () => {
    closed = true;
  });
  socket.on("error", () => undefined);
  await until(() => status !== 0 || closed);
  const frame = (opcode: number, payload: Buffer, options: { masked?: boolean; fin?: boolean } = {}) => {
    const masked = options.masked ?? true;
    const header =
      payload.length < 126
        ? Buffer.from([(options.fin ?? true ? 0x80 : 0) | opcode, (masked ? 0x80 : 0) | payload.length])
        : Buffer.from([(options.fin ?? true ? 0x80 : 0) | opcode, (masked ? 0x80 : 0) | 126, payload.length >> 8, payload.length & 0xff]);
    const mask = masked ? randomBytes(4) : Buffer.alloc(0);
    const body = Buffer.from(payload);
    if (masked) for (let index = 0; index < body.length; index += 1) body[index] ^= mask[index % 4];
    return Buffer.concat([header, mask, body]);
  };
  return {
    status: () => status,
    closed: () => closed,
    socket,
    /** Server frames as `[opcode, payload]`. */
    messages: () =>
      messages.map((message) => {
        const length = message[1] & 0x7f;
        return [message[0] & 0x0f, message.subarray(length === 126 ? 4 : 2)] as const;
      }),
    send: (tag: number, body: unknown) => socket.write(frame(0x2, Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(body))]))),
    sendRaw: (opcode: number, payload: Buffer, options?: { masked?: boolean; fin?: boolean }) => socket.write(frame(opcode, payload, options)),
    close: () => socket.destroy(),
  };
}

const hubHeaders = (hub: BotComputerViewerHub, key: string) => ({ host: new URL(hub.origin).host, [BOT_COMPUTER_VIEWER_KEY_HEADER]: key });

/** A Bot action that runs until something aborts it. */
function botAction(control: ReturnType<typeof createBotComputerControl>) {
  return control.run(BOT, undefined, (signal) => new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))));
}

test("the screen streams as multipart JPEG through the proxy, a part per change, and a late viewer gets the current picture at once", async () => {
  await withHub(async ({ server, proxy, encodes }) => {
    server.paint({ x: 0, y: 0, width: 40, height: 30 }, [10, 20, 30]);
    const first = await get(proxy.origin, proxied(proxy, `/vendor/serve-sim/helper/${VM}/stream.mjpeg`), { origin: "file://" });
    assert.equal(first.response.statusCode, 200);
    assert.match(String(first.response.headers["content-type"]), /^multipart\/x-mixed-replace; boundary=frame$/u);
    assert.equal(first.response.headers["cache-control"], "no-store, no-transform");
    await until(() => parts(first.chunks).length >= 1);
    assert.deepEqual(parts(first.chunks)[0], {
      headers: { "content-type": "image/jpeg", "content-length": String("JPEG 10,20,30".length) },
      body: "JPEG 10,20,30",
    });
    server.paint({ x: 0, y: 0, width: 1, height: 1 }, [200, 0, 0]);
    await until(() => parts(first.chunks).some((part) => part.body === "JPEG 200,0,0"));
    const encoded = encodes();
    // Nothing changed: a second viewer is sent the picture already taken, without encoding another.
    const second = await get(proxy.origin, proxied(proxy, `/vendor/serve-sim/helper/${VM}/stream.mjpeg`), { origin: "file://" });
    await until(() => parts(second.chunks).length >= 1);
    assert.equal(parts(second.chunks)[0].body, "JPEG 200,0,0");
    assert.equal(encodes(), encoded);
    first.response.destroy();
    second.response.destroy();
  });
});

test("frames are no faster than the frame interval however often the screen changes", async () => {
  await withHub(async ({ server, hub, key, encodes }) => {
    const stream = await get(hub.origin, `/vendor/serve-sim/helper/${VM}/stream.mjpeg`, hubHeaders(hub, key));
    await until(() => parts(stream.chunks).length >= 1);
    const before = encodes();
    const started = Date.now();
    for (let frame = 0; frame < 30; frame += 1) {
      server.paint({ x: frame % 40, y: 0, width: 1, height: 1 }, [frame, frame, frame]);
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    const elapsed = Date.now() - started;
    // One frame per 30 ms interval at most, plus the one in flight when painting began.
    assert.ok(encodes() - before <= Math.ceil(elapsed / 30) + 1, `${encodes() - before} frames in ${elapsed} ms`);
    assert.ok(encodes() - before >= 2, "changes keep producing frames");
    stream.response.destroy();
  });
});

test("only main's proxy reaches the hub: no key, another Host or Origin, other routes and other VMs are refused", async () => {
  await withHub(async ({ hub, key, proxy }) => {
    const path = `/vendor/serve-sim/helper/${VM}/stream.mjpeg`;
    const status = async (target: string, route: string, headers: Record<string, string>) => {
      const { response } = await get(target, route, headers);
      response.destroy();
      return response.statusCode;
    };
    const { host } = new URL(hub.origin);
    assert.equal(await status(hub.origin, path, { host }), 403, "no key");
    assert.equal(await status(hub.origin, path, { host, [BOT_COMPUTER_VIEWER_KEY_HEADER]: `${key}x` }), 403, "wrong key");
    assert.equal(await status(hub.origin, path, { host: "localhost", [BOT_COMPUTER_VIEWER_KEY_HEADER]: key }), 403, "rebound Host");
    assert.equal(await status(hub.origin, path, { ...hubHeaders(hub, key), origin: "https://evil.example" }), 403, "foreign Origin");
    assert.equal(await status(hub.origin, path, { ...hubHeaders(hub, key), origin: hub.origin }), 200, "the hub's own Origin");
    assert.equal(await status(hub.origin, `/vendor/serve-sim/helper/aiden-bot-ffffffffffffffff/stream.mjpeg`, hubHeaders(hub, key)), 404);
    assert.equal(await status(hub.origin, `/vendor/serve-sim/helper/${VM}/stream.avcc`, hubHeaders(hub, key)), 404);
    assert.equal(await status(hub.origin, `/vendor/serve-sim/api`, hubHeaders(hub, key)), 404);
    // Through the proxy: a grant and the renderer's Origin are needed.
    assert.equal(await status(proxy.origin, `${path}?host=${BOT_COMPUTER_VIEWER_HOST_ID}`, { origin: "file://" }), 401);
    assert.equal(await status(proxy.origin, proxied(proxy, path), { origin: "https://evil.example" }), 403);
    assert.equal(await status(proxy.origin, proxied(proxy, path).replace(`host=${BOT_COMPUTER_VIEWER_HOST_ID}`, "host=local"), { origin: "file://" }), 503);

    const noKey = await openSocket(hub.origin, `/vendor/serve-sim/helper/ws?device=${VM}`);
    assert.equal(noKey.status(), 403);
    const otherVm = await openSocket(hub.origin, `/vendor/serve-sim/helper/ws?device=aiden-bot-ffffffffffffffff`, {
      [BOT_COMPUTER_VIEWER_KEY_HEADER]: key,
    });
    assert.equal(otherVm.status(), 404);
    const twoDevices = await openSocket(hub.origin, `/vendor/serve-sim/helper/ws?device=${VM}&device=${VM}`, {
      [BOT_COMPUTER_VIEWER_KEY_HEADER]: key,
    });
    assert.equal(twoDevices.status(), 404);
  });
});

test("the input socket tells the viewer the screen size on open and again after a resize", async () => {
  await withHub(async ({ server, proxy }) => {
    const socket = await openSocket(proxy.origin, proxied(proxy, `/vendor/serve-sim/helper/ws?device=${VM}`), { origin: "file://" });
    assert.equal(socket.status(), 101);
    const configs = () =>
      socket
        .messages()
        .filter(([opcode, payload]) => opcode === 0x2 && payload[0] === 0x82)
        .map(([, payload]) => JSON.parse(payload.subarray(1).toString()) as unknown);
    await until(() => configs().length === 1);
    assert.deepEqual(configs(), [{ width: 40, height: 30, orientation: "portrait" }]);
    server.resize(64, 48);
    await until(() => configs().length === 2);
    assert.deepEqual(configs()[1], { width: 64, height: 48, orientation: "portrait" });
    socket.close();
  });
});

test("a touch while the Bot drives takes over, interrupting the Bot's action, and that whole touch is swallowed", async () => {
  await withHub(async ({ server, proxy, control, takeOvers }) => {
    const action = botAction(control);
    const socket = await openSocket(proxy.origin, proxied(proxy, `/vendor/serve-sim/helper/ws?device=${VM}`), { origin: "file://" });
    socket.send(0x03, { type: "begin", x: 0.5, y: 0.5 });
    await assert.rejects(action, BotComputerTakenOverError);
    assert.equal(control.controller(BOT), "person");
    assert.deepEqual(takeOvers, ["input"]);
    socket.send(0x03, { type: "move", x: 0.6, y: 0.5 });
    socket.send(0x03, { type: "end", x: 0.6, y: 0.5 });
    // The next touch is the person's own: it clicks at framebuffer pixels.
    socket.send(0x03, { type: "begin", x: 0.25, y: 0.5 });
    socket.send(0x03, { type: "move", x: 1, y: 1 });
    socket.send(0x03, { type: "end", x: 1, y: 1 });
    const connection = server.connections[0];
    await until(() => connection.pointer.length === 3);
    assert.deepEqual(connection.pointer, [
      { x: 10, y: 15, buttons: 1 },
      { x: 39, y: 29, buttons: 1 },
      { x: 39, y: 29, buttons: 0 },
    ]);
    socket.close();
  });
});

test("a key that takes over is swallowed with its release; the person's later keys reach the computer as keysyms", async () => {
  await withHub(async ({ server, proxy, control }) => {
    const socket = await openSocket(proxy.origin, proxied(proxy, `/vendor/serve-sim/helper/ws?device=${VM}`), { origin: "file://" });
    socket.send(0x06, { type: "down", usage: 0x04 });
    await until(() => control.controller(BOT) === "person");
    socket.send(0x06, { type: "up", usage: 0x04 });
    socket.send(0x06, { type: "down", usage: 0xe3 });
    socket.send(0x06, { type: "down", usage: 0x05 });
    socket.send(0x06, { type: "up", usage: 0x05 });
    socket.send(0x06, { type: "up", usage: 0xe3 });
    // A release without a press, and a key a Mac has no use for, send nothing.
    socket.send(0x06, { type: "up", usage: 0x06 });
    socket.send(0x06, { type: "down", usage: 0x46 });
    const connection = server.connections[0];
    await until(() => connection.keys.length >= 4);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(connection.keys, [
      { keysym: XK.Super_L, down: true },
      { keysym: 0x62, down: true },
      { keysym: 0x62, down: false },
      { keysym: XK.Super_L, down: false },
    ]);
    socket.close();
  });
});

test("Give back lifts whatever the person still holds, and the rest of that gesture never reaches the Bot's computer", async () => {
  await withHub(async ({ server, proxy, control }) => {
    control.takeOver(BOT, "viewer");
    const socket = await openSocket(proxy.origin, proxied(proxy, `/vendor/serve-sim/helper/ws?device=${VM}`), { origin: "file://" });
    socket.send(0x03, { type: "begin", x: 0.5, y: 0.5 });
    socket.send(0x06, { type: "down", usage: 0xe1 });
    const connection = server.connections[0];
    await until(() => connection.pointer.length === 1 && connection.keys.length === 1);
    control.giveBack(BOT);
    await until(() => connection.pointer.length === 2 && connection.keys.length === 2);
    assert.deepEqual(connection.pointer[1], { x: 20, y: 15, buttons: 0 });
    assert.deepEqual(connection.keys[1], { keysym: XK.Shift_L, down: false });
    socket.send(0x03, { type: "move", x: 0.1, y: 0.1 });
    socket.send(0x03, { type: "end", x: 0.1, y: 0.1 });
    socket.send(0x06, { type: "up", usage: 0xe1 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(connection.pointer.length, 2);
    assert.equal(connection.keys.length, 2);
    assert.equal(control.controller(BOT), "bot", "a gesture's tail never takes over again");
    socket.close();
  });
});

test("closing the viewer while the person holds a key or button lifts it", async () => {
  await withHub(async ({ server, proxy, control }) => {
    control.takeOver(BOT, "viewer");
    const socket = await openSocket(proxy.origin, proxied(proxy, `/vendor/serve-sim/helper/ws?device=${VM}`), { origin: "file://" });
    socket.send(0x03, { type: "begin", x: 0, y: 0 });
    socket.send(0x06, { type: "down", usage: 0xe0 });
    const connection = server.connections[0];
    await until(() => connection.pointer.length === 1 && connection.keys.length === 1);
    socket.close();
    await until(() => connection.pointer.length === 2 && connection.keys.length === 2);
    assert.deepEqual(connection.pointer[1], { x: 0, y: 0, buttons: 0 });
    assert.deepEqual(connection.keys[1], { keysym: XK.Control_L, down: false });
  });
});

test("scrolling takes over like any input, then becomes wheel clicks at the point, a step per 40 pixels", async () => {
  await withHub(async ({ server, proxy, control }) => {
    const socket = await openSocket(proxy.origin, proxied(proxy, `/vendor/serve-sim/helper/ws?device=${VM}`), { origin: "file://" });
    socket.send(0x20, { x: 0.5, y: 0.5, dx: 0, dy: 400 });
    await until(() => control.controller(BOT) === "person");
    socket.send(0x20, { x: 0.5, y: 0.5, dx: 0, dy: 80 });
    // Small trackpad deltas add up to one step.
    socket.send(0x20, { x: 0.5, y: 0.5, dx: 0, dy: -25 });
    socket.send(0x20, { x: 0.5, y: 0.5, dx: 0, dy: -25 });
    socket.send(0x20, { x: 0.5, y: 0.5, dx: -40, dy: 0 });
    const connection = server.connections[0];
    await until(() => connection.pointer.length === 8);
    assert.deepEqual(
      connection.pointer.map((event) => event.buttons),
      [16, 0, 16, 0, 8, 0, 32, 0],
    );
    assert.ok(connection.pointer.every((event) => event.x === 20 && event.y === 15));
    // A flick is capped, so one packet can't flood the guest.
    socket.send(0x20, { x: 0.5, y: 0.5, dx: 0, dy: 100_000 });
    await until(() => connection.pointer.length === 28);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(connection.pointer.length, 28);
    socket.close();
  });
});

test("malformed WebSocket frames close the socket without reaching the computer", async () => {
  await withHub(async ({ server, hub, key, control }) => {
    control.takeOver(BOT, "viewer");
    const path = `/vendor/serve-sim/helper/ws?device=${VM}`;
    const closeCode = (socket: Awaited<ReturnType<typeof openSocket>>) => {
      const close = socket.messages().find(([opcode]) => opcode === 0x8);
      return close ? close[1].readUInt16BE(0) : undefined;
    };
    const touch = Buffer.concat([Buffer.from([0x03]), Buffer.from(JSON.stringify({ type: "begin", x: 0.5, y: 0.5 }))]);
    const unmasked = await openSocket(hub.origin, path, { [BOT_COMPUTER_VIEWER_KEY_HEADER]: key });
    unmasked.sendRaw(0x2, touch, { masked: false });
    await until(() => unmasked.closed());
    assert.equal(closeCode(unmasked), 1002);
    const fragmented = await openSocket(hub.origin, path, { [BOT_COMPUTER_VIEWER_KEY_HEADER]: key });
    fragmented.sendRaw(0x2, touch, { fin: false });
    await until(() => fragmented.closed());
    assert.equal(closeCode(fragmented), 1003);
    const oversize = await openSocket(hub.origin, path, { [BOT_COMPUTER_VIEWER_KEY_HEADER]: key });
    oversize.sendRaw(0x2, Buffer.concat([touch, Buffer.alloc(5_000, 0x20)]));
    await until(() => oversize.closed());
    assert.equal(closeCode(oversize), 1009);
    // Pings are answered, and unknown packets are ignored rather than fatal.
    const healthy = await openSocket(hub.origin, path, { [BOT_COMPUTER_VIEWER_KEY_HEADER]: key });
    healthy.sendRaw(0x9, Buffer.from("hi"));
    healthy.send(0x04, { button: "home" });
    healthy.send(0x03, { type: "begin", x: "left", y: 0 });
    await until(() => healthy.messages().some(([opcode]) => opcode === 0xa));
    assert.equal(healthy.closed(), false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(server.connections[0].pointer, []);
    healthy.close();
  });
});

test("an open viewer keeps the computer awake, and the last one closing restarts its idle timer", async () => {
  await withHub(
    async ({ hub, key, touches }) => {
      const stream = await get(hub.origin, `/vendor/serve-sim/helper/${VM}/stream.mjpeg`, hubHeaders(hub, key));
      const socket = await openSocket(hub.origin, `/vendor/serve-sim/helper/ws?device=${VM}`, { [BOT_COMPUTER_VIEWER_KEY_HEADER]: key });
      await until(() => hub.viewers(BOT) === 2);
      const opened = touches.length;
      await until(() => touches.length >= opened + 2);
      stream.response.destroy();
      socket.close();
      await until(() => hub.viewers(BOT) === 0);
      const closedAt = touches.length;
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.ok(touches.length <= closedAt + 1, "no keep-alive once nobody watches");
      assert.ok(touches.every((botId) => botId === BOT));
    },
    { keepAliveMs: 20 },
  );
});

test("closing a VM ends its streams and sockets", async () => {
  await withHub(async ({ hub, key }) => {
    const stream = await get(hub.origin, `/vendor/serve-sim/helper/${VM}/stream.mjpeg`, hubHeaders(hub, key));
    const socket = await openSocket(hub.origin, `/vendor/serve-sim/helper/ws?device=${VM}`, { [BOT_COMPUTER_VIEWER_KEY_HEADER]: key });
    await until(() => hub.viewers(BOT) === 2);
    let ended = false;
    stream.response.once("close", () => {
      ended = true;
    });
    hub.closeVm(VM);
    await until(() => ended && socket.closed());
    assert.equal(hub.viewers(BOT), 0);
  });
});

test("the Simulator's device stream client drives the Bot's computer through the proxy unchanged", async () => {
  await withHub(async ({ server, proxy, control }) => {
    const screens: DeviceScreenSize[] = [];
    const inputs: boolean[] = [];
    let mjpegUrl: string | undefined;
    const runtime: DeviceStreamRuntime = {
      fetch: (url, init) => fetch(url, init),
      createSocket: (url) => new WebSocket(url) as unknown as ReturnType<DeviceStreamRuntime["createSocket"]>,
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (timer) => clearTimeout(timer),
    };
    const client = createDeviceStreamClient(
      { hostId: BOT_COMPUTER_VIEWER_HOST_ID, deviceId: VM, grant: proxy.mintGrant(), platform: "ios", preferMjpeg: true },
      { present: () => true },
      {
        onStatus: () => undefined,
        onScreen: (screen) => screens.push(screen),
        onUnauthorized: () => assert.fail("the grant was refused"),
        onMjpegFallback: (url) => {
          mjpegUrl = url;
        },
        onInputConnected: (connected) => inputs.push(connected),
      },
      runtime,
    );
    client.start();
    try {
      await until(() => inputs.includes(true) && screens.length > 0 && mjpegUrl !== undefined);
      assert.deepEqual(screens[0], { width: 40, height: 30, orientation: "portrait" });
      // Opening sends the hardware-keyboard setting, which is not the person's input.
      assert.equal(control.controller(BOT), "bot");
      // The URL it hands the <img> serves the screen.
      const frames = await fetch(mjpegUrl!);
      assert.match(frames.headers.get("content-type") ?? "", /^multipart\/x-mixed-replace/u);
      const reader = frames.body!.getReader();
      const first = await reader.read();
      assert.match(Buffer.from(first.value!).toString(), /--frame\r\nContent-Type: image\/jpeg/u);
      await reader.cancel();

      client.sendTouch("begin", 0.5, 0.5);
      await until(() => control.controller(BOT) === "person");
      client.sendTouch("end", 0.5, 0.5);
      client.sendTouch("begin", 0.75, 0.25);
      client.sendTouch("end", 0.75, 0.25);
      client.sendKey("KeyQ", "down");
      client.sendKey("KeyQ", "up");
      client.sendScroll(0.75, 0.25, 0, -40);
      const connection = server.connections[0];
      await until(() => connection.keys.length === 2 && connection.pointer.length === 4);
      assert.deepEqual(connection.pointer, [
        { x: 30, y: 7, buttons: 1 },
        { x: 30, y: 7, buttons: 0 },
        { x: 30, y: 7, buttons: 8 },
        { x: 30, y: 7, buttons: 0 },
      ]);
      assert.deepEqual(connection.keys, [
        { keysym: 0x71, down: true },
        { keysym: 0x71, down: false },
      ]);
    } finally {
      client.stop();
    }
  });
});
