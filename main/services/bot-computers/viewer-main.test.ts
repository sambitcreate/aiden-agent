import assert from "node:assert/strict";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import test from "node:test";

import type { BotComputerStatus } from "../../../renderer/shared/bot-computers.js";
import { createBotComputerControl } from "./control.js";
import { connectRfb } from "./rfb-client.js";
import { FakeRfbServer } from "./rfb-fake-server.js";
import { createRfbScreen, type BotComputerLiveScreen } from "./rfb-screen.js";
import type { BotComputerConnection, BotComputerStartReason } from "./types.js";
import { createBotComputerViewer, type BotComputerViewerDependencies } from "./viewer-main.js";

const BOT = "bot-ada";
const VM = "aiden-bot-0123456789abcdef";

async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function get(url: string, headers: Record<string, string> = { origin: "file://" }) {
  return new Promise<{ response: IncomingMessage; body: () => string }>((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", () => undefined);
      resolve({ response, body: () => Buffer.concat(chunks).toString() });
    });
    request.once("error", reject);
    request.end();
  });
}

async function setup() {
  const server = new FakeRfbServer({ width: 32, height: 24, password: "run-pass-1" });
  const port = await server.listen();
  const screen = await createRfbScreen({
    connect: (signal) => connectRfb(connect({ host: "127.0.0.1", port }), { password: "run-pass-1", signal }),
    encode: async (_bgra, width, height) => ({ image: Buffer.from("JPEG"), width, height }),
    frameIntervalMs: 10,
  });
  const state: { computer?: BotComputerStatus } = {
    computer: { botId: BOT, vmName: VM, state: "stopped", baseBuild: "25G83", outdated: false, controller: "bot" },
  };
  const listeners = new Set<(botId: string | undefined) => void>();
  const starts: BotComputerStartReason[] = [];
  const screens: (BotComputerStartReason | undefined)[] = [];
  const touches: string[] = [];
  const connection: BotComputerConnection = {
    vmName: VM,
    ip: "192.168.64.5",
    vnc: { host: "127.0.0.1", port, password: "run-pass-1" },
    ssh: { host: "192.168.64.5", user: "lume" },
  };
  const host: BotComputerViewerDependencies["host"] = {
    computer: async () => (state.computer ? { ...state.computer } : undefined),
    ensureRunning: async (_botId, options) => {
      starts.push(options.reason);
      if (state.computer) state.computer.state = "running";
      return connection;
    },
    touch: (botId) => void touches.push(botId),
    onChange: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  const viewer = createBotComputerViewer({
    host,
    sessions: {
      screen: async (_botId, _signal, options) => {
        screens.push(options?.reason);
        return screen;
      },
    },
    control: createBotComputerControl(),
    botName: () => "Ada",
    allowedOrigins: ["file://"],
  });
  const emit = (botId?: string) => {
    for (const listener of listeners) listener(botId);
  };
  const cleanup = async () => {
    await viewer.close();
    await (screen as BotComputerLiveScreen).close();
    await server.close();
  };
  return { viewer, state, starts, screens, touches, emit, cleanup };
}

const streamUrl = (grant: { deviceId: string; grant: { origin: string; token: string } }) =>
  `${grant.grant.origin}/vendor/serve-sim/helper/${grant.deviceId}/stream.mjpeg?t=${grant.grant.token}&host=bot-computers`;

test("opening the tab starts the computer as a viewer, and its grant streams the screen through the proxy", async () => {
  const { viewer, starts, screens, cleanup } = await setup();
  try {
    const lent = await viewer.grant(BOT, { start: true });
    assert.deepEqual(starts, ["viewer"]);
    assert.equal(lent.hostId, "bot-computers");
    assert.equal(lent.deviceId, VM);
    assert.match(lent.grant.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
    const stream = await get(streamUrl(lent));
    assert.equal(stream.response.statusCode, 200);
    await until(() => stream.body().includes("--frame\r\nContent-Type: image/jpeg"));
    assert.ok(screens.every((reason) => reason === "viewer"));
    assert.equal(viewer.viewers(BOT), 1);
    stream.response.destroy();
    await until(() => viewer.viewers(BOT) === 0);
  } finally {
    await cleanup();
  }
});

test("a tab restored at launch never starts a stopped computer", async () => {
  const { viewer, starts, cleanup } = await setup();
  try {
    await assert.rejects(viewer.grant(BOT, { start: false }), /Ada's computer isn't running/u);
    assert.deepEqual(starts, []);
  } finally {
    await cleanup();
  }
});

test("when the computer stops, its viewers end and the hub refuses to show it again without starting it", async () => {
  const { viewer, state, starts, emit, cleanup } = await setup();
  try {
    const lent = await viewer.grant(BOT, { start: true });
    const stream = await get(streamUrl(lent));
    await until(() => viewer.viewers(BOT) === 1);
    let ended = false;
    stream.response.once("close", () => {
      ended = true;
    });
    state.computer!.state = "stopped";
    emit(BOT);
    await until(() => ended);
    // The old grant still passes the proxy, but the hub never boots the VM for it.
    const again = await get(streamUrl(lent));
    assert.equal(again.response.statusCode, 503);
    again.response.destroy();
    assert.deepEqual(starts, ["viewer"]);
  } finally {
    await cleanup();
  }
});

test("a computer that was removed gets no grant, and its VM is no longer served", async () => {
  const { viewer, state, emit, cleanup } = await setup();
  try {
    const lent = await viewer.grant(BOT, { start: true });
    state.computer = undefined;
    emit(BOT);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(viewer.grant(BOT, { start: true }), /Ada's computer has been removed/u);
    const stream = await get(streamUrl(lent));
    assert.equal(stream.response.statusCode, 404);
    stream.response.destroy();
  } finally {
    await cleanup();
  }
});

test("closing the viewer stops its proxy, and later grants are refused", async () => {
  const { viewer, cleanup } = await setup();
  try {
    const lent = await viewer.grant(BOT, { start: true });
    await viewer.close();
    await assert.rejects(get(streamUrl(lent)), /ECONNREFUSED/u);
    await assert.rejects(viewer.grant(BOT, { start: true }), /quitting/u);
  } finally {
    await cleanup();
  }
});
