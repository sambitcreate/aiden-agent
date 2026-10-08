// The phone viewers (iOS and Android) encode simulator input from the shared
// Aiden Remote fixture. Its vectors must be exactly what this desktop encoder
// sends and decodes, so the fixture is checked against the real client here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  IOS_TAG_SCREEN_CONFIG,
  createDeviceStreamClient,
  type DeviceHardwareButton,
  type DeviceStreamRuntime,
} from "./device-stream";

interface MobileInputVector {
  command: { kind: string; phase?: "begin" | "move" | "end"; x?: number; y?: number; button?: string };
  screen?: { width: number; height: number; orientation: string };
  tag: number;
  payload: Record<string, unknown>;
}

interface MobileSimulatorsFixture {
  inputMessages: MobileInputVector[];
  screenConfigs: Array<{ tag: number; payload: Record<string, unknown>; screen: Record<string, unknown> | null }>;
}

const fixture = (
  JSON.parse(
    readFileSync(new URL("../../protocol/aiden-remote/v1/fixtures/contract.json", import.meta.url), "utf8"),
  ) as { mobileSimulators: MobileSimulatorsFixture }
).mobileSimulators;

class FakeSocket {
  readyState = 0;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Uint8Array[] = [];
  send(data: Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
}

/** Starts a client whose input socket is open, after an optional screen config. */
async function connectedClient(screen?: unknown) {
  const sockets: FakeSocket[] = [];
  const screens: string[] = [];
  const runtime: DeviceStreamRuntime = {
    // The helper prime request: an already-finished MJPEG body.
    fetch: async () => new Response(new Uint8Array([1]), { status: 200 }),
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer),
  };
  const client = createDeviceStreamClient(
    {
      hostId: "local",
      deviceId: "5A0C1F3E-0000-4000-8000-000000000001",
      grant: { origin: "http://127.0.0.1:4100", token: "tok", expiresAt: Date.now() + 60_000 },
      preferMjpeg: true,
    },
    { present: () => true },
    {
      onStatus: () => undefined,
      onScreen: (value) => screens.push(`${value.width}x${value.height}:${value.orientation}`),
      onUnauthorized: () => undefined,
      onMjpegFallback: () => undefined,
      onInputConnected: () => undefined,
    },
    runtime,
  );
  client.start();
  for (let round = 0; round < 20 && sockets.length === 0; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const socket = sockets[0];
  assert.ok(socket, "the input socket opened");
  socket.readyState = 1;
  socket.onopen?.();
  const deliver = (tag: number, payload: unknown) => {
    const json = new TextEncoder().encode(JSON.stringify(payload));
    const message = new Uint8Array(json.length + 1);
    message[0] = tag;
    message.set(json, 1);
    socket.onmessage?.({ data: message.buffer });
  };
  if (screen) deliver(IOS_TAG_SCREEN_CONFIG, screen);
  return { client, socket, screens, deliver };
}

function decodePacket(bytes: Uint8Array) {
  return { tag: bytes[0], body: JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as unknown };
}

test("the shared phone input vectors are what the desktop encoder sends", async () => {
  assert.ok(fixture.inputMessages.length > 0);
  for (const vector of fixture.inputMessages) {
    const { client, socket } = await connectedClient(vector.screen);
    const label = JSON.stringify(vector);
    const { command } = vector;
    if (command.kind === "hardwareKeyboard") {
      // The client sends it on its own as soon as the socket opens.
      assert.deepEqual(decodePacket(socket.sent[0]!), { tag: vector.tag, body: vector.payload }, label);
      client.stop();
      continue;
    }
    const before = socket.sent.length;
    if (command.kind === "touch") client.sendTouch(command.phase!, command.x!, command.y!);
    else if (command.kind === "button") client.pressButton(command.button as DeviceHardwareButton);
    else if (command.kind === "rotate") client.rotate();
    else assert.fail(`unknown command ${command.kind}`);
    assert.equal(socket.sent.length, before + 1, label);
    assert.deepEqual(decodePacket(socket.sent[before]!), { tag: vector.tag, body: vector.payload }, label);
    client.stop();
  }
});

test("the shared phone screen-config vectors decode as the desktop decodes them", async () => {
  for (const vector of fixture.screenConfigs) {
    const { client, screens, deliver } = await connectedClient();
    deliver(vector.tag, vector.payload);
    const expected = vector.screen ? [`${vector.screen.width}x${vector.screen.height}:${vector.screen.orientation}`] : [];
    assert.deepEqual(screens, expected, JSON.stringify(vector.payload));
    client.stop();
  }
});
