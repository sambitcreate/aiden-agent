import assert from "node:assert/strict";
import { connect } from "node:net";
import test from "node:test";

import { connectRfb } from "./rfb-client.js";
import { FakeRfbServer } from "./rfb-fake-server.js";
import {
  createRfbScreen,
  isLiveScreen,
  type BotComputerImageEncoder,
  type BotComputerLiveScreen,
  type RfbScreenOptions,
} from "./rfb-screen.js";
import { BotComputerTakenOverError } from "./types.js";

interface Encoded {
  bgra: Buffer;
  width: number;
  height: number;
  format: string;
  quality: number;
  maxWidth: number;
}

/** Records what it was asked to encode; the "image" names the call so results can be told apart. */
function fakeEncoder() {
  const calls: Encoded[] = [];
  const encode: BotComputerImageEncoder = async (bgra, width, height, format, quality, maxWidth) => {
    // Takes the pixels before it yields, as Electron's createFromBitmap does: the screen hands over its live framebuffer.
    calls.push({ bgra: Buffer.from(bgra), width, height, format, quality, maxWidth });
    const scale = Math.min(1, maxWidth / width);
    return { image: Buffer.from(`${format}#${calls.length}`), width: Math.round(width * scale), height: Math.round(height * scale) };
  };
  return { encode, calls };
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function setup(
  serverOptions: ConstructorParameters<typeof FakeRfbServer>[0] = {},
  frameIntervalMs = 20,
  extra: Partial<RfbScreenOptions> = {},
) {
  const server = new FakeRfbServer({ width: 40, height: 30, password: "run-pass-1", ...serverOptions });
  const port = await server.listen();
  const encoder = fakeEncoder();
  let connects = 0;
  /** Every update request the screen made, as it made it. */
  const requested: { incremental: boolean; at: number }[] = [];
  const screen = await createRfbScreen({
    connect: async (signal) => {
      connects += 1;
      const client = await connectRfb(connect({ host: "127.0.0.1", port }), { password: "run-pass-1", signal });
      const request = client.requestUpdate;
      client.requestUpdate = (incremental) => {
        requested.push({ incremental, at: performance.now() });
        return request(incremental);
      };
      return client;
    },
    encode: encoder.encode,
    frameIntervalMs,
    ...extra,
  });
  return { server, screen: screen as BotComputerLiveScreen, encoder, requested, connects: () => connects };
}

const pixelAt = (bgra: Buffer, width: number, x: number, y: number) => [...bgra.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

test("a capture asks for the whole screen, waits for it, and encodes the picture as it was taken", async () => {
  const { server, screen, encoder } = await setup();
  try {
    const first = server.connections[0].updateRequests.length;
    server.paint({ x: 5, y: 6, width: 2, height: 2 }, [250, 10, 20]);
    const shot = await screen.capture({ format: "jpeg", maxWidth: 20, quality: 70 });
    assert.ok(server.connections[0].updateRequests.slice(first).some((request) => !request.incremental), "a full request");
    assert.equal(shot.mimeType, "image/jpeg");
    assert.deepEqual([shot.width, shot.height, shot.framebufferWidth, shot.framebufferHeight], [20, 15, 40, 30]);
    assert.equal(shot.image.toString(), "jpeg#1");
    const call = encoder.calls[0];
    assert.deepEqual([call.width, call.height, call.format, call.quality, call.maxWidth], [40, 30, "jpeg", 70, 20]);
    assert.deepEqual(pixelAt(call.bgra, 40, 6, 7), [20, 10, 250, 255], "the server's painted pixel, as BGRA");
    server.paint({ x: 0, y: 0, width: 40, height: 30 }, [1, 1, 1]);
    await screen.capture({ format: "png", maxWidth: 40 });
    assert.equal(encoder.calls[1].format, "png");
    assert.deepEqual(pixelAt(encoder.calls[1].bgra, 40, 6, 7), [1, 1, 1, 255], "the next capture shows the later paint");
  } finally {
    await screen.close();
    await server.close();
  }
});

test("captures refuse bad sizes and qualities before touching the screen", async () => {
  const { server, screen, encoder } = await setup();
  try {
    await assert.rejects(screen.capture({ format: "jpeg", maxWidth: 0 }), /width/u);
    await assert.rejects(screen.capture({ format: "jpeg", maxWidth: 9000 }), /width/u);
    await assert.rejects(screen.capture({ format: "jpeg", maxWidth: 100, quality: 0 }), /quality/u);
    await assert.rejects(screen.capture({ format: "gif" as "png", maxWidth: 100 }), /PNG or JPEG/u);
    assert.equal(encoder.calls.length, 0);
  } finally {
    await screen.close();
    await server.close();
  }
});

test("a Take over that aborts a capture surfaces as the take-over, not a screen failure", async () => {
  const { server, screen } = await setup();
  try {
    const controller = new AbortController();
    controller.abort(new BotComputerTakenOverError());
    await assert.rejects(screen.capture({ format: "jpeg", maxWidth: 40, signal: controller.signal }), BotComputerTakenOverError);
    await assert.rejects(screen.pointer({ x: 1, y: 1, buttons: 1 }, controller.signal), BotComputerTakenOverError);
    await assert.rejects(screen.key({ keysym: 0x61, down: true }, controller.signal), BotComputerTakenOverError);
    assert.deepEqual(server.connections[0].pointer, []);
  } finally {
    await screen.close();
    await server.close();
  }
});

test("pointer and key events go to the server; malformed ones are refused", async () => {
  const { server, screen } = await setup();
  try {
    await screen.pointer({ x: 12, y: 9, buttons: 1 });
    await screen.pointer({ x: 12, y: 9, buttons: 0 });
    await screen.key({ keysym: 0x61, down: true });
    await screen.key({ keysym: 0x61, down: false });
    await assert.rejects(screen.pointer({ x: 1, y: 1, buttons: 256 }), /button mask/u);
    await assert.rejects(screen.key({ keysym: 1.5, down: true }), /keysym/u);
    const connection = server.connections[0];
    await until(() => connection.keys.length === 2);
    assert.deepEqual(connection.pointer, [
      { x: 12, y: 9, buttons: 1 },
      { x: 12, y: 9, buttons: 0 },
    ]);
    assert.deepEqual(connection.keys, [
      { keysym: 0x61, down: true },
      { keysym: 0x61, down: false },
    ]);
  } finally {
    await screen.close();
    await server.close();
  }
});

test("a watched screen keeps asking for changes, no faster than the frame interval, and stops when unwatched", async () => {
  const { server, screen, requested } = await setup({}, 40);
  try {
    assert.ok(isLiveScreen(screen));
    const live: BotComputerLiveScreen = screen;
    const seen: number[] = [];
    const stop = live.watch((update) => seen.push(update.version));
    const connection = server.connections[0];
    await until(() => connection.updateRequests.filter((request) => request.incremental).length >= 1);
    const before = live.version();
    for (let frame = 0; frame < 4; frame += 1) {
      // Each painted frame answers the request the screen made after the one before.
      server.paint({ x: frame, y: 0, width: 1, height: 1 }, [frame * 40, 0, 0]);
      await until(() => live.version() > before + frame);
    }
    assert.ok(seen.length >= 4);
    const asked = requested.filter((request) => request.incremental).map((request) => request.at);
    assert.ok(asked.length >= 4);
    for (let index = 1; index < asked.length; index += 1) {
      // Timers may fire a moment early; the gap is the interval, never back to back.
      const gap = Math.round(asked[index] - asked[index - 1]);
      assert.ok(gap >= 38, `request ${index} went ${gap} ms after the one before`);
    }
    stop();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const settled = connection.updateRequests.length;
    server.paint({ x: 0, y: 1, width: 1, height: 1 }, [9, 9, 9]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(connection.updateRequests.length, settled, "no new requests once nobody watches");
    const frame = await live.jpeg({ quality: 60, maxWidth: 40 });
    assert.equal(frame.width, 40);
    assert.equal(frame.version, live.version());
  } finally {
    await screen.close();
    await server.close();
  }
});

test("a dropped VNC connection is reported, and the next capture reconnects", async () => {
  const { server, screen, connects } = await setup();
  try {
    let dropped = 0;
    (screen as BotComputerLiveScreen).onDisconnect(() => {
      dropped += 1;
    });
    server.dropClients();
    await until(() => dropped === 1);
    assert.equal((screen as BotComputerLiveScreen).size(), undefined);
    const shot = await screen.capture({ format: "jpeg", maxWidth: 40 });
    assert.equal(shot.framebufferWidth, 40);
    assert.equal(connects(), 2);
    assert.equal(server.connections.length, 2);
  } finally {
    await screen.close();
    await server.close();
  }
});

test("a viewer's first frame is the whole screen, never an unpainted framebuffer", async () => {
  const { server, screen, encoder, requested } = await setup({}, 20);
  try {
    server.paint({ x: 0, y: 0, width: 40, height: 30 }, [0, 200, 0]);
    // Nothing has asked for the screen on this connection yet; the frame waits for it.
    const frame = await screen.jpeg({ quality: 70, maxWidth: 40 });
    assert.equal(frame.width, 40);
    assert.deepEqual(pixelAt(encoder.calls[0].bgra, 40, 3, 3), [0, 200, 0, 255]);
    assert.equal(requested[0]?.incremental, false);
  } finally {
    await screen.close();
    await server.close();
  }
});

test("after the screen changes size, the next frame is the repainted screen, never the blank new framebuffer", async () => {
  const { server, screen, encoder } = await setup({}, 10);
  try {
    server.paint({ x: 0, y: 0, width: 40, height: 30 }, [0, 200, 0]);
    await screen.jpeg({ quality: 70, maxWidth: 100 });
    // A viewer asks for a frame as soon as it hears of the resize, before the server has repainted.
    let frame: Promise<{ width: number; height: number }> | undefined;
    const stop = screen.watch((update) => {
      if (update.resized) frame ??= screen.jpeg({ quality: 70, maxWidth: 100 });
    });
    server.resize(50, 40);
    server.paint({ x: 0, y: 0, width: 50, height: 40 }, [0, 0, 200]);
    await until(() => frame !== undefined);
    const shot = await frame!;
    assert.deepEqual([shot.width, shot.height], [50, 40]);
    const encoded = encoder.calls[encoder.calls.length - 1];
    assert.deepEqual(pixelAt(encoded.bgra, 50, 3, 3), [200, 0, 0, 255], "the server's blue screen, not black");
    stop();
  } finally {
    await screen.close();
    await server.close();
  }
});

test("a new connection asks for the whole screen first; watching it once pictured asks only for changes", async () => {
  const { server, screen, requested } = await setup({}, 20);
  try {
    const connection = server.connections[0];
    // The connection's own first request, so a viewer never starts black.
    await until(() => connection.updateRequests.length >= 1);
    assert.equal(connection.updateRequests[0].incremental, false);
    // The handshake's picture may or may not have arrived yet; a frame waits for it.
    await screen.jpeg({ quality: 70, maxWidth: 40 });
    const watched = requested.length;
    const stop = screen.watch(() => undefined);
    // The change answers the screen's first request, and the screen asks again.
    server.paint({ x: 0, y: 0, width: 1, height: 1 }, [1, 2, 3]);
    await until(() => requested.length >= watched + 2);
    const asked = requested.slice(watched).map((request) => request.incremental);
    assert.ok(asked.every(Boolean), `a pictured screen asked ${JSON.stringify(asked)}`);
    stop();
  } finally {
    await screen.close();
    await server.close();
  }
});

test("a watched screen reconnects on its own when the VNC connection drops, and an unwatched one waits", async () => {
  const { server, screen, connects } = await setup({}, 20, { reconnectDelayMs: 10, maxReconnectDelayMs: 40 });
  try {
    const seen: number[] = [];
    const stop = screen.watch((update) => seen.push(update.version));
    // Whether or not the handshake's picture came first, this change reaches the watcher.
    server.paint({ x: 0, y: 0, width: 1, height: 1 }, [1, 1, 1]);
    await until(() => seen.length >= 1);
    server.dropClients();
    await until(() => connects() === 2 && screen.size() !== undefined);
    const after = seen.length;
    server.paint({ x: 1, y: 1, width: 1, height: 1 }, [5, 5, 5]);
    await until(() => seen.length > after);
    stop();
    server.dropClients();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(connects(), 2, "nobody watches, so nothing reconnects until the next use");
  } finally {
    await screen.close();
    await server.close();
  }
});

test("closing the screen closes its connection and refuses later use", async () => {
  const { server, screen } = await setup();
  try {
    assert.equal(screen.closed(), false);
    await screen.close();
    assert.equal(screen.closed(), true);
    await until(() => server.connections[0].socket.destroyed);
    await assert.rejects(screen.capture({ format: "jpeg", maxWidth: 40 }), /closed/u);
    assert.equal(server.connections.length, 1, "a closed screen never reconnects");
  } finally {
    await server.close();
  }
});

test("an open abandoned during the handshake leaves no connection behind", async () => {
  const server = new FakeRfbServer({ password: "run-pass-1" });
  const port = await server.listen();
  try {
    const controller = new AbortController();
    const opening = createRfbScreen(
      {
        connect: (signal) => {
          const socket = connect({ host: "127.0.0.1", port });
          // Abort before the server's banner can be answered.
          controller.abort();
          return connectRfb(socket, { password: "run-pass-1", signal });
        },
        encode: fakeEncoder().encode,
      },
      controller.signal,
    );
    await assert.rejects(opening);
    await until(() => server.connections.every((connection) => connection.socket.destroyed));
  } finally {
    await server.close();
  }
});
