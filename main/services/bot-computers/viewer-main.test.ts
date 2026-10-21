import assert from "node:assert/strict";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import test from "node:test";

import type { BotComputerStatus } from "../../../renderer/shared/bot-computers.js";
import { createBotComputerControl } from "./control.js";
import { connectRfb } from "./rfb-client.js";
import { FakeRfbServer } from "./rfb-fake-server.js";
import { createRfbScreenFactory } from "./rfb-screen-main.js";
import { createRfbScreen, type BotComputerLiveScreen } from "./rfb-screen.js";
import { createBotComputerSessions } from "./sessions.js";
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
      // As P8's sessions do: only a running computer's screen, never a start.
      runningScreen: async () => {
        if (state.computer?.state !== "running") throw new Error("The computer isn't running.");
        screens.push("viewer");
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

test("as main wires them, the Bot's screen and the viewer share one VNC connection per run, and a new run opens a new one", async () => {
  // Main's composition: P8's sessions with the RFB screen factory, and the viewer reading screens through them.
  const servers = [new FakeRfbServer({ width: 32, height: 24, password: "run-pass-1" }), new FakeRfbServer({ width: 32, height: 24, password: "run-pass-2" })];
  const ports = await Promise.all(servers.map((server) => server.listen()));
  let run = 0;
  const connection = (): BotComputerConnection => ({
    vmName: VM,
    ip: "192.168.64.5",
    vnc: { host: "127.0.0.1", port: ports[run], password: `run-pass-${run + 1}` },
    ssh: { host: "192.168.64.5", user: "lume" },
  });
  const state: { computer: BotComputerStatus } = {
    computer: { botId: BOT, vmName: VM, state: "stopped", baseBuild: "25G83", outdated: false, controller: "bot" },
  };
  const listeners = new Set<(botId: string | undefined) => void>();
  const host = {
    computer: async () => ({ ...state.computer }),
    runningConnection: () => (state.computer.state === "running" ? connection() : undefined),
    ensureRunning: async () => {
      state.computer.state = "running";
      return connection();
    },
    touch: () => undefined,
    onChange: (listener: (botId: string | undefined) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  const emit = () => {
    for (const listener of listeners) listener(BOT);
  };
  const control = createBotComputerControl();
  const sessions = createBotComputerSessions({ host, control });
  sessions.setScreenFactory(createRfbScreenFactory({ encode: async (_bgra, width, height) => ({ image: Buffer.from("JPEG"), width, height }) }));
  const viewer = createBotComputerViewer({ host, sessions, control, botName: () => "Ada", allowedOrigins: ["file://"] });
  try {
    const lent = await viewer.grant(BOT, { start: true });
    const stream = await get(streamUrl(lent));
    assert.equal(stream.response.statusCode, 200);
    await until(() => stream.body().includes("--frame\r\nContent-Type: image/jpeg"));
    // The Bot's capture rides the connection the viewer opened.
    const botScreen = await sessions.screen(BOT, undefined, { reason: "tool" });
    const shot = await botScreen.capture({ format: "jpeg", maxWidth: 32 });
    assert.deepEqual([shot.framebufferWidth, shot.framebufferHeight], [32, 24]);
    assert.equal(servers[0].connections.length, 1, "one VNC connection for the Bot and the viewer");
    assert.equal(servers[0].connections[0].authenticated, true, "signed in with the run's password");

    // The run ends: its screen closes, and the viewer's stream with it.
    let ended = false;
    stream.response.once("close", () => {
      ended = true;
    });
    state.computer.state = "stopped";
    emit();
    await until(() => ended);
    await until(() => (botScreen as BotComputerLiveScreen).closed());

    // The next run has a new port and password; both sides move to it together.
    run = 1;
    const next = await viewer.grant(BOT, { start: true });
    const again = await get(streamUrl(next));
    assert.equal(again.response.statusCode, 200);
    await until(() => again.body().includes("--frame\r\nContent-Type: image/jpeg"));
    const nextScreen = await sessions.screen(BOT, undefined, { reason: "tool" });
    assert.notEqual(nextScreen, botScreen);
    await nextScreen.capture({ format: "jpeg", maxWidth: 32 });
    assert.equal(servers[1].connections.length, 1);
    assert.equal(servers[0].connections.length, 1, "the old run's server is never dialled again");
    again.response.destroy();
  } finally {
    await viewer.close();
    await Promise.all(servers.map((server) => server.close()));
  }
});

test("a computer that stopped after a status read said it was running is never started again for the viewer", async () => {
  // Main's composition again: the hub reads the screen through P8's sessions.
  const server = new FakeRfbServer({ width: 32, height: 24, password: "run-pass-1" });
  const port = await server.listen();
  const connection: BotComputerConnection = {
    vmName: VM,
    ip: "192.168.64.5",
    vnc: { host: "127.0.0.1", port, password: "run-pass-1" },
    ssh: { host: "192.168.64.5", user: "lume" },
  };
  let running = true;
  const starts: BotComputerStartReason[] = [];
  const host = {
    // A status read from just before the stop (Pause, the idle timer) landed: it still says running.
    computer: async (): Promise<BotComputerStatus> => ({ botId: BOT, vmName: VM, state: "running", baseBuild: "25G83", outdated: false, controller: "bot" }),
    runningConnection: () => (running ? connection : undefined),
    ensureRunning: async (_botId: string, options: { reason: BotComputerStartReason }) => {
      starts.push(options.reason);
      running = true;
      return connection;
    },
    touch: () => undefined,
    onChange: () => () => undefined,
  };
  const control = createBotComputerControl();
  const sessions = createBotComputerSessions({ host, control });
  sessions.setScreenFactory(createRfbScreenFactory({ encode: async (_bgra, width, height) => ({ image: Buffer.from("JPEG"), width, height }) }));
  const viewer = createBotComputerViewer({ host, sessions, control, botName: () => "Ada", allowedOrigins: ["file://"] });
  try {
    const lent = await viewer.grant(BOT, { start: false });
    running = false;
    const stream = await get(streamUrl(lent));
    assert.equal(stream.response.statusCode, 503, "the stopped computer isn't shown");
    stream.response.destroy();
    assert.deepEqual(starts, [], "and the viewer never boots it");
    assert.equal(server.connections.length, 0);
  } finally {
    await viewer.close();
    await server.close();
  }
});

test("Settings sees the base computer only while setup waits for the person, and its view ends with that step", async () => {
  const server = new FakeRfbServer({ width: 32, height: 24, password: "base-pass" });
  const port = await server.listen();
  const base: BotComputerConnection = {
    vmName: "aiden-base",
    ip: "192.168.64.9",
    vnc: { host: "127.0.0.1", port, password: "base-pass" },
    ssh: { host: "192.168.64.9", user: "lume" },
  };
  let waiting: BotComputerConnection | undefined;
  const listeners = new Set<(botId: string | undefined) => void>();
  const opened: string[] = [];
  const viewer = createBotComputerViewer({
    host: {
      computer: async () => undefined,
      ensureRunning: async () => assert.fail("the base view never starts a Bot's computer"),
      touch: () => assert.fail("the base has no idle timer to restart"),
      onChange: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      baseView: () => waiting,
    },
    sessions: { runningScreen: async () => assert.fail("the base is not a Bot's computer") },
    control: createBotComputerControl(),
    baseScreen: createRfbScreenFactory({
      encode: async (_bgra, width, height) => {
        return { image: Buffer.from("JPEG"), width, height };
      },
    }),
    allowedOrigins: ["file://"],
  });
  try {
    await assert.rejects(viewer.grantBase(), /isn't waiting for you/u);
    waiting = base;
    const lent = await viewer.grantBase();
    opened.push(lent.deviceId);
    assert.equal(lent.deviceId, "aiden-base");
    const stream = await get(streamUrl(lent));
    assert.equal(stream.response.statusCode, 200);
    await until(() => stream.body().includes("--frame\r\nContent-Type: image/jpeg"));

    // The grants are in (or skipped): the view closes and isn't lent again.
    waiting = undefined;
    for (const listener of listeners) listener(undefined);
    await until(() => stream.response.readableEnded || stream.response.destroyed || stream.response.complete);
    await assert.rejects(viewer.grantBase(), /isn't waiting for you/u);
  } finally {
    await viewer.close();
    await server.close();
  }
});
