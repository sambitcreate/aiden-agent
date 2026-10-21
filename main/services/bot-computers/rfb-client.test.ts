import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { Duplex } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { connectRfb, RfbError, type RfbClient } from "./rfb-client.js";
import { FakeRfbServer } from "./rfb-fake-server.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/rfb/", import.meta.url));
const fixture = (name: string) => readFileSync(`${FIXTURES}${name}`);

/** A socket that plays a recorded server transcript, `chunk` bytes at a time, and keeps what the client wrote. */
function replay(bytes: Buffer, chunk = bytes.length) {
  const written: Buffer[] = [];
  const socket = new Duplex({
    read() {},
    write(data: Buffer, _encoding, callback) {
      written.push(Buffer.from(data));
      callback();
    },
  });
  setImmediate(() => {
    for (let offset = 0; offset < bytes.length; offset += chunk) socket.push(bytes.subarray(offset, offset + chunk));
  });
  return { socket, written: () => Buffer.concat(written) };
}

/** The client's handshake writes, parsed in order. */
function clientMessages(bytes: Buffer) {
  const version = bytes.subarray(0, 12).toString("latin1");
  let offset = 12;
  const security = bytes[offset++];
  const shared = bytes[offset++];
  const messages: { type: number; body: Buffer }[] = [];
  while (offset < bytes.length) {
    const type = bytes[offset];
    const length = type === 0 ? 20 : type === 2 ? 4 + bytes.readUInt16BE(offset + 2) * 4 : type === 3 ? 10 : type === 4 ? 8 : 6;
    messages.push({ type, body: bytes.subarray(offset, offset + length) });
    offset += length;
  }
  return { version, security, shared, messages };
}

function bgra(client: RfbClient, x: number, y: number): number[] {
  const { data, width } = client.framebuffer();
  const offset = (y * width + x) * 4;
  return [...data.subarray(offset, offset + 4)];
}

const RED = [0, 0, 255, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [255, 0, 0, 255];
const WHITE = [255, 255, 255, 255];
const BLACK = [0, 0, 0, 255];

async function withServer(options: ConstructorParameters<typeof FakeRfbServer>[0], run: (server: FakeRfbServer, port: number) => Promise<void>) {
  const server = new FakeRfbServer(options);
  const port = await server.listen();
  try {
    await run(server, port);
  } finally {
    await server.close();
  }
}

const open = (port: number) => connect({ host: "127.0.0.1", port });

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the fake server.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a 1024×768 ServerInit gives a shared client that asks for Raw, CopyRect and DesktopSize, then a full picture", async () => {
  const { socket, written } = replay(fixture("server-init-1024x768.bin"));
  const client = await connectRfb(socket);
  assert.equal(client.name, "aiden-fixture");
  assert.equal(client.width, 1024);
  assert.equal(client.height, 768);
  await new Promise((resolve) => setImmediate(resolve));
  const sent = clientMessages(written());
  assert.equal(sent.version, "RFB 003.008\n");
  assert.equal(sent.security, 1, "security None, the only one offered");
  assert.equal(sent.shared, 1, "other viewers of the computer stay connected");
  assert.deepEqual(
    sent.messages.map((message) => message.type),
    [2, 3],
    "the server already speaks BGRX, so no SetPixelFormat",
  );
  const encodings = sent.messages[0].body;
  const listed = Array.from({ length: encodings.readUInt16BE(2) }, (_, index) => encodings.readInt32BE(4 + index * 4));
  assert.deepEqual([...listed].sort((a, b) => a - b), [-223, 0, 1]);
  const request = sent.messages[1].body;
  assert.equal(request[1], 0, "the first request is for the whole screen");
  assert.deepEqual([request.readUInt16BE(6), request.readUInt16BE(8)], [1024, 768]);
  // Nothing painted yet: an opaque black screen, never a transparent one.
  assert.deepEqual(bgra(client, 0, 0), BLACK);
  client.close();
});

test("a Raw rectangle lands at its place in the BGRA framebuffer, whatever the read sizes", async () => {
  for (const chunk of [1, 7, 4096]) {
    const { socket } = replay(fixture("raw-rect.bin"), chunk);
    const client = await connectRfb(socket);
    const update = await client.nextUpdate({ timeoutMs: 2_000 });
    assert.deepEqual(update.rects, [{ x: 100, y: 200, width: 4, height: 2 }]);
    assert.equal(update.full, false);
    assert.deepEqual(
      [0, 1, 2, 3].map((x) => bgra(client, 100 + x, 200)),
      [RED, GREEN, BLUE, WHITE],
    );
    assert.deepEqual(
      [0, 1, 2, 3].map((x) => bgra(client, 100 + x, 201)),
      [WHITE, BLUE, GREEN, RED],
    );
    assert.deepEqual(bgra(client, 99, 200), BLACK);
    assert.deepEqual(bgra(client, 104, 201), BLACK);
    client.close();
  }
});

test("a CopyRect copies pixels the client already has", async () => {
  const { socket } = replay(fixture("copy-rect.bin"));
  const client = await connectRfb(socket);
  await client.nextUpdate({ timeoutMs: 2_000 });
  const copied = await client.nextUpdate({ timeoutMs: 2_000 });
  assert.deepEqual(copied.rects, [{ x: 500, y: 300, width: 2, height: 2 }]);
  assert.deepEqual([bgra(client, 500, 300), bgra(client, 501, 300), bgra(client, 500, 301), bgra(client, 501, 301)], [RED, GREEN, BLUE, WHITE]);
  client.close();
});

test("a DesktopSize resizes the framebuffer and asks again for the whole new screen", async () => {
  const { socket, written } = replay(fixture("desktop-size.bin"));
  const client = await connectRfb(socket);
  const resized = await client.nextUpdate({ timeoutMs: 2_000 });
  assert.equal(resized.resized, true);
  assert.deepEqual([client.width, client.height], [800, 600]);
  assert.equal(client.framebuffer().data.length, 800 * 600 * 4);
  await client.nextUpdate({ timeoutMs: 2_000 });
  assert.deepEqual(bgra(client, 799, 599), GREEN);
  const requests = clientMessages(written()).messages.filter((message) => message.type === 3);
  const last = requests[requests.length - 1].body;
  assert.deepEqual([last[1], last.readUInt16BE(6), last.readUInt16BE(8)], [0, 800, 600]);
  client.close();
});

test("VNC auth with the run's password connects on RFB 3.3, 3.7 and 3.8", async () => {
  for (const version of ["3.3", "3.7", "3.8"] as const) {
    await withServer({ password: "Kq7Lm2PzX9", version, width: 32, height: 24 }, async (server, port) => {
      const client = await connectRfb(open(port), { password: "Kq7Lm2PzX9" });
      assert.equal(server.connections[0].authenticated, true, version);
      assert.deepEqual([client.width, client.height], [32, 24]);
      client.close();
    });
  }
});

test("security None connects on RFB 3.3 and 3.7 too", async () => {
  for (const version of ["3.3", "3.7"] as const) {
    await withServer({ version, width: 8, height: 8 }, async (_server, port) => {
      const client = await connectRfb(open(port));
      assert.equal(client.width, 8, version);
      client.close();
    });
  }
});

test("a wrong password is refused with the server's reason, and a missing one never reaches the server", async () => {
  await withServer({ password: "right-pass" }, async (server, port) => {
    await assert.rejects(connectRfb(open(port), { password: "wrong-pass" }), (error: unknown) => {
      assert.ok(error instanceof RfbError);
      assert.equal(error.code, "auth_failed");
      assert.match(error.message, /Authentication failed/u);
      return true;
    });
    await assert.rejects(connectRfb(open(port)), (error: unknown) => error instanceof RfbError && error.code === "security");
    assert.equal(server.connections.filter((connection) => connection.authenticated).length, 0);
  });
});

test("a server in another pixel format is asked for BGRX, and its pixels decode correctly", async () => {
  await withServer({ nativeFormat: { bigEndian: true, redShift: 0, greenShift: 8, blueShift: 16 }, width: 16, height: 16 }, async (server, port) => {
    const client = await connectRfb(open(port));
    await client.nextUpdate({ full: true, timeoutMs: 2_000 });
    assert.deepEqual(server.connections[0].setPixelFormats, [{ bigEndian: false, redShift: 16, greenShift: 8, blueShift: 0 }]);
    await client.requestUpdate(true);
    const painted = client.nextUpdate({ timeoutMs: 2_000 });
    // The incremental request is held until something changes.
    await until(() => server.connections[0].updateRequests.length === 2);
    server.paint({ x: 3, y: 4, width: 2, height: 1 }, [10, 20, 30]);
    const update = await painted;
    assert.deepEqual(update.rects, [{ x: 3, y: 4, width: 2, height: 1 }]);
    assert.deepEqual(bgra(client, 4, 4), [30, 20, 10, 255]);
    client.close();
  });
});

test("a wait for a full picture skips partial updates", async () => {
  await withServer({ width: 20, height: 10 }, async (server, port) => {
    const client = await connectRfb(open(port));
    await client.nextUpdate({ full: true, timeoutMs: 2_000 });
    let fullSeen = false;
    const full = client.nextUpdate({ full: true, timeoutMs: 2_000 }).then((update) => {
      fullSeen = true;
      return update;
    });
    await client.requestUpdate(true);
    await until(() => server.connections[0].updateRequests.length === 2);
    server.paint({ x: 0, y: 0, width: 1, height: 1 }, [1, 2, 3]);
    await client.nextUpdate({ timeoutMs: 2_000 });
    assert.equal(fullSeen, false, "one painted pixel is not the whole screen");
    await client.requestUpdate(false);
    assert.equal((await full).full, true);
    client.close();
  });
});

test("pointer and key events reach the server in order, with coordinates kept on the screen", async () => {
  await withServer({ width: 100, height: 50 }, async (server, port) => {
    const client = await connectRfb(open(port));
    await client.pointer(10, 20, 1);
    await client.pointer(150, -3, 0);
    await client.key(0xff0d, true);
    await client.key(0xff0d, false);
    await assert.rejects(client.pointer(Number.NaN, 1, 0), RangeError);
    await assert.rejects(client.key(-1, true), RangeError);
    const connection = server.connections[0];
    await until(() => connection.keys.length >= 2);
    assert.deepEqual(connection.pointer, [
      { x: 10, y: 20, buttons: 1 },
      { x: 99, y: 0, buttons: 0 },
    ]);
    assert.deepEqual(connection.keys, [
      { keysym: 0xff0d, down: true },
      { keysym: 0xff0d, down: false },
    ]);
    client.close();
  });
});

function handshakeBytes(width: number, height: number, nameLength = 0): Buffer {
  const init = Buffer.alloc(24);
  init.writeUInt16BE(width, 0);
  init.writeUInt16BE(height, 2);
  Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0]).copy(init, 4);
  init.writeUInt32BE(nameLength, 20);
  return Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 1, 0, 0, 0, 0]), init]);
}

async function refusal(bytes: Buffer, options: Parameters<typeof connectRfb>[1] = {}): Promise<RfbError> {
  const { socket } = replay(bytes);
  try {
    const client = await connectRfb(socket, options);
    return await new Promise<RfbError>((resolve) => client.onClose((error) => resolve(error!)));
  } catch (error) {
    assert.ok(error instanceof RfbError, String(error));
    return error;
  }
}

function update(...rects: Buffer[]): Buffer {
  const header = Buffer.from([0, 0, 0, 0]);
  header.writeUInt16BE(rects.length, 2);
  return Buffer.concat([header, ...rects]);
}

function rect(x: number, y: number, width: number, height: number, encoding: number, body = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(x, 0);
  header.writeUInt16BE(y, 2);
  header.writeUInt16BE(width, 4);
  header.writeUInt16BE(height, 6);
  header.writeInt32BE(encoding, 8);
  return Buffer.concat([header, body]);
}

test("malformed and oversized servers are refused before anything is allocated for them", async () => {
  const cases: [string, Buffer, string][] = [
    ["not RFB", Buffer.from("HTTP/1.1 200\n"), "malformed"],
    ["RFB 4", Buffer.from("RFB 004.000\n"), "unsupported_version"],
    ["only unknown security", Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 16])]), "security"],
    ["9000 px wide", handshakeBytes(9000, 10), "too_large"],
    ["zero size", handshakeBytes(0, 10), "too_large"],
    ["a huge name", handshakeBytes(10, 10, 10_000_000), "too_large"],
    ["a rect past the edge", Buffer.concat([handshakeBytes(10, 10), update(rect(8, 8, 4, 4, 0))]), "malformed"],
    ["a copy from past the edge", Buffer.concat([handshakeBytes(10, 10), update(rect(0, 0, 2, 2, 1, Buffer.from([0, 9, 0, 9])))]), "malformed"],
    ["an unrequested encoding", Buffer.concat([handshakeBytes(10, 10), update(rect(0, 0, 1, 1, 16))]), "malformed"],
    ["a resize to 10000 px", Buffer.concat([handshakeBytes(10, 10), update(rect(0, 0, 10_000, 10, -223))]), "too_large"],
    ["oversized clipboard", Buffer.concat([handshakeBytes(10, 10), Buffer.from([3, 0, 0, 0, 0x7f, 0, 0, 0])]), "too_large"],
    ["an unknown message", Buffer.concat([handshakeBytes(10, 10), Buffer.from([99])]), "malformed"],
  ];
  for (const [label, bytes, code] of cases) {
    const error = await refusal(bytes, { password: "unused" });
    assert.equal(error.code, code, label);
  }
});

test("a server that needs a password gets none from a client without one", async () => {
  const error = await refusal(Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 2])]));
  assert.equal(error.code, "security");
});

test("a bell and clipboard text are skipped without disturbing the picture", async () => {
  const text = Buffer.from("copied");
  const cut = Buffer.alloc(8);
  cut[0] = 3;
  cut.writeInt32BE(text.length, 4);
  const pixel = Buffer.from([0, 255, 0, 0]);
  const { socket } = replay(Buffer.concat([handshakeBytes(4, 4), Buffer.from([2]), cut, text, update(rect(1, 1, 1, 1, 0, pixel))]));
  const client = await connectRfb(socket);
  await client.nextUpdate({ timeoutMs: 2_000 });
  assert.deepEqual(bgra(client, 1, 1), GREEN);
  assert.equal(client.closed, false);
  client.close();
});

test("a handshake that stalls and a message that stops halfway both time out", async () => {
  const stalled = await refusal(Buffer.from("RFB 003.008\n"), { handshakeTimeoutMs: 50 });
  assert.equal(stalled.code, "timeout");
  const halfway = await refusal(Buffer.concat([handshakeBytes(10, 10), update(rect(0, 0, 4, 4, 0, Buffer.alloc(10)))]), {
    messageTimeoutMs: 50,
  });
  assert.equal(halfway.code, "timeout");
});

test("an idle server is not a timeout: waiting for the next message has no deadline", async () => {
  const { socket } = replay(handshakeBytes(4, 4));
  const client = await connectRfb(socket, { messageTimeoutMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(client.closed, false);
  client.close();
});

test("an abort during the handshake cancels it and closes the socket", async () => {
  const controller = new AbortController();
  const { socket } = replay(Buffer.from("RFB 003.008\n"));
  const connecting = connectRfb(socket, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(connecting, (error: unknown) => error instanceof RfbError && error.code === "cancelled");
  assert.equal(socket.destroyed, true);
});

test("closing the client ends pending waits and refuses later input", async () => {
  await withServer({}, async (_server, port) => {
    const client = await connectRfb(open(port));
    await client.nextUpdate({ full: true, timeoutMs: 2_000 });
    const waiting = client.nextUpdate();
    client.close();
    await assert.rejects(waiting, RfbError);
    await assert.rejects(client.pointer(1, 1, 0), RfbError);
    assert.equal(client.closed, true);
  });
});

test("the server going away closes the client and tells its listeners", async () => {
  await withServer({}, async (server, port) => {
    const client = await connectRfb(open(port));
    const closed = new Promise<RfbError | undefined>((resolve) => client.onClose(resolve));
    server.dropClients();
    const error = await closed;
    assert.equal(error?.code, "closed");
  });
});

test("CopyRect and DesktopSize from a live server keep the client's picture equal to the server's", async () => {
  await withServer({ width: 12, height: 8 }, async (server, port) => {
    const client = await connectRfb(open(port));
    await client.nextUpdate({ full: true, timeoutMs: 2_000 });
    const paint = async (action: () => void) => {
      const requests = server.connections[0].updateRequests.length;
      await client.requestUpdate(true);
      await until(() => server.connections[0].updateRequests.length > requests);
      const next = client.nextUpdate({ timeoutMs: 2_000 });
      action();
      return next;
    };
    await paint(() => server.paint({ x: 0, y: 0, width: 3, height: 2 }, [200, 100, 50]));
    await paint(() => server.copy({ x: 0, y: 0 }, { x: 1, y: 1, width: 3, height: 2 }));
    const same = () => {
      for (let y = 0; y < client.height; y += 1) {
        for (let x = 0; x < client.width; x += 1) {
          const [r, g, b] = server.pixel(x, y);
          assert.deepEqual(bgra(client, x, y), [b, g, r, 255], `pixel ${x},${y}`);
        }
      }
    };
    same();
    await paint(() => server.resize(6, 4));
    await client.nextUpdate({ full: true, timeoutMs: 2_000 });
    assert.deepEqual([client.width, client.height], [6, 4]);
    same();
    client.close();
  });
});
